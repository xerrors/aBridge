"""Takeover protection covers in-flight input, never passive desktop reads."""

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import pytest

from abridge.client import DeviceClient, local_control
from abridge.executor import ExecutionError, LocalExecutor
from abridge.protocol import CAPABILITIES


@pytest.mark.parametrize("tool", ["computer_apps", "computer_windows", "computer_observe", "browser_observe"])
async def test_read_operations_do_not_arm_takeover_or_pause(
    running_client: tuple[DeviceClient, "ControlledExecution"], tool: str
) -> None:
    client, execution = running_client
    await client._dispatch(dispatch(tool, "read", 1))
    await execution.started("read")
    assert status(client)["desktop_active_until"] == 0

    automatic = await local_control(client.state_dir, {"command": "pause", "if_desktop_active": True})
    assert automatic["pause_ignored"] == "desktop_inactive"
    assert automatic["paused"] is False
    assert "read" in client.operations

    # Refused/empty reads must not leave protection behind either.
    execution.failures["read"] = ExecutionError("target_unavailable", "No matching window")
    execution.release["read"].set()
    await finish(client, "read")
    await client._close_session("session_1")
    assert status(client)["desktop_active_until"] == 0
    assert client.config["paused"] is False


@pytest.mark.parametrize("ending", ["success", "refused", "cancel", "close"])
async def test_input_protection_ends_with_operation(
    running_client: tuple[DeviceClient, "ControlledExecution"], ending: str
) -> None:
    client, execution = running_client
    await client._dispatch(dispatch("computer_act", "input", 1))
    await execution.started("input")
    assert status(client)["desktop_active_until"] > time.time()
    if ending == "close":
        await client._close_session("session_1")
    elif ending == "cancel":
        await client._stop_operations(["input"])
    else:
        if ending == "refused":
            execution.failures["input"] = ExecutionError("stale_observation", "Observe again")
        execution.release["input"].set()
        await finish(client, "input")
    assert status(client)["desktop_active_until"] == 0

    automatic = await local_control(client.state_dir, {"command": "pause", "if_desktop_active": True})
    assert automatic["paused"] is False
    assert automatic["pause_ignored"] == "desktop_inactive"


async def test_one_finished_input_does_not_clear_another_and_explicit_takeover_stops_it(
    running_client: tuple[DeviceClient, "ControlledExecution"],
) -> None:
    client, execution = running_client
    for index in (1, 2):
        operation_id = f"input_{index}"
        await client._dispatch(dispatch("computer_act", operation_id, index))
        await execution.started(operation_id)
    execution.release["input_1"].set()
    await finish(client, "input_1")
    assert status(client)["desktop_active_until"] > time.time()

    automatic = await local_control(client.state_dir, {"command": "pause", "if_desktop_active": True})
    assert automatic["paused"] is True
    assert automatic["pause_reason"]["source"] == "desktop_input"
    assert abs(automatic["pause_reason"]["at"] - time.time()) < 2
    assert client.operations == {}
    assert status(client)["desktop_active_until"] == 0
    assert json.loads((client.state_dir / "config.json").read_text())["paused"] is True


async def test_manual_pause_without_input_is_persistent(
    running_client: tuple[DeviceClient, "ControlledExecution"],
) -> None:
    client, _ = running_client
    paused = await local_control(client.state_dir, {"command": "pause"})
    assert paused["paused"] is True
    assert paused["pause_reason"]["source"] == "manual"
    persisted = json.loads((client.state_dir / "config.json").read_text())
    assert persisted["paused"] is True
    assert persisted["pause_reason"] == paused["pause_reason"]

    rebind = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "abridge.client",
        "--state-dir",
        str(client.state_dir),
        "configure",
        "--stdin",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    output, error = await asyncio.wait_for(
        rebind.communicate(
            json.dumps(
                {
                    "url": client.config["url"],
                    "device_key": "abr_device_temporary_test_key",
                    "capabilities": {"shell": True},
                }
            ).encode()
        ),
        timeout=10,
    )
    assert rebind.returncode == 0, error.decode()
    assert json.loads(output) == {"ok": True}
    rebound = json.loads((client.state_dir / "config.json").read_text())
    assert rebound["paused"] is True
    assert rebound["pause_reason"] == paused["pause_reason"]

    # A late automatic request cannot rewrite a known manual reason.
    ignored = await local_control(client.state_dir, {"command": "pause", "if_desktop_active": True})
    assert ignored["pause_ignored"] == "desktop_inactive"
    assert ignored["pause_reason"] == paused["pause_reason"]
    resumed = await local_control(client.state_dir, {"command": "resume"})
    assert resumed["paused"] is False
    assert resumed["pause_reason"] is None
    assert "pause_reason" not in json.loads((client.state_dir / "config.json").read_text())


