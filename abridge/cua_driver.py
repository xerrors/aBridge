"""The fixed, in-process Cua SDK boundary used by the macOS device client."""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import importlib
import inspect
import json
import math
import os
import plistlib
import re
import sys
import threading
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, fields, is_dataclass
from enum import Enum
from importlib import metadata
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from abridge.protocol import OBSERVATION_SECONDS

CUA_VERSION = "0.46.1+abridge.1"
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_TEXT_CHARS = 131_072
MAX_ELEMENTS = 500
_BROWSER_REF = re.compile(r"p[0-9]+:[0-9]+\Z")
_AX_REF = re.compile(r"s[0-9a-f]{8}:[0-9]+\Z")
_RUNTIME_SCOPE = re.compile(r"__cua_runtime_[0-9a-f]{32}:\Z")
_BROWSER_TOOLS = {"browser_prepare", "get_browser_state", "browser_navigate", "browser_click", "browser_type"}
OWNER_BROWSER_TTL_SECONDS = 8 * 60 * 60
OWNER_BROWSER_IDLE_SECONDS = 30 * 60
_SDK_LOOP_LOCK = threading.Lock()
_SDK_RUNTIME_LOOP: asyncio.AbstractEventLoop | None = None
_SDK_RUNTIME_USERS = 0


