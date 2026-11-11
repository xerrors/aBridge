"""Browser selection remains an owner-local CLI control, not an MCP argument."""

import asyncio
import json
import sys
import tempfile
from pathlib import Path

from abridge.client import DeviceClient, local_control


async def test_old_config_with_browser_enabled_waits_for_owner_selection(tmp_path: Path) -> None:
    config = {"url": "http://127.0.0.1:1", "capabilities": {"browser": True}, "paused": True}
    client = DeviceClient(tmp_path, config, "abr_device_not_used")
    try:
        capabilities = await client._effective_capabilities()
        browser = client.status["dependencies"]["browser"]
        assert browser["mode"] == "existing_profile"
        assert browser["status"] == "awaiting_selection"
        assert capabilities["browser"] is False
        assert config["paused"] is True
        assert "browser_profile" not in config
    finally:
        await client.executor.shutdown()
        client.journal.close()


async def test_browser_target_cli_sends_explicit_local_approval() -> None:
    requests: asyncio.Queue[dict] = asyncio.Queue()

    async def control(reader, writer):
        requests.put_nowait(json.loads(await reader.readline()))
        writer.write(b'{"ok":true}\n')
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    with tempfile.TemporaryDirectory(prefix="abridge-profile-", dir="/tmp") as directory:
        state = Path(directory)
        server = await asyncio.start_unix_server(control, path=str(state / "control.sock"))
        async with server:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-m",
                "abridge.client",
                "--state-dir",
                str(state),
                "control",
                "browser-target",
                "--mode",
                "existing_profile",
                "--pid",
                "4242",
                "--window-id",
                "123",
                "--fingerprint",
                "a" * 64,
                "--approve",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            output, error = await asyncio.wait_for(process.communicate(), timeout=10)
        assert process.returncode == 0, error.decode()
        assert json.loads(output) == {"ok": True}
        request = requests.get_nowait()
        assert request == {
            "command": "browser-target",
            "profile": {
                "mode": "existing_profile",
                "pid": 4242,
                "window_id": 123,
                "fingerprint": "a" * 64,
                "approved": True,
            },
        }


async def test_only_owner_prepare_extends_local_control_timeout(monkeypatch) -> None:
    timeouts = []
    original_wait_for = asyncio.wait_for

    async def record_timeout(awaitable, timeout):
        timeouts.append(timeout)
        return await original_wait_for(awaitable, timeout)

    async def control(reader, writer):
        await reader.readline()
        writer.write(b'{"ok":true}\n')
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    monkeypatch.setattr(asyncio, "wait_for", record_timeout)
    with tempfile.TemporaryDirectory(prefix="abridge-owner-", dir="/tmp") as directory:
        state = Path(directory)
        server = await asyncio.start_unix_server(control, path=str(state / "control.sock"))
        async with server:
            assert (await local_control(state, {"command": "browser-prepare"}))["ok"] is True
            assert (await local_control(state, {"command": "status"}))["ok"] is True
    assert timeouts == [120, 15]