async def test_close_before_executor_starts_clears_input_intent_and_takeover_marker(
    running_client: tuple[DeviceClient, "ControlledExecution"],
) -> None:
    client, execution = running_client
    await client._dispatch(dispatch("computer_act", "not_started", 1))
    # No scheduling point: close cancels this task before _execute can enter.
    await client._close_session("session_1")
    assert execution.release == {}
    assert client.operations == {}
    assert client.operation_capabilities == {}
    assert client.journal.get("not_started")["status"] == "outcome_unknown"
    assert status(client)["desktop_active_until"] == 0
    automatic = await local_control(client.state_dir, {"command": "pause", "if_desktop_active": True})
    assert automatic["paused"] is False
    assert automatic["pause_ignored"] == "desktop_inactive"


@pytest.mark.parametrize("action", ["pause", "resume"])
async def test_conditional_pause_cli_transmits_flag_only_for_pause(action: str) -> None:
    requests = []

    async def control(reader, writer):
        requests.append(json.loads(await reader.readline()))
        writer.write(b'{"ok":true}\n')
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    with tempfile.TemporaryDirectory(prefix="abridge-takeover-", dir="/tmp") as directory:
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
                action,
                "--if-desktop-active",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            output, error = await asyncio.wait_for(process.communicate(), timeout=10)
        assert error == b""
        if action == "pause":
            assert process.returncode == 0
            assert json.loads(output) == {"ok": True}
            assert requests == [{"command": "pause", "if_desktop_active": True}]
        else:
            assert process.returncode == 1
            assert requests == []
            assert "only available for pause" in json.loads(output)["error"]


@pytest.fixture
async def running_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    execution = ControlledExecution()
    executor = LocalExecutor()

    async def diagnostics():
        return {
            "driver": {"ready": True},
            "permissions": {"screen": True, "input": True},
            "browser": {"mode": "isolated", "ready": True},
        }

    monkeypatch.setattr(executor, "execute", execution.execute)
    monkeypatch.setattr(executor, "diagnostics", diagnostics)
    client = DeviceClient(
        tmp_path,
        {"url": "http://127.0.0.1:1", "paused": False, "capabilities": dict.fromkeys(CAPABILITIES, True)},
        "abr_device_not_used",
        executor=executor,
    )
    client.device_id = "device_1"
    client.epoch = 1
    client.server_capabilities = set(CAPABILITIES)

    async def wait_for_shutdown():
        await client.shutdown.wait()

    monkeypatch.setattr(client, "_reconnect_loop", wait_for_shutdown)
    running = asyncio.create_task(client.run())
    try:
        async with asyncio.timeout(2):
            while not hasattr(client, "socket_path") or not client.socket_path.exists():
                assert not running.done()
                await asyncio.sleep(0.01)
        yield client, execution
    finally:
        client.shutdown.set()
        await asyncio.wait_for(running, timeout=3)


class ControlledExecution:
    def __init__(self) -> None:
        self.release: dict[str, asyncio.Event] = {}
        self.failures: dict[str, ExecutionError] = {}

    async def execute(self, operation_id: str, tool: str, arguments: dict[str, Any], **kwargs):
        self.release[operation_id] = asyncio.Event()
        await self.release[operation_id].wait()
        if operation_id in self.failures:
            raise self.failures[operation_id]
        return {"ok": True}

    async def started(self, operation_id: str) -> None:
        async with asyncio.timeout(2):
            while operation_id not in self.release:
                await asyncio.sleep(0)


def dispatch(tool: str, operation_id: str, sequence: int) -> dict[str, Any]:
    return {
        "type": "dispatch",
        "protocol": "abridge/1",
        "device_id": "device_1",
        "connection_epoch": 1,
        "operation_id": operation_id,
        "session_id": "session_1",
        "session_capabilities": list(CAPABILITIES),
        "sequence": sequence,
        "expires_at": time.time() + 30,
        "tool": tool,
        "arguments": {},
    }


def status(client: DeviceClient) -> dict[str, Any]:
    return json.loads((client.state_dir / "status.json").read_text())


async def finish(client: DeviceClient, operation_id: str) -> None:
    await asyncio.wait_for(client.operations[operation_id], timeout=2)