class CuaError(Exception):
    """A dependency failure, explicit refusal, or uncertain driver outcome."""

    def __init__(self, code: str, message: str, *, local_reason: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self._local_reason = local_reason


@dataclass(frozen=True)
class BrowserProfile:
    """A trusted local selection; never accept these fields from an Agent."""

    mode: Literal["isolated", "existing_profile"] = "existing_profile"
    pid: int | None = None
    window_id: int | None = None
    fingerprint: str | None = None
    approved: bool = False


@dataclass(frozen=True)
class AuthorizationRequest:
    """Owner-local data; never include this object in an Agent tool result."""

    session_id: str
    request_digest: str
    summary: str
    resource: dict[str, Any]
    expires_unix_ms: int
    adapter_id: str


AuthorizationHandler = Callable[[AuthorizationRequest], Awaitable[bool]]


class CuaDriverAdapter:
    """Own SDK sessions and expose bounded desktop/browser operations.

    ``sdk`` and ``driver`` permit deterministic tests without importing a native
    library. Production loads exactly CUA_VERSION on macOS, only when requested.
    """

    def __init__(
        self,
        authorizer: AuthorizationHandler | None = None,
        *,
        browser_profile: BrowserProfile | None = None,
        sdk: Any | None = None,
        driver: Any | None = None,
    ) -> None:
        self._authorizer = authorizer
        self._browser_profile = browser_profile or BrowserProfile()
        _validate_browser_profile(self._browser_profile)
        self._browser_selection_lock = asyncio.Lock()
        self._existing_browser_session: str | None = None
        self._browser_configuring = False
        self._last_browser_error: dict[str, Any] | None = None
        self._last_browser_authorization: dict[str, Any] | None = None
        self._owner_browser: _OwnerBrowser | None = None
        self._owner_expired = False
        self._preparing_browser_session: str | None = None
        self._sdk = sdk
        self._driver = driver
        self._authorization_host: Any | None = None
        self._sessions: dict[str, _Session] = {}
        self._active: dict[asyncio.Task[Any], str] = {}
        self._closed = False
        self._stopping = False
        self._event_loop: asyncio.AbstractEventLoop | None = None
        self._event_loop_registered = False

    async def diagnostics(self) -> dict[str, Any]:
        """Inspect dependencies and TCC without launching a browser or prompting."""
        browser = _chrome_dependency()
        selection = await self._browser_selection_status()
        owner = self._owner_browser
        if owner is not None and (not selection["selection_ready"] or owner.profile != self._browser_profile):
            # Capability filtering can block the next action entirely. Release
            # stale authority here, outside the selection lock, rather than
            # relying on an execution guard that may never run.
            await self._close_owner_browser()
            selection = await self._browser_selection_status()
        try:
            installed_version = (
                self._sdk.__version__ if self._sdk is not None else metadata.version("cua-driver")
            )
        except metadata.PackageNotFoundError:
            installed_version = None
        result: dict[str, Any] = {
            "driver": {
                "installed": installed_version is not None,
                "version": installed_version,
                "expected_version": CUA_VERSION,
                "loaded": False,
                "ready": False,
                "error": None,
            },
            "permissions": {"screen": False, "input": False, "checked": False},
            "browser": {
                **browser,
                "ready": False,
                **selection,
                "active_sessions": sum(
                    session.browser is not None and not session.closed and not session.local_browser_owner
                    for session in self._sessions.values()
                ),
                "session_ttl_seconds": OWNER_BROWSER_TTL_SECONDS,
                "idle_ttl_seconds": OWNER_BROWSER_IDLE_SECONDS,
            },
        }
        try:
            sdk = self._load_sdk()
            result["driver"].update(installed=True, version=sdk.__version__)
            driver = self._ensure_driver()
            try:
                permission = sdk.current_mac_os_permission_status()
            except Exception as error:
                raise CuaError(
                    "cua_permission_probe_failed", "Cua could not inspect this process's macOS permissions"
                ) from error
            result["permissions"] = {
                "screen": permission.screen_recording is True,
                "input": permission.accessibility is True,
                "checked": True,
            }
            result["driver"].update(loaded=True, ready=bool(driver.is_available()), execution_mode="embedded")
            result["browser"]["ready"] = (
                browser["installed"]
                and result["driver"]["ready"]
                and selection["selection_ready"]
                and (selection["mode"] == "isolated" or selection["owner_ready"])
            )
        except CuaError as error:
            result["driver"]["error"] = {"code": error.code, "message": str(error)}
        return result

    async def browser_targets(self) -> list[dict[str, Any]]:
        """List Chrome window metadata for the owner's local selector only."""
        return await self._chrome_targets("local-browser-selection")

    def browser_diagnostics(self) -> dict[str, Any]:
        """Owner-only troubleshooting; deliberately absent from remote diagnostics."""
        owner = self._owner_browser
        now = time.monotonic()
        prepared = owner is not None and not owner.tainted and not owner.session.closed
        if prepared:
            prepared = (
                now < owner.created_at + OWNER_BROWSER_TTL_SECONDS
                and now < owner.last_activity + OWNER_BROWSER_IDLE_SECONDS
            )
        return {
            "last_error": dict(self._last_browser_error) if self._last_browser_error else None,
            "authorization": copy.deepcopy(self._last_browser_authorization),
            "prepared": prepared,
            "session_ttl_seconds": OWNER_BROWSER_TTL_SECONDS,
            "idle_ttl_seconds": OWNER_BROWSER_IDLE_SECONDS,
            "expires_in": max(0, math.ceil(owner.created_at + OWNER_BROWSER_TTL_SECONDS - now))
            if owner
            else 0,
            "idle_expires_in": max(0, math.ceil(owner.last_activity + OWNER_BROWSER_IDLE_SECONDS - now))
            if owner
            else 0,
        }

    async def configure_browser(self, profile: BrowserProfile) -> None:
        """Replace a local selection after releasing affected browser sessions."""
        _validate_browser_profile(profile)
        if profile == self._browser_profile:
            return
        self._browser_configuring = True
        try:
            for session in list(self._sessions.values()):
                if session.browser_mode is not None and not session.closed:
                    await self.close_session(session.id)
            self._browser_profile = profile
        finally:
            self._browser_configuring = False

    async def prepare_browser(self) -> dict[str, Any]:
        """Prepare the one bounded owner context; remote calls cannot run this."""
        if self._stopping or self._closed:
            raise CuaError("driver_stopping", "The Cua runtime is stopping or closed")
        if self._browser_profile.mode != "existing_profile":
            raise CuaError("browser_consent_required", "Select an existing Chrome window before preparing it")
        try:
            await self._require_browser_selection()
        except CuaError:
            # This entry point has not acquired the selection lock yet. End an
            # invalid owner here rather than recursively locking in the probe.
            await self._close_owner_browser()
            raise
        if self._owner_browser is not None:
            await self._require_owner_browser("local-browser-prepare")
            return {"prepared": True, "already_prepared": True, **self.browser_diagnostics()}
        self._ensure_driver()
        owner_session_id = "owner-browser-" + uuid.uuid4().hex
        session = _Session(
            owner_session_id, owner_session_id, browser_mode="existing_profile", local_browser_owner=True
        )
        self._sessions[owner_session_id] = session
        retained = False
        try:
            async with session.lock:
                async with self._browser_selection_lock:
                    if (
                        self._existing_browser_session is not None
                        or self._preparing_browser_session is not None
                    ):
                        raise CuaError("browser_in_use", "The approved browser is already in use")
                    profile = await self._approved_existing_profile(session.id)
                    self._preparing_browser_session = session.id
                    owner_created_at = time.monotonic()
                    session.sdk_handle = self._sdk.create_trusted_session(
                        self._driver,
                        self._sdk.TrustedSessionOptions(
                            public_session=session.name,
                            mode=self._sdk.SessionPermissionMode.STANDARD,
                            ttl_seconds=OWNER_BROWSER_TTL_SECONDS,
                            idle_ttl_seconds=OWNER_BROWSER_IDLE_SECONDS,
                            bounded_manifest_path=None,
                        ),
                    )
                    await self._invoke(
                        session.id,
                        session.sdk_handle.start_session(
                            self._sdk.StartSessionInput(
                                session=session.name,
                                capture_scope=None,
                                cursor_theme=None,
                                cursor_motion=None,
                            )
                        ),
                    )
                    session.started = True
                    prepared = await self._generic(
                        session.id,
                        "browser_prepare",
                        {
                            "session": session.name,
                            "pid": profile.pid,
                            "window_id": profile.window_id,
                            "strategy": {"kind": "existing_profile"},
                            "delivery_mode": "foreground",
                        },
                        timeout=120,
                    )
                    binding = await self._generic(
                        session.id,
                        "get_browser_state",
                        {"session": session.name, "pid": profile.pid, "window_id": profile.window_id},
                    )
                    session.browser = _browser_binding(binding, existing_profile=True)
                    now = time.monotonic()
                    owner = _OwnerBrowser(session, profile, owner_created_at, now)
                    self._owner_browser = owner
                    self._owner_expired = False
                    owner.expiry_task = asyncio.create_task(self._expire_owner_browser(owner))
                    retained = True
        finally:
            if self._preparing_browser_session == session.id:
                self._preparing_browser_session = None
            if not retained:
                await self._end_session(session)
                self._sessions.pop(session.id, None)
        self._last_browser_error = None
        effects = prepared.get("side_effects") or {}
        return {
            "prepared": True,
            "mode": "existing_profile",
            "delivery_mode": "foreground",
            "detached": False,
            "session_ttl_seconds": OWNER_BROWSER_TTL_SECONDS,
            "idle_ttl_seconds": OWNER_BROWSER_IDLE_SECONDS,
            "side_effects": {key: value for key, value in effects.items() if isinstance(value, bool)},
        }

    async def list_apps(self, session_id: str, query: str | None = None) -> dict[str, Any]:
        if query is not None and not isinstance(query, str):
            raise CuaError("invalid_arguments", "query must be text or null")
        await self._session(session_id)
        result = await self._invoke(session_id, self._driver.list_apps(self._sdk.ListAppsInput()))
        apps = result.apps
        if query:
            needle = query.casefold()
            apps = [
                app
                for app in apps
                if needle in app.name.casefold() or needle in (app.bundle_id or "").casefold()
            ]
        return {"apps": [_project(app) for app in apps]}

    async def list_windows(self, session_id: str, pid: int | None = None) -> dict[str, Any]:
        """List SDK windows; process_running checks PID existence, not app identity."""
        if pid is not None:
            _positive_integer(pid, "pid")
        await self._session(session_id)
        result = await self._invoke(
            session_id,
            self._driver.list_windows(self._sdk.ListWindowsInput(pid=pid, on_screen_only=False)),
        )
        windows = _project(result.windows)
        process_running = None
        if pid is not None:
            # Signal zero checks process existence without sending an input or
            # inspecting app content. An empty SDK result alone proves neither
            # process exit nor a Space/permission failure.
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                process_running = False
            except PermissionError:
                process_running = True
            else:
                process_running = True
        response = {
            "windows": windows,
            "current_space_id": result.current_space_id,
            "requested_pid": pid,
            "process_running": process_running,
            "on_screen_only": False,
            "empty_reason": None,
        }
        if not windows:
            response["empty_reason"] = (
                "process_not_running" if process_running is False else "no_windows_reported"
            )
            response["guidance"] = (
                "Refresh computer_apps and computer_windows, then call computer_observe with a returned "
                "pid and window_id. Off-screen windows are included when reported by the SDK."
            )
        return response

    async def computer_observe(
        self,
        session_id: str,
        pid: int | None = None,
        window_id: int | None = None,
        screenshot: bool = True,
    ) -> dict[str, Any]:
        if (pid is None) != (window_id is None):
            raise CuaError("invalid_arguments", "pid and window_id must be supplied together")
        if pid is not None:
            _positive_integer(pid, "pid")
            _positive_integer(window_id, "window_id")
        session = await self._session(session_id)
        async with session.lock:
            self._require_live_session(session)
            session.observation = None
            focus = None
            if pid is None:
                focus = await self._desktop_focus(session_id)
                native = await self._invoke(
                    session_id,
                    self._driver.get_desktop_state(
                        self._sdk.GetDesktopStateInput(
                            session=session.name, screenshot_out_file=None, max_image_dimension=1920
                        )
                    ),
                )
                result = _tool_result(native, include_images=screenshot)
                if await self._desktop_focus(session_id) != focus:
                    raise CuaError(
                        "focus_changed", "The foreground window changed during capture; observe again"
                    )
                result["window"] = {"pid": focus[0], "window_id": focus[1], "title": focus[2]}
                target = {"kind": "desktop", "display_id": "primary"}
                refs: set[str] = set()
            else:
                native = await self._invoke(
                    session_id,
                    self._driver.get_window_state(
                        self._sdk.GetWindowStateInput(
                            pid=pid,
                            window_id=window_id,
                            session=session.name,
                            query=None,
                            include_accessibility_tree=True,
                            include_screenshot=screenshot,
                            screenshot_out_file=None,
                            max_elements=MAX_ELEMENTS,
                            max_depth=12,
                            max_dimension=None,
                            max_image_dimension=1920,
                            timeout_ms=10_000,
                            tree_format="elements",
                        )
                    ),
                )
                result = _project(native)
                result.pop("images", None)
                for element in result.get("elements") or []:
                    if element.get("element_token"):
                        element["element_ref"] = element["element_token"]
                if screenshot:
                    _add_image(result, native.images)
                target = {"kind": "window", "pid": pid, "window_id": window_id}
                refs = {
                    element.element_token
                    for element in (native.elements or [])
                    if element.element_token is not None
                }
            result["coordinate_space"] = "screenshot_pixels"
            result["geometry"] = {
                key: result[key]
                for key in (
                    "width",
                    "height",
                    "screenshot_width",
                    "screenshot_height",
                    "screenshot_scale",
                    "window_bounds",
                )
                if key in result
            }
            result["target"] = target
            return self._observation(session, "computer", target, refs, result, focus=focus)

    async def computer_act(
        self, session_id: str, observation_id: str, action: dict[str, Any]
    ) -> dict[str, Any]:
        session = self._existing_session(session_id)
        async with session.lock:
            observation = self._take_observation(session, observation_id, "computer")
            tool, arguments = _computer_action(action, observation)
            if observation.focus is not None and await self._desktop_focus(session_id) != observation.focus:
                raise CuaError("focus_changed", "The foreground window changed; observe again before acting")
            arguments.update(session=session.name, target=observation.target)
            if observation.capture_id is not None and tool == "click":
                arguments["capture_id"] = observation.capture_id
            result = await self._generic(session_id, tool, arguments)
            result["business_verified"] = False
            return result

    async def browser_open(self, session_id: str, url: str) -> dict[str, Any]:
        _http_url(url)
        if self._browser_profile.mode == "existing_profile":
            await self._require_owner_browser(session_id)
            if not isinstance(session_id, str) or not session_id or len(session_id) > 128:
                raise CuaError("invalid_arguments", "A valid aBridge session_id is required")
            session = self._sessions.get(session_id)
            if session is None:
                session = _Session(
                    session_id, "abridge-" + hashlib.sha256(session_id.encode()).hexdigest()[:24]
                )
                self._sessions[session_id] = session
        else:
            session = await self._session(session_id)
        async with session.lock:
            self._require_live_session(session)
            if self._browser_configuring:
                raise CuaError("browser_selection_changing", "The owner is changing the browser selection")
            session.observation = None
            if session.browser is None:
                session.browser_mode = self._browser_profile.mode
                try:
                    if session.browser_mode == "existing_profile":
                        session.browser = await self._prepare_existing_browser(session)
                    else:
                        session.browser = await self._prepare_isolated_browser(session)
                except BaseException:
                    # The SDK ends owned isolated processes, but detaches an
                    # existing profile without closing its browser or user tabs.
                    await self._end_session(session)
                    raise
            if session.requested_url != url:
                await self._generic(
                    session_id,
                    "browser_navigate",
                    {"session": session.name, **session.browser, "url": url},
                )
                session.requested_url = url
            observed = await self._browser_observe(session, screenshot=False)
            self._last_browser_error = None
            return observed

    async def browser_observe(self, session_id: str, screenshot: bool = False) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None or session.browser is None or session.closed or session.closing:
            raise CuaError("browser_not_open", "Open an aBridge browser before observing it")
        if session.borrowed_browser:
            await self._require_owner_browser(session_id)
        async with session.lock:
            return await self._browser_observe(session, screenshot)

    async def browser_act(
        self, session_id: str, observation_id: str, action: dict[str, Any]
    ) -> dict[str, Any]:
        session = self._existing_session(session_id)
        if session.borrowed_browser:
            await self._require_owner_browser(session_id)
        async with session.lock:
            observation = self._take_observation(session, observation_id, "browser")
            if not isinstance(action, dict):
                raise CuaError("invalid_arguments", "action must be an object")
            kind = action.get("type")
            if not isinstance(kind, str) or kind not in {"click", "fill"}:
                raise CuaError("invalid_arguments", "Browser actions support click and fill")
            ref = action.get("element_ref")
            if not isinstance(ref, str) or ref not in observation.refs:
                raise CuaError("stale_element", "Use an element_ref from this observation")
            arguments = {"session": session.name, **observation.target, "ref": ref}
            if kind == "fill":
                arguments.update(
                    text=_text(action, "text", allow_empty=True), replace=True, mode="insert_text"
                )
            else:
                # A DOM click is explicit from its first dispatch, never a
                # silent downgrade after a trusted input attempt.
                arguments["input_route"] = "dom_event"
            result = await self._generic(
                session_id, "browser_click" if kind == "click" else "browser_type", arguments
            )
            result["business_verified"] = False
            if kind == "click":
                result.setdefault("input_route", "dom_event")
                result.setdefault("synthetic", True)
            return result

    async def close_session(self, session_id: str) -> dict[str, Any]:
        if self._owner_browser is not None and self._owner_browser.session.id == session_id:
            await self._close_owner_browser()
            return {"closed": True}
        session = self._sessions.get(session_id)
        if session is None or session.closed:
            return {"closed": True}
        session.closing = True
        await self._cancel_tasks(session_id)
        async with session.lock:
            if not session.closed:
                await self._end_session(session)
        if self._owner_browser is not None and self._owner_browser.tainted:
            await self._close_owner_browser()
        return {"closed": True}

    async def release_remote_sessions(self) -> None:
        """Release callers after disconnect; keep only an idle, clean owner."""
        owner = self._owner_browser
        local_ids = {"local-browser-selection", "local-browser-prepare", self._preparing_browser_session}
        local_ids.update(session.id for session in self._sessions.values() if session.local_browser_owner)
        if owner is not None:
            local_ids.add(owner.session.id)
        remote_ids = set(self._sessions) | set(self._active.values())
        for session_id in remote_ids - local_ids:
            await self._cancel_tasks(session_id)
        for session_id in list(self._sessions):
            if session_id not in local_ids:
                await self.close_session(session_id)
        if self._owner_browser is not None and self._owner_browser.tainted:
            await self._close_owner_browser()

    async def stop_browser(self) -> None:
        """Stop browser preparation and borrowers without touching other desktop contexts."""
        preparing = self._preparing_browser_session
        if preparing is not None:
            await self._cancel_tasks(preparing)
        owner = self._owner_browser
        for session in list(self._sessions.values()):
            if session.browser_mode is not None and (owner is None or session is not owner.session):
                await self.close_session(session.id)
        await self._close_owner_browser()

    async def stop(self) -> dict[str, Any]:
        self._stopping = True
        errors = []
        try:
            await self._cancel_tasks()
            for session_id in list(self._sessions):
                try:
                    await self.close_session(session_id)
                except CuaError as error:
                    errors.append({"session_id": session_id, "code": error.code, "message": str(error)})
        finally:
            self._stopping = False
        if errors:
            raise CuaError("cleanup_failed", "Some Cua sessions could not be confirmed closed")
        return {"closed": True}

    async def shutdown(self) -> None:
        self._check_event_loop()
        try:
            await self.stop()
        finally:
            self._closed = True
            if self._driver is not None:
                try:
                    await asyncio.wait_for(self._driver.shutdown(), timeout=10)
                except Exception as error:
                    raise CuaError("cleanup_failed", "Cua runtime shutdown could not be confirmed") from error
                finally:
                    self._driver = None
                    self._release_event_loop()

    def _load_sdk(self) -> Any:
        if self._sdk is not None:
            if self._sdk.__version__ != CUA_VERSION:
                raise CuaError("cua_version_mismatch", f"Install cua-driver=={CUA_VERSION}")
            return self._sdk
        if sys.platform != "darwin":
            raise CuaError("cua_platform_unsupported", "The embedded driver is enabled only on macOS")
        try:
            installed = metadata.version("cua-driver")
        except metadata.PackageNotFoundError as error:
            raise CuaError(
                "cua_not_installed", f"Install the macOS cua-driver=={CUA_VERSION} dependency"
            ) from error
        if installed != CUA_VERSION:
            raise CuaError("cua_version_mismatch", f"Install cua-driver=={CUA_VERSION}; found {installed}")
        try:
            self._sdk = importlib.import_module("cua_driver")
        except (ImportError, OSError, RuntimeError) as error:
            raise CuaError(
                "cua_load_failed", "The fixed Cua native library could not load on this Mac"
            ) from error
        if self._sdk.__version__ != CUA_VERSION:
            raise CuaError("cua_version_mismatch", f"The imported SDK must be cua-driver=={CUA_VERSION}")
        return self._sdk

    def _ensure_driver(self) -> Any:
        self._check_event_loop()
        if self._closed:
            raise CuaError("driver_closed", "The Cua runtime was shut down")
        sdk = self._load_sdk()
        if self._driver is None:
            self._bind_event_loop()
            owner = self

            class AuthorizationHost(sdk.DriverAuthorizationHost):
                async def authorize(self, request: Any) -> Any:
                    allowed = await owner._authorize_existing_profile(request)
                    return sdk.DriverAuthorizationDecision(
                        action=sdk.DriverAuthorizationAction.ALLOW
                        if allowed
                        else sdk.DriverAuthorizationAction.DENY,
                        request_digest=request.request_digest,
                    )

            self._authorization_host = AuthorizationHost()
            options = sdk.ConfiguredDriverOptions(
                claude_code_compatibility=False,
                authorization=sdk.RuntimeAuthorizationOptions(
                    allowed_modes=[sdk.SessionPermissionMode.STANDARD],
                    compatibility_mode=sdk.SessionPermissionMode.STANDARD,
                    compatibility_bounded_manifest_path=None,
                    unrestricted_acknowledged=False,
                    max_session_ttl_seconds=OWNER_BROWSER_TTL_SECONDS,
                    max_idle_ttl_seconds=OWNER_BROWSER_IDLE_SECONDS,
                ),
            )
            try:
                self._driver = sdk.CuaDriver.create_configured_with_authorization_host(
                    options, self._authorization_host
                )
            except Exception as error:
                self._release_event_loop()
                raise CuaError("cua_load_failed", "The embedded Cua runtime could not initialize") from error
        mode = self._driver.execution_mode()
        if mode != sdk.DriverExecutionMode.EMBEDDED or self._driver.socket_path():
            raise CuaError("cua_mode_mismatch", "aBridge requires an in-process Cua runtime")
        return self._driver

    def _bind_event_loop(self) -> None:
        global _SDK_RUNTIME_LOOP, _SDK_RUNTIME_USERS
        try:
            # UniFFI documents this public setter outside __all__. The pinned
            # 0.46.1 wheel keeps it in its generated binding, not the package API.
            # https://mozilla.github.io/uniffi-rs/latest/futures.html
            from cua_driver._native import uniffi_set_event_loop

            loop = asyncio.get_running_loop()
        except (ImportError, RuntimeError) as error:
            raise CuaError(
                "cua_event_loop_unavailable", "Cua requires the client's running event loop"
            ) from error
        with _SDK_LOOP_LOCK:
            if _SDK_RUNTIME_USERS and _SDK_RUNTIME_LOOP is not loop:
                raise CuaError("cua_event_loop_mismatch", "Active Cua runtimes must share one event loop")
            uniffi_set_event_loop(loop)
            _SDK_RUNTIME_LOOP = loop
            _SDK_RUNTIME_USERS += 1
            self._event_loop = loop
            self._event_loop_registered = True

    def _check_event_loop(self) -> None:
        if self._event_loop is None:
            return
        if self._event_loop is not asyncio.get_running_loop():
            raise CuaError("cua_event_loop_mismatch", "Use this Cua runtime on its original event loop")

    def _release_event_loop(self) -> None:
        global _SDK_RUNTIME_LOOP, _SDK_RUNTIME_USERS
        with _SDK_LOOP_LOCK:
            if self._event_loop_registered:
                _SDK_RUNTIME_USERS -= 1
                self._event_loop_registered = False
                if not _SDK_RUNTIME_USERS:
                    _SDK_RUNTIME_LOOP = None
        # Leave the SDK's public setting intact until its runtime has shut down.
        # A later runtime binds its own running loop; no private globals or
        # undocumented setter(None) reset are used.

    async def _authorize_existing_profile(self, request: Any) -> bool:
        # Only fixed comparisons are retained for owner-local diagnostics. Never
        # retain resource JSON, request digests, session tokens or profile paths.
        # Embedded Cua namespaces public labels. Derive the exact identity
        # from this trusted driver, never from a request prefix or suffix.
        prefix = self._driver.runtime_scope_prefix() if self._driver is not None else None
        scope_valid = isinstance(prefix, str) and _RUNTIME_SCOPE.fullmatch(prefix) is not None
        session = next(
            (
                entry
                for entry in self._sessions.values()
                if scope_valid and prefix + entry.name == request.public_session
            ),
            None,
        )
        preparing = self._sessions.get(self._preparing_browser_session)
        checks = {
            "runtime_scope_valid": scope_valid,
            "session_found": session is not None,
            "session_open": session is not None and not session.closed,
            "session_not_closing": session is not None and not session.closing,
            "runtime_running": not self._stopping and not self._closed,
            "configuration_stable": not self._browser_configuring,
            "existing_profile_session": session is not None and session.browser_mode == "existing_profile",
            "preparing_session_matches": session is not None
            and self._preparing_browser_session == session.id,
            "operation_supported": request.adapter_id == "browser_prepare.existing_profile",
            "permission_mode_supported": request.permission_mode == "standard",
            "digest_present": isinstance(request.request_digest, str) and bool(request.request_digest),
            "request_not_expired": request.expires_unix_ms > time.time() * 1000,
        }
        diagnostic = {
            "decision": "deny",
            "checks": checks,
            "permission_mode": request.permission_mode
            if request.permission_mode in {"standard", "bounded", "unrestricted"}
            else "unsupported",
            "request_public_matches_preparing_name": preparing is not None
            and request.public_session == preparing.name,
            "request_public_matches_preparing_identity": preparing is not None
            and scope_valid
            and request.public_session == prefix + preparing.name,
            "request_public_has_preparing_suffix": preparing is not None
            and request.public_session.endswith(preparing.name),
            "request_transport_matches_preparing_name": preparing is not None
            and request.transport_session == preparing.name,
        }
        self._last_browser_authorization = diagnostic
        if not all(checks.values()):
            return False
        try:
            resource = json.loads(request.resource_json)
        except (TypeError, ValueError):
            checks["resource_json_valid"] = False
            return False
        checks["resource_is_object"] = isinstance(resource, dict)
        if not isinstance(resource, dict):
            return False
        profile = self._browser_profile
        product = resource.get("browser_product")
        products = {
            "google_chrome",
            "chromium",
            "microsoft_edge",
            "brave",
            "vivaldi",
            "opera",
            "arc",
            "electron",
            "firefox",
            "safari",
            "other",
        }
        diagnostic["browser_product"] = (
            product if isinstance(product, str) and product in products else "unsupported"
        )
        checks["browser_product_supported"] = product == "google_chrome"
        for key, expected in (
            ("pid", profile.pid),
            ("window_id", profile.window_id),
            ("endpoint_owner_pid", profile.pid),
        ):
            value = resource.get(key)
            checks[key + "_matches"] = (
                isinstance(value, int) and not isinstance(value, bool) and value == expected
            )
        if not all(checks.values()):
            return False
        # Preparation already verified the exact window before entering the
        # SDK. Its authorization callback must not re-enter the waiting driver;
        # recheck the local process identity alongside the attested resource.
        selection = await self._browser_selection_status(check_window=False)
        checks["local_selection_ready"] = selection["selection_ready"]
        if not selection["selection_ready"]:
            return False
        if self._authorizer is not None:
            local = AuthorizationRequest(
                session.id,
                request.request_digest,
                request.human_summary,
                resource,
                request.expires_unix_ms,
                request.adapter_id,
            )
            checks["local_authorizer_allowed"] = await self._authorizer(local) is True
            if not checks["local_authorizer_allowed"]:
                return False
        diagnostic["decision"] = "allow"
        return True

    async def _browser_selection_status(self, *, check_window: bool = True) -> dict[str, Any]:
        profile = self._browser_profile
        if profile.mode == "isolated":
            return {
                "mode": "isolated",
                "status": "ready",
                "approved": False,
                "selection_ready": True,
            }
        ready = False
        status = "awaiting_selection"
        if profile.approved:
            ready = await _process_fingerprint(profile.pid) == profile.fingerprint
            status = "ready" if ready else "expired"
            if ready and check_window:
                try:
                    targets = await self._chrome_targets("local-browser-selection", pid=profile.pid)
                except CuaError:
                    # The dependency diagnostic still reports its exact load
                    # error. Selection cannot be ready without window evidence.
                    targets = []
                ready = any(
                    target["pid"] == profile.pid
                    and target["window_id"] == profile.window_id
                    and target["fingerprint"] == profile.fingerprint
                    for target in targets
                )
                if not ready:
                    status = "window_unavailable"
        active = self._sessions.get(self._existing_browser_session)
        owner = self._owner_browser
        owner_ready = (
            ready
            and owner is not None
            and not owner.tainted
            and not owner.session.closed
            and not owner.session.closing
        )
        if owner_ready:
            now = time.monotonic()
            owner_ready = (
                owner.profile == profile
                and now < owner.created_at + OWNER_BROWSER_TTL_SECONDS
                and now < owner.last_activity + OWNER_BROWSER_IDLE_SECONDS
            )
        if ready and not owner_ready:
            status = "expired" if self._owner_expired else "awaiting_preparation"
        if ready and owner_ready and active is not None and active.browser is not None and not active.closing:
            status = "connected"
        return {
            "mode": "existing_profile",
            "status": status,
            "approved": profile.approved,
            "selection_ready": ready,
            "owner_ready": owner_ready,
        }

    async def _require_browser_selection(self) -> None:
        if self._browser_configuring:
            raise CuaError("browser_selection_changing", "The owner is changing the browser selection")
        status = await self._browser_selection_status()
        if not status["selection_ready"]:
            code = "browser_consent_required"
            if status["status"] == "expired":
                code = "browser_selection_expired"
            elif status["status"] == "window_unavailable":
                code = "browser_window_unavailable"
            raise CuaError(code, "Select and approve a current Chrome window in aBridge on this Mac")

    async def _session(self, session_id: str) -> _Session:
        if not isinstance(session_id, str) or not session_id or len(session_id) > 128:
            raise CuaError("invalid_arguments", "A valid aBridge session_id is required")
        if self._stopping:
            raise CuaError("driver_stopping", "Cua sessions are being stopped")
        driver = self._ensure_driver()
        session = self._sessions.get(session_id)
        if session is None:
            name = "abridge-" + hashlib.sha256(session_id.encode()).hexdigest()[:24]
            session = _Session(session_id, name)
            self._sessions[session_id] = session
        if session.closed or session.closing:
            raise CuaError("session_closed", "Open a new aBridge session after stopping")
        if not session.started:
            async with session.lock:
                if not session.started:
                    await self._invoke(
                        session_id,
                        driver.start_session(
                            self._sdk.StartSessionInput(
                                session=session.name,
                                capture_scope=None,
                                cursor_theme=None,
                                cursor_motion=None,
                            )
                        ),
                    )
                    session.started = True
        return session

    def _existing_session(self, session_id: str) -> _Session:
        session = self._sessions.get(session_id)
        if session is None or session.closed or session.closing or self._stopping or self._closed:
            raise CuaError("stale_observation", "Observe this session's target again before acting")
        return session

    async def _invoke(self, session_id: str, operation: Awaitable[Any], *, timeout: float = 30) -> Any:
        try:
            self._check_event_loop()
        except CuaError:
            if inspect.iscoroutine(operation):
                operation.close()
            raise
        task = asyncio.current_task()
        if task is not None:
            self._active[task] = session_id
        try:
            return await asyncio.wait_for(operation, timeout=timeout)
        except TimeoutError as error:
            raise CuaError(
                "outcome_unknown", "Cua timed out; inspect the target before issuing another action"
            ) from error
        except asyncio.CancelledError:
            raise
        except CuaError:
            raise
        except Exception as error:
            raise CuaError(
                "outcome_unknown",
                f"Cua operation did not return a result ({type(error).__name__}); inspect before retrying",
            ) from error
        finally:
            if task is not None:
                self._active.pop(task, None)

    async def _generic(
        self, session_id: str, tool: str, arguments: dict[str, Any], *, timeout: float = 30
    ) -> dict[str, Any]:
        session = self._sessions[session_id]
        self._require_live_session(session)
        handle = session.sdk_handle or self._driver
        owner = self._owner_browser if session.borrowed_browser and tool in _BROWSER_TOOLS else None
        mutating = tool in {"browser_navigate", "browser_click", "browser_type"}
        if session.borrowed_browser and tool in _BROWSER_TOOLS:
            if owner is None or owner.tainted:
                raise CuaError("browser_not_prepared", "Prepare this Chrome window locally in aBridge")
            handle = owner.session.sdk_handle
            arguments = {**arguments, "session": owner.session.name}
            owner.last_activity = time.monotonic()
        try:
            native = await self._invoke(
                session_id, handle.call_tool(tool, json.dumps(arguments)), timeout=timeout
            )
            return _tool_result(native)
        except asyncio.CancelledError:
            if owner is not None and mutating:
                owner.tainted = True
            raise
        except CuaError as error:
            if owner is not None and mutating and error.code == "outcome_unknown":
                owner.tainted = True
            if tool not in _BROWSER_TOOLS:
                raise
            stage = "act"
            if tool == "browser_prepare":
                stage = "prepare"
            elif tool == "get_browser_state":
                stage = "bind" if "pid" in arguments else "observe"
            elif tool == "browser_navigate":
                stage = "navigate"
            self._last_browser_error = {
                "stage": stage,
                "tool": tool,
                "code": error.code,
                "reason": _safe_browser_reason(error._local_reason or str(error)),
            }
            raise CuaError(
                error.code,
                "Cua refused or could not confirm the browser operation; check aBridge on this Mac",
            ) from None

    async def _browser_observe(self, session: _Session, screenshot: bool) -> dict[str, Any]:
        self._require_live_session(session)
        session.observation = None
        if session.browser is None:
            raise CuaError("browser_not_open", "Open an aBridge browser before observing it")
        result = await self._generic(
            session.id,
            "get_browser_state",
            {
                "session": session.name,
                **session.browser,
                "snapshot_format": "semantic_v2",
                "include_screenshot": screenshot,
            },
        )
        _check_browser_authority(result, require_fields=False)
        refs = _browser_refs(result)
        result["requested_url"] = session.requested_url
        result["browser_mode"] = session.browser_mode
        result["tab_retained_on_close"] = session.browser_mode == "existing_profile"
        return self._observation(session, "browser", session.browser, refs, result)

    async def _prepare_existing_browser(self, session: _Session) -> dict[str, str]:
        async with self._browser_selection_lock:
            if self._existing_browser_session not in (None, session.id):
                raise CuaError("browser_in_use", "The approved browser tab belongs to another session")
            owner = self._owner_browser
            if owner is None or owner.tainted or owner.session.browser is None:
                raise CuaError("browser_not_prepared", "Prepare this Chrome window locally in aBridge")
            await self._approved_existing_profile(session.id)
            self._existing_browser_session = session.id
            session.borrowed_browser = True
            return owner.session.browser.copy()

    async def _require_owner_browser(self, session_id: str) -> _OwnerBrowser:
        if self._stopping or self._browser_configuring:
            raise CuaError("driver_stopping", "The browser context is being stopped")
        owner = self._owner_browser
        if owner is None:
            raise CuaError("browser_not_prepared", "Prepare the approved Chrome window locally in aBridge")
        now = time.monotonic()
        expired = (
            now >= owner.created_at + OWNER_BROWSER_TTL_SECONDS
            or now >= owner.last_activity + OWNER_BROWSER_IDLE_SECONDS
        )
        fingerprint = await self._invoke(session_id, _process_fingerprint(owner.profile.pid))
        changed = owner.profile != self._browser_profile or fingerprint != owner.profile.fingerprint
        if expired or changed or owner.tainted or owner.session.closed or owner.session.closing:
            await self._close_owner_browser(expired=expired)
            code = "browser_selection_expired" if changed else "browser_not_prepared"
            raise CuaError(code, "The local browser preparation ended; prepare the approved window again")
        return owner

    async def _expire_owner_browser(self, owner: _OwnerBrowser) -> None:
        try:
            while self._owner_browser is owner:
                remaining = (
                    min(
                        owner.created_at + OWNER_BROWSER_TTL_SECONDS,
                        owner.last_activity + OWNER_BROWSER_IDLE_SECONDS,
                    )
                    - time.monotonic()
                )
                if remaining <= 0:
                    await self._close_owner_browser(expired=True)
                    return
                await asyncio.sleep(remaining)
        except CuaError as error:
            self._last_browser_error = {
                "stage": "cleanup",
                "tool": "end_session",
                "code": error.code,
                "reason": _safe_browser_reason(str(error)),
            }

    async def _close_owner_browser(self, *, expired: bool = False) -> None:
        async with self._browser_selection_lock:
            owner = self._owner_browser
            if owner is None:
                return
            self._owner_browser = None
            self._owner_expired = expired
            if owner.expiry_task is not None and owner.expiry_task is not asyncio.current_task():
                owner.expiry_task.cancel()
            for session in list(self._sessions.values()):
                if session.borrowed_browser:
                    await self._cancel_tasks(session.id)
                    session.observation = None
                    session.browser = None
            self._existing_browser_session = None
            await self._end_session(owner.session)
            self._sessions.pop(owner.session.id, None)

    async def _approved_existing_profile(self, session_id: str) -> BrowserProfile:
        await self._require_browser_selection()
        profile = self._browser_profile
        targets = await self._chrome_targets(session_id, pid=profile.pid)
        if not any(
            target["window_id"] == profile.window_id and target["fingerprint"] == profile.fingerprint
            for target in targets
        ):
            raise CuaError("browser_window_unavailable", "The selected Chrome window could not be verified")
        return profile

    async def _prepare_isolated_browser(self, session: _Session) -> dict[str, str]:
        prepared = await self._generic(
            session.id,
            "browser_prepare",
            {"session": session.name, "profile": {"mode": "isolated_new"}, "allow_launch": True},
        )
        pid = prepared.get("prepared_pid")
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
            raise CuaError("cua_response_contract", "Cua did not return the isolated browser's process ID")
        windows = await self._owned_browser_windows(session.id, pid)
        if len(windows) != 1:
            raise CuaError("browser_binding_ambiguous", "The isolated browser has no unique native window")
        binding = await self._generic(
            session.id,
            "get_browser_state",
            {"session": session.name, "pid": pid, "window_id": windows[0].window_id},
        )
        return _browser_binding(binding)

    async def _chrome_targets(self, session_id: str, *, pid: int | None = None) -> list[dict[str, Any]]:
        driver = self._ensure_driver()
        apps = await self._invoke(session_id, driver.list_apps(self._sdk.ListAppsInput()))
        targets = []
        for app in apps.apps:
            if (
                not app.running
                or app.bundle_id != "com.google.Chrome"
                or (pid is not None and app.pid != pid)
            ):
                continue
            fingerprint = await _process_fingerprint(app.pid)
            if fingerprint is None:
                continue
            windows = await self._invoke(
                session_id,
                driver.list_windows(self._sdk.ListWindowsInput(pid=app.pid, on_screen_only=False)),
            )
            for window in windows.windows:
                if window.pid == app.pid and window.layer == 0 and window.window_id > 0:
                    targets.append(
                        {
                            "pid": app.pid,
                            "window_id": window.window_id,
                            "title": (window.title or "")[:256],
                            "app_name": app.name,
                            "fingerprint": fingerprint,
                        }
                    )
        return targets

    async def _owned_browser_windows(self, session_id: str, pid: int) -> list[Any]:
        # Process startup can complete before its first native window appears.
        for attempt in range(20):
            self._require_live_session(self._sessions[session_id])
            result = await self._invoke(
                session_id,
                self._driver.list_windows(self._sdk.ListWindowsInput(pid=pid, on_screen_only=False)),
            )
            windows = [window for window in result.windows if window.pid == pid and window.layer in (None, 0)]
            if windows:
                return windows
            if attempt < 19:
                await asyncio.sleep(0.1)
        return []

    def _require_live_session(self, session: _Session) -> None:
        if session.closed or session.closing or self._stopping or self._closed:
            raise CuaError("session_closed", "The Cua session is stopping or closed")

    async def _desktop_focus(self, session_id: str) -> tuple[int, int, str]:
        guidance = (
            "; use computer_apps and computer_windows, then computer_observe with an explicit "
            "pid and window_id"
        )
        self._require_live_session(self._sessions[session_id])
        apps = await self._invoke(session_id, self._driver.list_apps(self._sdk.ListAppsInput()))
        active = [app for app in apps.apps if app.active is True and app.running is True and app.pid > 0]
        if len(active) != 1:
            raise CuaError("focus_unavailable", "The foreground application could not be verified" + guidance)
        pid = active[0].pid
        self._require_live_session(self._sessions[session_id])
        result = await self._invoke(
            session_id,
            self._driver.list_windows(self._sdk.ListWindowsInput(pid=pid, on_screen_only=True)),
        )
        visible = [
            window
            for window in result.windows
            if window.pid == pid and window.layer == 0 and window.is_on_screen is True
        ]
        if not visible or any(not isinstance(window.z_index, int) for window in visible):
            raise CuaError(
                "focus_unavailable", "The foreground window's stacking order could not be verified" + guidance
            )
        highest = max(window.z_index for window in visible)
        front = [window for window in visible if window.z_index == highest]
        if len(front) != 1:
            raise CuaError(
                "focus_unavailable", "The foreground window could not be identified uniquely" + guidance
            )
        return pid, front[0].window_id, front[0].title

    def _observation(
        self,
        session: _Session,
        kind: str,
        target: dict[str, Any],
        refs: set[str],
        result: dict[str, Any],
        *,
        focus: tuple[int, int, str] | None = None,
    ) -> dict[str, Any]:
        observation_id = "obs_" + uuid.uuid4().hex
        session.observation = _Observation(
            observation_id,
            kind,
            time.monotonic(),
            target.copy(),
            refs,
            result.get("capture_id"),
            result.get("width") or result.get("screenshot_width"),
            result.get("height") or result.get("screenshot_height"),
            focus,
        )
        return {**result, "observation_id": observation_id, "expires_in": OBSERVATION_SECONDS}

    def _take_observation(self, session: _Session, observation_id: str, kind: str) -> _Observation:
        observation = session.observation
        if observation is None or observation.id != observation_id or observation.kind != kind:
            raise CuaError("stale_observation", "Observe this session's target again before acting")
        session.observation = None
        if time.monotonic() - observation.created_at > OBSERVATION_SECONDS:
            raise CuaError("stale_observation", "The observation expired; observe again before acting")
        return observation

    async def _cancel_tasks(self, session_id: str | None = None) -> None:
        current = asyncio.current_task()
        tasks = [
            task
            for task, owner in self._active.items()
            if task is not current and (session_id is None or owner == session_id)
        ]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _end_session(self, session: _Session) -> None:
        session.observation = None
        session.browser = None
        session.closing = True
        if session.started or session.sdk_handle is not None:
            handle = session.sdk_handle or self._driver
            try:
                await self._invoke(
                    session.id, handle.end_session(self._sdk.EndSessionInput(session=session.name))
                )
            finally:
                if session.sdk_handle is not None:
                    session.sdk_handle.close()
        session.closed = True
        if self._existing_browser_session == session.id:
            self._existing_browser_session = None


@dataclass
class _Session:
    id: str
    name: str
    started: bool = False
    closed: bool = False
    closing: bool = False
    browser: dict[str, Any] | None = None
    browser_mode: str | None = None
    borrowed_browser: bool = False
    local_browser_owner: bool = False
    sdk_handle: Any | None = None
    requested_url: str | None = None
    observation: _Observation | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class _OwnerBrowser:
    session: _Session
    profile: BrowserProfile
    created_at: float
    last_activity: float
    tainted: bool = False
    expiry_task: asyncio.Task[None] | None = None


@dataclass
class _Observation:
    id: str
    kind: str
    created_at: float
    target: dict[str, Any]
    refs: set[str]
    capture_id: str | None = None
    width: int | None = None
    height: int | None = None
    focus: tuple[int, int, str] | None = None


def _computer_action(action: dict[str, Any], observation: _Observation) -> tuple[str, dict[str, Any]]:
    if not isinstance(action, dict):
        raise CuaError("invalid_arguments", "action must be an object")
    kind = action.get("type")
    if not isinstance(kind, str):
        raise CuaError("invalid_arguments", "action.type must be a supported action name")
    arguments: dict[str, Any] = {}
    ref = action.get("element_ref")
    if ref is not None:
        if not isinstance(ref, str) or ref not in observation.refs or not _AX_REF.fullmatch(ref):
            raise CuaError("stale_element", "Use an element_ref from this window observation")
        arguments["element_token"] = ref
    if kind in {"click", "double_click"}:
        if ref is None:
            x, y = _point(action, observation)
            arguments.update(x=x, y=y)
        button = action.get("button", "left")
        if button not in {"left", "right", "middle"}:
            raise CuaError("invalid_arguments", "Unsupported mouse button")
        arguments.update(button=button, count=2 if kind == "double_click" else 1)
        modifiers = _modifiers(action)
        if modifiers:
            arguments["modifier"] = modifiers
        return "click", arguments
    if kind == "type":
        arguments["text"] = _text(action, "text", allow_empty=True)
        return "type_text", arguments
    if kind == "key":
        arguments.update(key=_text(action, "key"), modifiers=_modifiers(action))
        return "press_key", arguments
    if kind == "move":
        x, y = _point(action, observation)
        return "move_cursor", {"x": x, "y": y}
    if kind == "drag":
        x, y = _point(action, observation)
        to_x, to_y = _point(action, observation, "to_x", "to_y")
        return "drag", {
            "from_x": x,
            "from_y": y,
            "to_x": to_x,
            "to_y": to_y,
        }
    if kind == "scroll":
        dy = _number(action, "delta_y")
        dx = _number(action, "delta_x", default=0)
        if dy and dx:
            raise CuaError("invalid_arguments", "Scroll one axis at a time")
        delta = dy or dx
        if not delta or abs(delta) > 10_000:
            raise CuaError("invalid_arguments", "Scroll delta must be nonzero and at most 10000")
        direction = ("down" if dy > 0 else "up") if dy else ("right" if dx > 0 else "left")
        arguments.update(direction=direction, amount=max(1, min(50, round(abs(delta) / 40))))
        return "scroll", arguments
    raise CuaError("invalid_arguments", "Unsupported computer action")


def _tool_result(native: Any, include_images: bool = True) -> dict[str, Any]:
    if native.is_error:
        raise CuaError(native.error_code or "cua_refused", native.text[:1000] or "Cua refused the operation")
    try:
        result = json.loads(native.structured_json) if native.structured_json else {}
    except (TypeError, ValueError) as error:
        raise CuaError(
            "outcome_unknown", "Cua returned an unreadable result; inspect before retrying"
        ) from error
    if not isinstance(result, dict):
        raise CuaError("cua_response_contract", "Cua returned a non-object result")
    result = _project(result)
    if result.get("effect") == "refused" or result.get("refusal"):
        error = result.get("error") or result.get("refusal")
        code = error.get("code", "cua_refused") if isinstance(error, dict) else "cua_refused"
        reason = error.get("message") if isinstance(error, dict) else None
        raise CuaError(code, "Cua refused the requested operation", local_reason=reason or native.text)
    if native.text:
        result.setdefault("text", native.text[:MAX_TEXT_CHARS])
    if include_images:
        _add_image(result, native.images)
    return result


def _project(value: Any, depth: int = 0) -> Any:
    if depth > 24:
        raise CuaError("cua_result_too_large", "Cua result nesting exceeded the limit")
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:MAX_TEXT_CHARS]
    if isinstance(value, Enum):
        return value.name.lower()
    if is_dataclass(value):
        record_fields = fields(value)
        if record_fields:
            value = {item.name: getattr(value, item.name) for item in record_fields}
        elif type(value).__module__ in {"cua_driver._native", "cua_driver._native_contract"}:
            # UniFFI 0.46.1 decorates records without declaring dataclass
            # fields. Their public constructor retains the typed field names.
            parameters = inspect.signature(type(value)).parameters
            value = {
                name: getattr(value, name)
                for name, parameter in parameters.items()
                if parameter.kind == inspect.Parameter.KEYWORD_ONLY and not name.startswith("_")
            }
        else:
            value = {}
    if isinstance(value, dict):
        hidden = {
            "raw_json",
            "resource_json",
            "launch_path",
            "screenshot_file_path",
            "cookies",
            "cookie",
            "headers",
            "authorization",
            "profile_path",
            "websocket_url",
            "cdp_endpoint",
        }
        return {str(key): _project(item, depth + 1) for key, item in value.items() if key not in hidden}
    if isinstance(value, (list, tuple)):
        return [_project(item, depth + 1) for item in value[:MAX_ELEMENTS]]
    raise CuaError("cua_response_contract", "Cua returned an unsupported result value")


