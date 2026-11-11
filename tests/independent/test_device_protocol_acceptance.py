"""Drive the real device client through a separate WebSocket peer and local socket."""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import pytest
import websockets

from abridge.client import DeviceClient, local_control
from abridge.executor import LocalExecutor


@pytest.mark.parametrize("status_code", [401, 403])
async def test_handshake_auth_rejection_revokes_without_losing_local_controls(
    tmp_path: Path, status_code: int
) -> None:
    requests = []

    async def reject(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readuntil(b"\r\n\r\n")
        requests.append(status_code)
        reason = "Unauthorized" if status_code == 401 else "Forbidden"
        writer.write(
            f"HTTP/1.1 {status_code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode()
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    async with await asyncio.start_server(reject, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        client = DeviceClient(
            tmp_path,
            {"url": f"http://127.0.0.1:{port}", "capabilities": {}, "paused": False},
            "abr_device_auth_rejection_fixture",
        )
        running = asyncio.create_task(client.run())
        try:
            async with asyncio.timeout(3):
                while client.status["connection"] != "revoked":
                    assert not running.done(), "An authentication refusal crashed the client"
                    await asyncio.sleep(0.01)
            assert client.config["revoked"] is True
            assert requests == [status_code]
            assert (await local_control(tmp_path, {"command": "status"}))["connection"] == "revoked"
        finally:
            client.shutdown.set()
            await asyncio.wait_for(running, timeout=5)


async def test_device_reports_effective_capabilities_and_persists_deduplication(tmp_path: Path) -> None:
    marker = tmp_path / "once.txt"
    arguments = {"command": f"printf x >> {shlex.quote(str(marker))}", "cwd": str(tmp_path)}
    async with device_peer(tmp_path / "device") as peer:
        assert peer.hello["capabilities"] == {
            "screen": False,
            "input": False,
            "shell": True,
            "files": True,
            "browser": False,
        }
        first = await peer.call("once", "command_execute", arguments)
        assert first["status"] == "executed"
        assert marker.read_text() == "x"
        again = await peer.call("once", "command_execute", arguments)
        assert again["result"]["deduplicated"] is True
        assert marker.read_text() == "x"
        changed = await peer.call("once", "command_execute", {"command": "printf changed"})
        assert changed["status"] == "refused"
        assert changed["error"]["code"] == "idempotency_conflict"

    async with device_peer(tmp_path / "device") as restarted:
        replay = await restarted.call("once", "command_execute", arguments)
        assert replay["result"]["deduplicated"] is True
        assert marker.read_text() == "x"


async def test_local_pause_stops_child_and_survives_reconnection(tmp_path: Path) -> None:
    state_dir = tmp_path / "device"
    child_pid_file = tmp_path / "pause-child.pid"
    command = f"sleep 60 & child=$!; printf '%s' \"$child\" > {shlex.quote(str(child_pid_file))}; wait"
    async with device_peer(state_dir) as peer:
        await peer.dispatch("pause-running", "command_execute", {"command": command, "timeout": 20})
        await wait_for_file(child_pid_file)
        pid = int(child_pid_file.read_text())
        paused = await local_control(state_dir, {"command": "pause"})
        assert paused["ok"] is True
        assert paused["paused"] is True
        result = await peer.result("pause-running")
        assert result["status"] == "outcome_unknown", result
        await wait_for_exit(pid)
        refused = await peer.call(
            "paused-write", "file_write", {"path": str(tmp_path / "blocked"), "content": "wrong"}
        )
        assert refused["error"]["code"] == "device_paused"
        assert not (tmp_path / "blocked").exists()

    async with device_peer(state_dir) as restarted:
        assert restarted.hello["paused"] is True
        refused = await restarted.call("paused-restart", "command_execute", {"command": "printf wrong"})
        assert refused["error"]["code"] == "device_paused"
        resumed = await local_control(state_dir, {"command": "resume"})
        assert resumed["paused"] is False
        new_call = await restarted.call("resumed", "command_execute", {"command": "printf resumed"})
        assert new_call["result"]["stdout"] == "resumed"


async def test_capability_disable_and_disconnect_terminate_children(tmp_path: Path) -> None:
    state_dir = tmp_path / "device"
    async with device_peer(state_dir) as peer:
        child_pid_file = tmp_path / "cap-child.pid"
        command = f"sleep 60 & child=$!; printf '%s' \"$child\" > {shlex.quote(str(child_pid_file))}; wait"
        await peer.dispatch("cap-running", "command_execute", {"command": command, "timeout": 20})
        await wait_for_file(child_pid_file)
        pid = int(child_pid_file.read_text())
        disabled = await local_control(
            state_dir, {"command": "capability", "capability": "shell", "enabled": False}
        )
        assert disabled["capabilities"]["shell"] is False
        result = await peer.result("cap-running")
        assert result["status"] == "outcome_unknown", result
        await wait_for_exit(pid)
        refused = await peer.call("shell-disabled", "command_execute", {"command": "printf wrong"})
        assert refused["error"]["code"] == "capability_disabled"
        await local_control(state_dir, {"command": "capability", "capability": "shell", "enabled": True})

        disconnect_pid_file = tmp_path / "disconnect-child.pid"
        command = (
            f"sleep 60 & child=$!; printf '%s' \"$child\" > {shlex.quote(str(disconnect_pid_file))}; wait"
        )
        await peer.dispatch("disconnect-running", "command_execute", {"command": command, "timeout": 20})
        await wait_for_file(disconnect_pid_file)
        disconnect_pid = int(disconnect_pid_file.read_text())
        await peer.connection.close()
        await wait_for_exit(disconnect_pid)
        async with asyncio.timeout(4):
            await peer.connections.get()
        assert (await local_control(state_dir, {"command": "status"}))["active_operations"] == []


async def test_device_fences_old_epoch_and_expired_dispatch(tmp_path: Path) -> None:
    async with device_peer(tmp_path / "device") as peer:
        marker = tmp_path / "should-not-exist"
        arguments = {"path": str(marker), "content": "wrong"}
        await peer.dispatch("old-epoch", "file_write", arguments, connection_epoch=-1)
        assert (await peer.result("old-epoch"))["error"]["code"] == "connection_mismatch"
        await peer.dispatch("expired", "file_write", arguments, expires_at=time.time() - 1)
        assert (await peer.result("expired"))["error"]["code"] == "operation_expired"
        assert not marker.exists()


async def test_running_command_streams_output_before_it_exits(tmp_path: Path) -> None:
    async with device_peer(tmp_path / "device") as peer:
        await peer.dispatch(
            "streaming",
            "command_execute",
            {
                "command": "printf early; sleep 2; printf late",
                "timeout": 5,
            },
        )
        async with asyncio.timeout(1):
            while True:
                response = await peer.responses.get()
                if response.get("type") == "output":
                    assert response["stream"] == "stdout"
                    assert response["data"] == "early"
                    break
                assert response.get("type") != "result", "Command exited before emitting output"
        result = await peer.result("streaming")
        assert result["status"] == "executed"
        assert result["result"]["stdout"] == "earlylate"


class DevicePeer:
    def __init__(self) -> None:
        self.connection: Any = None
        self.hello: dict[str, Any] = {}
        self.epoch = 0
        self.sequence = 0
        self.connections: asyncio.Queue[Any] = asyncio.Queue()
        self.responses: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def accept(self, websocket: Any) -> None:
        self.connection = websocket
        self.epoch += 1
        self.hello = json.loads(await websocket.recv())
        await websocket.send(
            json.dumps(
                {
                    "type": "welcome",
                    "protocol": "abridge/1",
                    "device_id": "dev_acceptance",
                    "connection_epoch": self.epoch,
                    "owner_name": "acceptance",
                    "capabilities": ["screen", "input", "shell", "files", "browser"],
                    "heartbeat_interval": 1,
                    "lease_seconds": 5,
                }
            )
        )
        await self.connections.put(websocket)
        async for raw in websocket:
            message = json.loads(raw)
            if message["type"] == "heartbeat":
                await websocket.send(json.dumps({"type": "heartbeat_ack", "connection_epoch": self.epoch}))
            else:
                await self.responses.put(message)

    async def dispatch(
        self, operation_id: str, tool: str, arguments: dict[str, Any], **overrides: Any
    ) -> None:
        self.sequence += 1
        message = {
            "type": "dispatch",
            "protocol": "abridge/1",
            "operation_id": operation_id,
            "device_id": "dev_acceptance",
            "connection_epoch": self.epoch,
            "sequence": self.sequence,
            "expires_at": time.time() + 20,
            "tool": tool,
            "arguments": arguments,
        }
        message.update(overrides)
        await self.connection.send(json.dumps(message))

    async def call(
        self, operation_id: str, tool: str, arguments: dict[str, Any], **overrides: Any
    ) -> dict[str, Any]:
        await self.dispatch(operation_id, tool, arguments, **overrides)
        return await self.result(operation_id)

    async def result(self, operation_id: str) -> dict[str, Any]:
        async with asyncio.timeout(5):
            while True:
                response = await self.responses.get()
                if response.get("type") == "result" and response.get("operation_id") == operation_id:
                    return response


@asynccontextmanager
async def device_peer(
    state_dir: Path,
    *,
    executor: LocalExecutor | None = None,
    capabilities: dict[str, bool] | None = None,
) -> AsyncIterator[DevicePeer]:
    peer = DevicePeer()
    async with websockets.serve(peer.accept, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        saved_config = state_dir / "config.json"
        config = (
            json.loads(saved_config.read_text())
            if saved_config.exists()
            else {
                "url": f"http://127.0.0.1:{port}",
                "capabilities": {"screen": False, "input": False, "shell": True, "files": True},
                "paused": False,
                "revoked": False,
            }
        )
        config["url"] = f"http://127.0.0.1:{port}"
        if capabilities is not None:
            config["capabilities"] = capabilities
        client = DeviceClient(state_dir, config, "abr_device_acceptance", executor=executor)
        running = asyncio.create_task(client.run())
        try:
            async with asyncio.timeout(4):
                await peer.connections.get()
                while not (state_dir / "status.json").exists():
                    await asyncio.sleep(0.01)
            yield peer
        finally:
            client.shutdown.set()
            if peer.connection is not None:
                await peer.connection.close()
            await asyncio.wait_for(running, timeout=5)


async def wait_for_file(path: Path) -> None:
    async with asyncio.timeout(3):
        while not path.exists() or not path.read_text():
            await asyncio.sleep(0.02)


async def wait_for_exit(pid: int) -> None:
    async with asyncio.timeout(3):
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            await asyncio.sleep(0.02)
