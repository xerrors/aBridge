"""Check aBridge's ref and cancellation rules with a recording SDK peer.

These tests do not establish native Cua compatibility or real browser effects;
those require the separately coordinated installed-App and Yuxi checks.
"""

from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from test_device_protocol_acceptance import device_peer, wait_for_file

import abridge.cua_driver as boundary
from abridge.client import local_control
from abridge.cua_driver import CUA_VERSION, BrowserProfile, CuaDriverAdapter, CuaError
from abridge.executor import LocalExecutor


async def test_browser_refs_are_session_scoped_single_use_and_expire(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [100.0]
    monkeypatch.setattr(boundary, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    peer = RecordingSDK()
    adapter = CuaDriverAdapter(sdk=peer.sdk, driver=peer, browser_profile=BrowserProfile(mode="isolated"))
    try:
        first = await adapter.browser_open("first", "https://example.invalid/first")
        second = await adapter.browser_open("second", "https://example.invalid/second")
        action = {"type": "fill", "element_ref": first["elements"][0]["ref"], "text": "独立验证"}
        with pytest.raises(CuaError) as refused:
            await adapter.browser_act("second", first["observation_id"], action)
        assert refused.value.code == "stale_observation"
        assert peer.actions == []

        await adapter.browser_act("first", first["observation_id"], action)
        assert peer.actions[-1][0] == "browser_type"
        assert peer.actions[-1][1]["text"] == "独立验证"
        assert peer.actions[-1][1]["replace"] is True
        with pytest.raises(CuaError) as refused:
            await adapter.browser_act("first", first["observation_id"], action)
        assert refused.value.code == "stale_observation"

        fresh = await adapter.browser_observe("first")
        with pytest.raises(CuaError) as refused:
            await adapter.browser_act(
                "first",
                fresh["observation_id"],
                {
                    "type": "click",
                    "element_ref": second["elements"][0]["ref"],
                },
            )
        assert refused.value.code == "stale_element"

        fresh = await adapter.browser_observe("first")
        clock[0] += 11
        with pytest.raises(CuaError) as refused:
            await adapter.browser_act(
                "first",
                fresh["observation_id"],
                {
                    "type": "click",
                    "element_ref": fresh["elements"][0]["ref"],
                },
            )
        assert refused.value.code == "stale_observation"
        assert len(peer.actions) == 1
    finally:
        await adapter.shutdown()


async def test_close_cancels_inflight_action_and_preserves_other_session() -> None:
    peer = RecordingSDK()
    adapter = CuaDriverAdapter(sdk=peer.sdk, driver=peer, browser_profile=BrowserProfile(mode="isolated"))
    try:
        first = await adapter.browser_open("first", "https://example.invalid/first")
        await adapter.browser_open("second", "https://example.invalid/second")
        peer.block_actions = True
        action = asyncio.create_task(
            adapter.browser_act(
                "first",
                first["observation_id"],
                {
                    "type": "fill",
                    "element_ref": first["elements"][0]["ref"],
                    "text": "must not arrive",
                },
            )
        )
        await asyncio.wait_for(peer.action_started.wait(), timeout=1)
        await asyncio.wait_for(adapter.close_session("first"), timeout=1)
        with pytest.raises(asyncio.CancelledError):
            await action
        assert peer.action_cancelled.is_set()
        assert peer.actions == []
        assert len(peer.sessions) == 1
        assert (await adapter.browser_observe("second"))["observation_id"]
        with pytest.raises(CuaError) as refused:
            await adapter.browser_open("first", "https://example.invalid/replay")
        assert refused.value.code == "session_closed"
        await adapter.stop()
        assert peer.sessions == set()
    finally:
        await adapter.shutdown()


async def test_device_reclaims_idle_browser_on_close_pause_and_disconnect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(boundary, "_chrome_dependency", lambda: {"installed": True, "version": "fixture"})
    sdk = RecordingSDK()
    adapter = CuaDriverAdapter(sdk=sdk.sdk, driver=sdk, browser_profile=BrowserProfile(mode="isolated"))
    state = tmp_path / "device"
    async with device_peer(
        state, executor=LocalExecutor(driver=adapter), capabilities={"browser": True, "shell": True}
    ) as peer:
        assert peer.hello["capabilities"]["browser"] is True
        assert peer.hello["capabilities"]["screen"] is False
        assert peer.hello["capabilities"]["input"] is False
        browser_scope = {"session_id": "browser-first", "session_capabilities": ["browser"]}
        opened = await peer.call(
            "browser-open", "browser_open", {"url": "https://example.invalid"}, **browser_scope
        )
        assert opened["status"] == "executed", opened
        assert len(sdk.sessions) == 1

        marker, gate = tmp_path / "shell-started", tmp_path / "shell-gate"
        command = (
            f"printf ready > {shlex.quote(str(marker))}; "
            f"while [ ! -f {shlex.quote(str(gate))} ]; do sleep 0.05; done; printf shell-preserved"
        )
        await peer.dispatch(
            "parallel-shell", "command_execute", {"command": command}, session_id="shell-only"
        )
        await wait_for_file(marker)
        await peer.connection.send(
            json.dumps(
                {
                    "type": "session_close",
                    "session_id": "browser-first",
                    "connection_epoch": peer.epoch - 1,
                }
            )
        )
        still_open = await peer.call("after-stale-close", "browser_observe", {}, **browser_scope)
        assert still_open["status"] == "executed", still_open
        await peer.connection.send(
            json.dumps(
                {
                    "type": "session_close",
                    "session_id": "browser-first",
                    "connection_epoch": peer.epoch,
                }
            )
        )
        async with asyncio.timeout(2):
            while sdk.sessions:
                await asyncio.sleep(0.01)
        status = await local_control(state, {"command": "status"})
        assert "parallel-shell" in status["active_operations"]
        gate.write_text("continue")
        assert (await peer.result("parallel-shell"))["result"]["stdout"] == "shell-preserved"

        browser_scope["session_id"] = "browser-second"
        assert (
            await peer.call(
                "second-open", "browser_open", {"url": "https://example.invalid"}, **browser_scope
            )
        )["status"] == "executed"
        assert (await local_control(state, {"command": "pause"}))["paused"] is True
        assert sdk.sessions == set()
        await local_control(state, {"command": "resume"})
        refused = await peer.call(
            "late-reopen", "browser_open", {"url": "https://example.invalid"}, **browser_scope
        )
        assert refused["error"]["code"] == "session_closed"

        browser_scope["session_id"] = "browser-third"
        assert (
            await peer.call("third-open", "browser_open", {"url": "https://example.invalid"}, **browser_scope)
        )["status"] == "executed"
        assert sdk.sessions
        await peer.connection.close()
        async with asyncio.timeout(3):
            while sdk.sessions:
                await asyncio.sleep(0.01)
        assert (await local_control(state, {"command": "status"}))["active_operations"] == []


class RecordingSDK:
    """A deterministic SDK peer; never imports native code or starts a browser."""

    def __init__(self) -> None:
        self.sdk = SimpleNamespace(
            __version__=CUA_VERSION,
            DriverExecutionMode=SimpleNamespace(EMBEDDED="embedded"),
            StartSessionInput=SimpleNamespace,
            EndSessionInput=SimpleNamespace,
            ListAppsInput=SimpleNamespace,
            ListWindowsInput=SimpleNamespace,
            SessionPermissionMode=SimpleNamespace(STANDARD="standard"),
            TrustedSessionOptions=SimpleNamespace,
            create_trusted_session=self.create_trusted_session,
            current_mac_os_permission_status=lambda: SimpleNamespace(
                screen_recording=False, accessibility=False
            ),
        )
        self.sessions: set[str] = set()
        self.actions: list[tuple[str, dict[str, Any]]] = []
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.snapshot_count = 0
        self.block_actions = False
        self.action_started = asyncio.Event()
        self.action_cancelled = asyncio.Event()
        self.trusted_options: list[Any] = []
        self.closed_handles: list[str] = []

    def execution_mode(self) -> str:
        return "embedded"

    def socket_path(self) -> None:
        return None

    def is_available(self) -> bool:
        return True

    async def start_session(self, request: Any) -> None:
        self.sessions.add(request.session)

    async def end_session(self, request: Any) -> None:
        self.sessions.discard(request.session)

    async def shutdown(self) -> None:
        assert not self.sessions

    def create_trusted_session(self, driver: Any, options: Any) -> Any:
        assert driver is self
        self.trusted_options.append(options)
        return RecordingBoundSession(self, options.public_session)

    async def list_apps(self, request: Any) -> Any:
        return SimpleNamespace(
            apps=[
                SimpleNamespace(pid=123, running=True, bundle_id="com.google.Chrome", name="Fixture Chrome")
            ]
        )

    async def list_windows(self, request: Any) -> Any:
        return SimpleNamespace(
            windows=[SimpleNamespace(pid=request.pid, window_id=42, layer=0, title="Fixture")]
        )

    async def call_tool(self, tool: str, encoded: str) -> Any:
        arguments = json.loads(encoded)
        self.calls.append((tool, arguments))
        if tool == "browser_prepare":
            result = {"prepared_pid": 123}
        elif tool == "get_browser_state":
            self.snapshot_count += 1
            result = {
                "status": "ok",
                "binding_quality": "exact",
                "mutation_allowed": True,
                "target_id": "target-" + arguments["session"],
                "tabs": [{"tab_id": "tab-" + arguments["session"], "active": True}],
                "elements": [{"ref": f"p1:{self.snapshot_count}", "role": "textbox"}],
            }
        elif tool in {"browser_type", "browser_click"}:
            if self.block_actions:
                self.action_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.action_cancelled.set()
                    raise
            self.actions.append((tool, arguments))
            result = {"executed": True}
        else:
            assert tool == "browser_navigate", tool
            result = {"navigated": True}
        return SimpleNamespace(
            is_error=False, error_code=None, text="", structured_json=json.dumps(result), images=[]
        )


class RecordingBoundSession:
    """Record the public SDK bound-handle contract without native operations."""

    def __init__(self, driver: RecordingSDK, name: str) -> None:
        self.driver = driver
        self.name = name
        self.closed = False

    async def start_session(self, request: Any) -> None:
        assert request.session == self.name
        await self.driver.start_session(request)

    async def end_session(self, request: Any) -> None:
        assert request.session == self.name
        await self.driver.end_session(request)

    async def call_tool(self, tool: str, encoded: str) -> Any:
        assert not self.closed
        assert json.loads(encoded)["session"] == self.name
        return await self.driver.call_tool(tool, encoded)

    def close(self) -> None:
        if not self.closed:
            self.driver.closed_handles.append(self.name)
            self.closed = True

    async def shutdown(self) -> None:
        assert not self.sessions