def _safe_browser_reason(reason: str) -> str:
    value = reason[:4096]
    value = re.sub(r"(?i)\b(?:https?|wss?)://[^\s\"'<>]+", "[url]", value)
    value = re.sub(r"(?i)\bBearer\s+[^\s,;]+", "Bearer [redacted]", value)
    value = re.sub(
        r"(?i)\b(authorization|cookies?|token|password|device_key|profile_path)\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)",
        r"\1=[redacted]",
        value,
    )
    value = re.sub(r"(?<![\w.])/(?:[^\s\"'<>]+)", "[path]", value)
    value = re.sub(r"\b(?:127\.\d+\.\d+\.\d+|localhost):\d+\b", "[endpoint]", value)
    return value[:512]


def _add_image(result: dict[str, Any], images: list[Any]) -> None:
    if not images:
        return
    image = images[0]
    encoded = image.data_base64
    if len(encoded) > (MAX_IMAGE_BYTES + 2) // 3 * 4:
        raise CuaError("cua_image_too_large", "Cua screenshot exceeds 4 MiB")
    try:
        data = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise CuaError("cua_response_contract", "Cua returned an invalid screenshot") from error
    if len(data) > MAX_IMAGE_BYTES or image.mime_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise CuaError("cua_image_too_large", "Cua screenshot format or size is unsupported")
    result.update(image_base64=encoded, mime_type=image.mime_type)
    if image.mime_type == "image/png" and data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        result["width"] = int.from_bytes(data[16:20], "big")
        result["height"] = int.from_bytes(data[20:24], "big")


