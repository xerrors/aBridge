"""The fixed, in-process Cua SDK boundary used by the macOS device client."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib
import json
import math
import plistlib
import re
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, fields, is_dataclass
from enum import Enum
from importlib import metadata
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from abridge.protocol import OBSERVATION_SECONDS

CUA_VERSION = "0.46.1"
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_TEXT_CHARS = 131_072
MAX_ELEMENTS = 500
_BROWSER_REF = re.compile(r"p[0-9]+:[0-9]+\Z")
_AX_REF = re.compile(r"s[0-9a-f]{8}:[0-9]+\Z")


class CuaError(Exception):
    """A dependency failure, explicit refusal, or uncertain driver outcome."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AuthorizationRequest:
    """Owner-local data; never include this object in an Agent tool result."""

    session_id: str
    request_digest: str
    summary: str
    resource: dict[str, Any]
    expires_unix_ms: int


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
        sdk: Any | None = None,
        driver: Any | None = None,
    ) -> None:
        self._authorizer = authorizer
        self._sdk = sdk
        self._driver = driver
        self._authorization_host: Any | None = None
        self._sessions: dict[str, _Session] = {}
        self._active: dict[asyncio.Task[Any], str] = {}
        self._closed = False
        self._stopping = False

    async def diagnostics(self) -> dict[str, Any]:
        """Inspect dependencies and TCC without launching a browser or prompting."""
        browser = _chrome_dependency()
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
                "mode": "isolated",
                "active_sessions": sum(
                    session.browser is not None and not session.closed for session in self._sessions.values()
                ),
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
            result["browser"]["ready"] = browser["installed"] and result["driver"]["ready"]
        except CuaError as error:
            result["driver"]["error"] = {"code": error.code, "message": str(error)}
        return result

    async def list_apps(self, session_id: str) -> dict[str, Any]:
        await self._session(session_id)
        result = await self._invoke(session_id, self._driver.list_apps(self._sdk.ListAppsInput()))
        return {"apps": _project(result.apps)}

    async def list_windows(self, session_id: str, pid: int | None = None) -> dict[str, Any]:
        if pid is not None:
            _positive_integer(pid, "pid")
        await self._session(session_id)
        result = await self._invoke(
            session_id,
            self._driver.list_windows(self._sdk.ListWindowsInput(pid=pid, on_screen_only=False)),
        )
        return {"windows": _project(result.windows), "current_space_id": result.current_space_id}

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
                            tree_format="markdown",
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
        session = await self._session(session_id)
        async with session.lock:
            self._require_live_session(session)
            session.observation = None
            if session.browser is None:
                # The browser and profile belong to this SDK session. Existing
                # profile attachment is deliberately not an Agent-facing option.
                try:
                    prepared = await self._generic(
                        session_id,
                        "browser_prepare",
                        {"session": session.name, "profile": {"mode": "isolated_new"}, "allow_launch": True},
                    )
                    pid = prepared.get("prepared_pid")
                    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
                        raise CuaError(
                            "cua_response_contract", "Cua did not return the isolated browser's process ID"
                        )
                    windows = await self._owned_browser_windows(session_id, pid)
                    if len(windows) != 1:
                        raise CuaError(
                            "browser_binding_ambiguous", "The isolated browser has no unique native window"
                        )
                    binding = await self._generic(
                        session_id,
                        "get_browser_state",
                        {"session": session.name, "pid": pid, "window_id": windows[0].window_id},
                    )
                    session.browser = _browser_binding(binding)
                except BaseException:
                    # A failed bind must not leave a newly launched browser behind.
                    await self._end_session(session)
                    raise
            if session.requested_url != url:
                await self._generic(
                    session_id,
                    "browser_navigate",
                    {"session": session.name, **session.browser, "url": url},
                )
                session.requested_url = url
            return await self._browser_observe(session, screenshot=False)

    async def browser_observe(self, session_id: str, screenshot: bool = False) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if session is None or session.browser is None or session.closed or session.closing:
            raise CuaError("browser_not_open", "Open an aBridge browser before observing it")
        async with session.lock:
            return await self._browser_observe(session, screenshot)

    async def browser_act(
        self, session_id: str, observation_id: str, action: dict[str, Any]
    ) -> dict[str, Any]:
        session = self._existing_session(session_id)
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
        session = self._sessions.get(session_id)
        if session is None or session.closed:
            return {"closed": True}
        session.closing = True
        await self._cancel_tasks(session_id)
        async with session.lock:
            if not session.closed:
                await self._end_session(session)
        return {"closed": True}

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
        if self._closed:
            raise CuaError("driver_closed", "The Cua runtime was shut down")
        sdk = self._load_sdk()
        if self._driver is None:
            owner = self

            class AuthorizationHost(sdk.DriverAuthorizationHost):
                async def authorize(self, request: Any) -> Any:
                    # A remote Agent cannot manufacture an owner-local approval.
                    session = next(
                        (entry for entry in owner._sessions.values() if entry.name == request.public_session),
                        None,
                    )
                    allowed = False
                    if owner._authorizer is not None and session is not None and not session.closed:
                        resource = json.loads(request.resource_json)
                        local = AuthorizationRequest(
                            session.id,
                            request.request_digest,
                            request.human_summary,
                            resource,
                            request.expires_unix_ms,
                        )
                        allowed = await owner._authorizer(local) is True
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
                    max_session_ttl_seconds=1800,
                    max_idle_ttl_seconds=300,
                ),
            )
            try:
                self._driver = sdk.CuaDriver.create_configured_with_authorization_host(
                    options, self._authorization_host
                )
            except Exception as error:
                raise CuaError("cua_load_failed", "The embedded Cua runtime could not initialize") from error
        mode = self._driver.execution_mode()
        if mode != sdk.DriverExecutionMode.EMBEDDED or self._driver.socket_path():
            raise CuaError("cua_mode_mismatch", "aBridge requires an in-process Cua runtime")
        return self._driver

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

    async def _invoke(self, session_id: str, operation: Awaitable[Any]) -> Any:
        task = asyncio.current_task()
        if task is not None:
            self._active[task] = session_id
        try:
            return await asyncio.wait_for(operation, timeout=30)
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

    async def _generic(self, session_id: str, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self._require_live_session(self._sessions[session_id])
        native = await self._invoke(session_id, self._driver.call_tool(tool, json.dumps(arguments)))
        return _tool_result(native)

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
        return self._observation(session, "browser", session.browser, refs, result)

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
        self._require_live_session(self._sessions[session_id])
        apps = await self._invoke(session_id, self._driver.list_apps(self._sdk.ListAppsInput()))
        active = [app for app in apps.apps if app.active is True and app.running is True and app.pid > 0]
        if len(active) != 1:
            raise CuaError("focus_unavailable", "The foreground application could not be verified")
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
                "focus_unavailable", "The foreground window's stacking order could not be verified"
            )
        highest = max(window.z_index for window in visible)
        front = [window for window in visible if window.z_index == highest]
        if len(front) != 1:
            raise CuaError("focus_unavailable", "The foreground window could not be identified uniquely")
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
        await self._invoke(
            session.id, self._driver.end_session(self._sdk.EndSessionInput(session=session.name))
        )
        session.closed = True


@dataclass
class _Session:
    id: str
    name: str
    started: bool = False
    closed: bool = False
    closing: bool = False
    browser: dict[str, Any] | None = None
    requested_url: str | None = None
    observation: _Observation | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


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
        raise CuaError(code, "Cua refused the requested operation")
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
        value = {item.name: getattr(value, item.name) for item in fields(value)}
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


def _browser_binding(result: dict[str, Any]) -> dict[str, str]:
    _check_browser_authority(result, require_fields=True)
    target_id = result.get("target_id")
    tabs = result.get("tabs")
    if not isinstance(target_id, str) or not target_id or not isinstance(tabs, list) or len(tabs) != 1:
        raise CuaError(
            "cua_response_contract", "Cua did not return one exact isolated browser target and tab"
        )
    tab_id = tabs[0].get("tab_id")
    if not isinstance(tab_id, str) or not tab_id:
        raise CuaError("cua_response_contract", "Cua did not return an exact isolated browser tab")
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
