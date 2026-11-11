"""Transferred file access belongs to the daemon, not an MCP operation."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

import abridge.client as client_module
from abridge.client import DeviceClient, local_control
from abridge.executor import LocalExecutor


@pytest.mark.parametrize("denials", [(False, False), (False, True), (True, True)])
async def test_browser_file_scope_is_reported_and_released_after_driver_shutdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, denials: tuple[bool, bool]
) -> None:
    events = []
    acquired = []
    error = {"code": "browser_access_denied", "message": "Select the Chrome connection file locally"}

    def acquire(state_dir: Path):
        assert state_dir == tmp_path
        index = len(acquired)
        denied = denials[index]
        access = SimpleNamespace(
            status={
                "status": "denied" if denied else "ready",
                "ready": not denied,
                "error": error if denied else None,
            },
            close=lambda: events.append(f"access_closed_{index}"),
        )
        acquired.append(access)
        events.append(f"access_acquired_{index}")
        return access

    async def diagnostics():
        assert events[0] == "access_acquired_0"
        assert "driver_shutdown" not in events
        return {
            "driver": {"ready": True},
            "permissions": {"screen": True, "input": True},
            "browser": {"mode": "existing_profile", "ready": True},
        }

    executor = LocalExecutor()
    shutdown_driver = executor.shutdown
    prepared = []

    async def prepare_browser():
        prepared.append(True)
        return {"prepared": True}

    async def shutdown():
        await shutdown_driver()
        events.append("driver_shutdown")

    monkeypatch.setattr(client_module, "acquire_browser_access", acquire)
    monkeypatch.setattr(executor, "diagnostics", diagnostics)
    monkeypatch.setattr(executor, "prepare_browser", prepare_browser)
    monkeypatch.setattr(executor, "shutdown", shutdown)
    client = DeviceClient(
        tmp_path,
        {
            "url": "http://127.0.0.1:1",
            "paused": False,
            "capabilities": {"screen": True, "input": True, "browser": True, "shell": True, "files": True},
        },
        "abr_device_not_used",
        executor=executor,
    )

    async def wait_for_shutdown():
        await client.shutdown.wait()

    monkeypatch.setattr(client, "_reconnect_loop", wait_for_shutdown)
    running = asyncio.create_task(client.run())
    try:
        async with asyncio.timeout(2):
            while not hasattr(client, "socket_path") or not client.socket_path.exists():
                assert not running.done()
                await asyncio.sleep(0.01)
        status = await local_control(tmp_path, {"command": "status"})
        assert status["ok"] is True
        assert status["dependencies"]["browser"]["file_access"] == acquired[0].status
        assert status["dependencies"]["browser"]["ready"] is not denials[0]
        assert status["paused"] is False
        assert all(status["capabilities"][name] for name in ("screen", "input", "shell", "files"))
        assert status["capabilities"]["browser"] is not denials[0]
        response = await local_control(tmp_path, {"command": "browser-prepare"})
        if denials[1]:
            assert response == {"ok": False, "error": error["message"]}
            assert prepared == []
            assert "access_closed_0" not in events
            assert events[-1] == "access_closed_1"
        else:
            assert response["ok"] is True
            assert prepared == [True]
            assert events[-1] == "access_closed_0"
        refreshed = await local_control(tmp_path, {"command": "status"})
        assert refreshed["dependencies"]["browser"]["file_access"] == acquired[1].status
        assert refreshed["dependencies"]["browser"]["ready"] is not denials[1]
        assert refreshed["capabilities"]["shell"] is True
        assert refreshed["capabilities"]["input"] is True
        assert refreshed["paused"] is False
        assert not running.done()
    finally:
        client.shutdown.set()
        await asyncio.wait_for(running, timeout=3)
    if denials[1]:
        assert events == [
            "access_acquired_0",
            "access_acquired_1",
            "access_closed_1",
            "driver_shutdown",
            "access_closed_0",
        ]
    else:
        assert events == [
            "access_acquired_0",
            "access_acquired_1",
            "access_closed_0",
            "driver_shutdown",
            "access_closed_1",
        ]


async def test_browser_file_scope_is_released_if_local_control_setup_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    closed = []
    access = SimpleNamespace(
        status={"status": "not_configured", "ready": False, "error": None}, close=lambda: closed.append(True)
    )
    monkeypatch.setattr(client_module, "acquire_browser_access", lambda _state: access)
    client = DeviceClient(
        tmp_path, {"url": "http://127.0.0.1:1", "paused": True, "capabilities": {}}, "abr_device_not_used"
    )

    async def fail_to_serve():
        raise OSError("Control socket unavailable")

    monkeypatch.setattr(client, "_serve", fail_to_serve)
    try:
        with pytest.raises(OSError, match="Control socket unavailable"):
            await client.run()
        assert closed == [True]
        assert client.config["paused"] is True
    finally:
        client.journal.close()
        await client.executor.shutdown()