def _browser_binding(result: dict[str, Any], *, existing_profile: bool = False) -> dict[str, str]:
    _check_browser_authority(result, require_fields=True)
    target_id = result.get("target_id")
    tabs = result.get("tabs")
    if not isinstance(target_id, str) or not target_id or not isinstance(tabs, list):
        raise CuaError("cua_response_contract", "Cua did not return an exact browser target and tabs")
    if existing_profile:
        tabs = [tab for tab in tabs if isinstance(tab, dict) and tab.get("active") is True]
        if len(tabs) != 1:
            raise CuaError(
                "browser_binding_ambiguous", "The approved window has no uniquely proven active tab"
            )
    elif len(tabs) != 1:
        raise CuaError("cua_response_contract", "Cua did not return one exact isolated browser tab")
    tab_id = tabs[0].get("tab_id")
    if not isinstance(tab_id, str) or not tab_id:
        raise CuaError("cua_response_contract", "Cua did not return an exact browser tab")
    return {"target_id": target_id, "tab_id": tab_id}


def _check_browser_authority(result: dict[str, Any], *, require_fields: bool) -> None:
    expected = {"status": "ok", "binding_quality": "exact", "mutation_allowed": True}
    for key, value in expected.items():
        if (require_fields or key in result) and result.get(key) != value:
            raise CuaError(
                "browser_binding_ambiguous", "Cua did not authorize mutation on an exact browser binding"
            )


def _browser_refs(value: Any) -> set[str]:
    refs: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"ref", "element_ref"} and isinstance(item, str) and _BROWSER_REF.fullmatch(item):
                refs.add(item)
            refs.update(_browser_refs(item))
    elif isinstance(value, list):
        for item in value:
            refs.update(_browser_refs(item))
    return refs


def _chrome_dependency() -> dict[str, Any]:
    plist = Path("/Applications/Google Chrome.app/Contents/Info.plist")
    if not plist.is_file():
        return {"installed": False, "version": None}
    try:
        with plist.open("rb") as stream:
            info = plistlib.load(stream)
    except (OSError, plistlib.InvalidFileException):
        return {"installed": False, "version": None}
    return {"installed": True, "version": str(info.get("CFBundleShortVersionString", ""))}


def _validate_browser_profile(profile: BrowserProfile) -> None:
    if not isinstance(profile, BrowserProfile) or profile.mode not in {"isolated", "existing_profile"}:
        raise CuaError("invalid_arguments", "Use an isolated or owner-selected existing browser profile")
    if not isinstance(profile.approved, bool):
        raise CuaError("invalid_arguments", "Browser approval must be an explicit local boolean")
    if profile.mode == "existing_profile" and profile.approved:
        _positive_integer(profile.pid, "pid")
        _positive_integer(profile.window_id, "window_id")
        if not isinstance(profile.fingerprint, str) or not re.fullmatch(r"[0-9a-f]{64}", profile.fingerprint):
            raise CuaError("invalid_arguments", "Choose a current Chrome process from the local selector")


async def _process_fingerprint(pid: int | None) -> str | None:
    """Hash local process identity, distinct from Cua's attested resource field."""
    if sys.platform != "darwin" or isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    try:
        process = await asyncio.create_subprocess_exec(
            "/bin/ps",
            "-p",
            str(pid),
            "-o",
            "lstart=",
            "-o",
            "comm=",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"},
        )
    except OSError:
        return None
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout=2)
    except TimeoutError:
        return None
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()
    if process.returncode != 0 or not output.strip() or len(output) > 8192:
        return None
    return hashlib.sha256(b"abridge-process-v1\0" + str(pid).encode() + b"\0" + output.strip()).hexdigest()


def _positive_integer(value: Any, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise CuaError("invalid_arguments", f"{name} must be a positive integer")


def _http_url(value: str) -> None:
    if not isinstance(value, str) or len(value) > 8192 or any(character.isspace() for character in value):
        raise CuaError("invalid_arguments", "Use an HTTP or HTTPS URL")
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme in {"http", "https"}
            and parsed.hostname
            and not parsed.username
            and not parsed.password
        )
        parsed.port
    except ValueError as error:
        raise CuaError("invalid_arguments", "Use a valid HTTP or HTTPS URL") from error
    if not valid:
        raise CuaError("invalid_arguments", "Use an HTTP or HTTPS URL without embedded credentials")


def _text(action: dict[str, Any], key: str, *, allow_empty: bool = False) -> str:
    value = action.get(key)
    if not isinstance(value, str) or (not value and not allow_empty) or len(value) > 10_000 or "\0" in value:
        raise CuaError("invalid_arguments", f"{key} must be valid text of at most 10000 characters")
    return value


def _number(action: dict[str, Any], key: str, default: float | None = None) -> float:
    value = action.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CuaError("invalid_arguments", f"{key} must be a finite number")
    return float(value)


def _point(
    action: dict[str, Any], observation: _Observation, x_key: str = "x", y_key: str = "y"
) -> tuple[float, float]:
    x, y = _number(action, x_key), _number(action, y_key)
    if not observation.width or not observation.height:
        raise CuaError("coordinate_geometry_missing", "Take a screenshot before using pixel coordinates")
    if not 0 <= x < observation.width or not 0 <= y < observation.height:
        raise CuaError("invalid_coordinates", "Coordinates must lie inside the observed screenshot")
    return x, y


def _modifiers(action: dict[str, Any]) -> list[str]:
    modifiers = action.get("modifiers", [])
    allowed = {"cmd", "command", "ctrl", "control", "alt", "option", "shift", "fn"}
    if not isinstance(modifiers, list) or any(
        not isinstance(item, str) or item not in allowed for item in modifiers
    ):
        raise CuaError("invalid_arguments", "Unsupported key modifier")
    aliases = {"command": "cmd", "control": "ctrl", "alt": "option"}
    return [aliases.get(item, item) for item in modifiers]
