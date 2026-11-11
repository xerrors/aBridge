"""Outbound device connection and local, owner-only controls."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
import sys
import time
from contextlib import suppress
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

from abridge import __version__
from abridge.executor import TOOL_CAPABILITIES, ExecutionError, LocalExecutor, native_request

CAPABILITIES = ("screen", "input", "shell", "files")
DEFAULT_STATE_DIR = Path.home() / "Library" / "Application Support" / "aBridge"
KEYCHAIN_SERVICE = "dev.abridge.client.device"


class DeviceClient:
    """Own one device identity, its connection, and all in-flight local work."""

    def __init__(
        self,
        state_dir: Path,
        config: dict[str, Any],
        device_key: str,
        helper: str | None = None,
        parent_pid: int | None = None,
    ) -> None:
        self.state_dir = state_dir
        self.config = config
        self.device_key = device_key
        self.parent_pid = parent_pid
        self.executor = LocalExecutor(helper)
        self.executor.on_output = self._output
        self.websocket: Any = None
        self.epoch = 0
        self.device_id: str | None = None
        self.server_capabilities: set[str] = set()
        self.operations: dict[str, asyncio.Task[None]] = {}
        self.operation_capabilities: dict[str, str] = {}
        self.operation_controllers: dict[str, str] = {}
        self.last_sequence = 0
        self.last_ack = 0.0
        self.lease_seconds = 30.0
        self.send_lock = asyncio.Lock()
        self.shutdown = asyncio.Event()
        self.unbound = asyncio.Event()
        self.status = {
            "connection": "offline",
            "paused": bool(config.get("paused", False)),
            "capabilities": {},
            "permissions": {"screen": False, "input": False},
            "active_operations": [],
            "url": config["url"],
        }
        self.journal = OperationJournal(state_dir / "operations.sqlite3")

    async def run(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        socket_path = self.state_dir / "control.sock"
        if len(str(socket_path).encode()) >= 100:
            socket_path = Path("/tmp") / (
                "abridge-" + hashlib.sha256(str(self.state_dir).encode()).hexdigest()[:20] + ".sock"
            )
        self.socket_path = socket_path
        # Refuse a second daemon; never unlink another running client's control socket.
        if socket_path.exists():
            try:
                reader, writer = await asyncio.open_unix_connection(str(socket_path))
            except (ConnectionRefusedError, FileNotFoundError):
                socket_path.unlink(missing_ok=True)
            else:
                writer.close()
                await writer.wait_closed()
                raise RuntimeError("The aBridge device client is already running")
        server = await asyncio.start_unix_server(self._control_connection, path=str(socket_path))
        os.chmod(socket_path, 0o600)
        self._write_status()
        try:
            async with server:
                connection_task = asyncio.create_task(self._reconnect_loop())
                parent_task = asyncio.create_task(self._watch_parent())
                try:
                    done, _ = await asyncio.wait(
                        (connection_task, parent_task), return_when=asyncio.FIRST_COMPLETED
                    )
                    for task in done:
                        task.result()
                finally:
                    connection_task.cancel()
                    parent_task.cancel()
                    await asyncio.gather(connection_task, parent_task, return_exceptions=True)
        finally:
            await self._stop_operations()
            self.status["connection"] = "offline"
            self._write_status()
            socket_path.unlink(missing_ok=True)
            self.journal.close()

    async def _watch_parent(self) -> None:
        if self.parent_pid is None:
            await self.shutdown.wait()
            return
        while not self.shutdown.is_set():
            if os.getppid() != self.parent_pid:
                self.shutdown.set()
                return
            await asyncio.sleep(0.5)

    async def _reconnect_loop(self) -> None:
        delay = 1.0
        while not self.shutdown.is_set() and not self.config.get("revoked", False):
            self.status.update(connection="connecting", error=None)
            self._write_status()
            try:
                await self._connect()
                delay = 1.0
            except InvalidStatus as error:
                if error.response.status_code in (401, 403):
                    self.config["revoked"] = True
                    save_config(self.state_dir, self.config)
                    self.status.update(connection="revoked", error="设备 Key 已失效，请重新连接")
                    self._write_status()
                    break
                self.status.update(connection="offline", error="服务暂时不可用")
            except (OSError, ConnectionClosed, TimeoutError, ExecutionError, ValueError):
                self.status.update(connection="offline", error="连接中断，等待重连")
            finally:
                self.websocket = None
                await self._stop_operations()
                self._write_status()
            try:
                await asyncio.wait_for(self.shutdown.wait(), timeout=delay)
            except TimeoutError:
                delay = min(delay * 2, 15)
        # A revoked device still accepts local status/unbind commands.
        if not self.shutdown.is_set():
            await self.shutdown.wait()

    async def _connect(self) -> None:
        url = self.config["url"]
        parsed = urlsplit(url)
        websocket_url = urlunsplit(
            (
                "wss" if parsed.scheme == "https" else "ws",
                parsed.netloc,
                parsed.path.rstrip("/") + "/ws/device",
                "",
                "",
            )
        )
        capabilities = await self._effective_capabilities()
        async with websockets.connect(
            websocket_url,
            additional_headers={"Authorization": "Bearer " + self.device_key},
            max_size=8_388_608,
            ping_interval=10,
            ping_timeout=10,
            open_timeout=10,
            close_timeout=3,
        ) as websocket:
            self.websocket = websocket
            await self._send(
                {
                    "type": "hello",
                    "protocol": "abridge/1",
                    "platform": sys.platform,
                    "version": __version__,
                    "capabilities": capabilities,
                    "paused": bool(self.config.get("paused", False)),
                }
            )
            welcome = json.loads(await asyncio.wait_for(websocket.recv(), timeout=10))
            if welcome.get("type") != "welcome" or welcome.get("protocol") != "abridge/1":
                raise ValueError("Unexpected device protocol")
            self.epoch = int(welcome["connection_epoch"])
            self.device_id = str(welcome["device_id"])
            self.last_sequence = 0
            self.last_ack = time.monotonic()
            self.lease_seconds = min(float(welcome.get("lease_seconds", 30)), 30)
            granted = welcome.get("capabilities", [])
            if isinstance(granted, dict):
                granted = [key for key, value in granted.items() if value]
            self.server_capabilities = set(granted)
            self.status.update(
                connection="online",
                device_id=self.device_id,
                owner_name=welcome.get("owner_name", ""),
                error=None,
            )
            self._write_status()
            receive_task = asyncio.create_task(self._receive())
            heartbeat_task = asyncio.create_task(
                self._heartbeat(float(welcome.get("heartbeat_interval", 10)))
            )
            lease_task = asyncio.create_task(self._watch_lease())
            shutdown_task = asyncio.create_task(self.shutdown.wait())
            tasks = (receive_task, heartbeat_task, lease_task, shutdown_task)
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _receive(self) -> None:
        async for raw_message in self.websocket:
            message = json.loads(raw_message)
            kind = message.get("type")
            if kind == "heartbeat_ack":
                if message.get("connection_epoch", self.epoch) == self.epoch:
                    self.last_ack = time.monotonic()
            elif kind == "dispatch":
                await self._dispatch(message)
            elif kind == "cancel":
                await self._stop_operations(message.get("operation_ids"))
            elif kind == "stop":
                await self._stop_operations()
            elif kind == "revoke":
                self.config["revoked"] = True
                save_config(self.state_dir, self.config)
                self.status.update(connection="revoked", error="设备已解绑或凭据已撤销")
                await self._stop_operations()
                self._write_status()
                self.unbound.set()
                return

    async def _heartbeat(self, interval: float) -> None:
        while True:
            await asyncio.sleep(min(max(interval, 1), 10))
            capabilities = await self._effective_capabilities()
            await self._send(
                {
                    "type": "heartbeat",
                    "connection_epoch": self.epoch,
                    "capabilities": capabilities,
                    "paused": bool(self.config.get("paused", False)),
                }
            )
            self._write_status()

    async def _watch_lease(self) -> None:
        while True:
            await asyncio.sleep(1)
            if time.monotonic() - self.last_ack > self.lease_seconds:
                await self._stop_operations()
                raise TimeoutError("Device connection lease expired")

    async def _dispatch(self, message: dict[str, Any]) -> None:
        operation_id = message.get("operation_id")
        if not isinstance(operation_id, str) or len(operation_id) > 128:
            raise ValueError("Invalid operation identity")
        try:
            if (
                message.get("protocol") != "abridge/1"
                or message.get("device_id") != self.device_id
                or message.get("connection_epoch") != self.epoch
            ):
                raise ExecutionError(
                    "connection_mismatch", "The operation belongs to another device connection"
                )
            expires_at = message.get("expires_at")
            if not isinstance(expires_at, (int, float)) or not time.time() < expires_at <= time.time() + 35:
                raise ExecutionError("operation_expired", "The operation start deadline expired")
            tool = message.get("tool")
            arguments = message.get("arguments")
            if tool not in TOOL_CAPABILITIES or not isinstance(arguments, dict):
                raise ExecutionError("invalid_arguments", "Invalid device tool or arguments")
            request_hash = hashlib.sha256(
                json.dumps(
                    {"tool": tool, "arguments": arguments}, sort_keys=True, separators=(",", ":")
                ).encode()
            ).hexdigest()
            prior = self.journal.get(operation_id)
            if prior is not None:
                if prior["request_hash"] != request_hash:
                    raise ExecutionError(
                        "idempotency_conflict", "An operation ID cannot be reused with different arguments"
                    )
                status = prior["status"]
                if status == "executing":
                    status = "outcome_unknown"
                await self._result(operation_id, status, {"deduplicated": True, "prior_status": status})
                return
            sequence = message.get("sequence")
            if not isinstance(sequence, int) or sequence <= self.last_sequence:
                raise ExecutionError("sequence_mismatch", "Stale operation sequence")
            self.last_sequence = sequence
            if self.config.get("paused", False):
                raise ExecutionError("device_paused", "Resume access locally before running a new operation")
            capability = TOOL_CAPABILITIES[tool]
            capabilities = await self._effective_capabilities()
            if not capabilities[capability] or capability not in self.server_capabilities:
                raise ExecutionError(
                    "capability_disabled", "The requested capability is unavailable or disabled locally"
                )
            if len(self.operations) >= 8:
                raise ExecutionError("device_busy", "The device has reached its concurrent operation limit")
            self.journal.start(operation_id, request_hash)
            if capability in ("screen", "input"):
                self.status["desktop_active_until"] = time.time() + 30
            self.operation_capabilities[operation_id] = capability
            self.operation_controllers[operation_id] = message.get("client_name", "Agent")
            self.operations[operation_id] = asyncio.create_task(self._execute(operation_id, tool, arguments))
            self._write_status()
        except ExecutionError as error:
            await self._result(operation_id, "refused", {}, error)

    async def _execute(self, operation_id: str, tool: str, arguments: dict[str, Any]) -> None:
        status = "executed"
        result: dict[str, Any] = {}
        error: ExecutionError | None = None
        try:
            result = await self.executor.execute(operation_id, tool, arguments)
        except asyncio.CancelledError:
            status = "outcome_unknown"
            error = ExecutionError(
                "operation_cancelled", "Execution was stopped; existing side effects were not rolled back"
            )
        except ExecutionError as execution_error:
            status = "refused"
            error = execution_error
        except (OSError, ValueError, TypeError) as execution_error:
            status = "failed"
            error = ExecutionError("execution_failed", str(execution_error))
        finally:
            self.journal.finish(operation_id, status)
            self.operations.pop(operation_id, None)
            self.operation_capabilities.pop(operation_id, None)
            self.operation_controllers.pop(operation_id, None)
            self._write_status()
        with suppress(ConnectionClosed, OSError):
            await self._result(operation_id, status, result, error)

    async def _result(
        self, operation_id: str, status: str, result: dict[str, Any], error: ExecutionError | None = None
    ) -> None:
        message: dict[str, Any] = {
            "type": "result",
            "operation_id": operation_id,
            "connection_epoch": self.epoch,
            "status": status,
            "result": result,
        }
        if error is not None:
            message["error"] = {"code": error.code, "message": str(error)}
        await self._send(message)

    async def _output(self, operation_id: str, stream: str, data: str) -> None:
        with suppress(ConnectionClosed):
            await self._send(
                {
                    "type": "output",
                    "operation_id": operation_id,
                    "connection_epoch": self.epoch,
                    "stream": stream,
                    "data": data,
                }
            )

    async def _send(self, message: dict[str, Any]) -> None:
        if self.websocket is None:
            return
        async with self.send_lock:
            await self.websocket.send(json.dumps(message, ensure_ascii=False))

    async def _stop_operations(self, operation_ids: list[str] | None = None) -> None:
        selected = list(self.operations) if operation_ids is None else list(operation_ids)
        # Cancel tasks before waiting on process cleanup to stop subsequent steps.
        tasks = [
            self.operations[operation_id] for operation_id in selected if operation_id in self.operations
        ]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # command_execute owns its process cleanup. Do not race two killpg calls
        # against the same process group while cancellation is unwinding.
        await self.executor.cancel(selected)
        self.executor.observations.clear()
        if operation_ids is None:
            self.status["desktop_active_until"] = 0
        self._write_status()

    async def _effective_capabilities(self) -> dict[str, bool]:
        permissions = await self.executor.permissions()
        requested = self.config.get("capabilities", {})
        effective = {key: requested.get(key) is True for key in CAPABILITIES}
        effective["screen"] = effective["screen"] and permissions["screen"]
        effective["input"] = effective["input"] and permissions["input"]
        self.status.update(capabilities=effective, permissions=permissions)
        return effective

    async def _control_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw = await asyncio.wait_for(reader.readline(), timeout=3)
            if len(raw) > 8192:
                raise ValueError("Control message is too large")
            request = json.loads(raw)
            command = request.get("command")
            if command == "pause":
                self.config["paused"] = True
                save_config(self.state_dir, self.config)
                await self._stop_operations()
            elif command == "resume":
                self.config["paused"] = False
                save_config(self.state_dir, self.config)
            elif command == "stop":
                await self._stop_operations()
            elif command == "capability":
                capability = request.get("capability")
                enabled = request.get("enabled")
                if capability not in CAPABILITIES or not isinstance(enabled, bool):
                    raise ValueError("Invalid capability setting")
                self.config["capabilities"][capability] = enabled
                save_config(self.state_dir, self.config)
                if not enabled:
                    selected = [
                        key for key, value in self.operation_capabilities.items() if value == capability
                    ]
                    await self._stop_operations(selected)
            elif command == "unbind":
                self.config["paused"] = True
                self.config["revoked"] = True
                save_config(self.state_dir, self.config)
                await self._stop_operations()
                cloud_revoked = False
                if self.websocket:
                    await self._send({"type": "unbind", "connection_epoch": self.epoch})
                    with suppress(TimeoutError):
                        await asyncio.wait_for(self.unbound.wait(), timeout=5)
                        cloud_revoked = True
                self.status["cloud_revoked"] = cloud_revoked
                if not cloud_revoked:
                    self.status["error"] = "已移除本机凭据；请在管理台撤销设备 Key"
                if self.executor.helper:
                    await native_request(
                        self.executor.helper,
                        {
                            "action": "keychain_delete",
                            "service": KEYCHAIN_SERVICE,
                            "account": keychain_account(self.config["url"]),
                        },
                    )
                self.device_key = ""
                self.shutdown.set()
                if self.websocket:
                    await self.websocket.close()
            elif command != "status":
                raise ValueError("Unknown local control command")
            self.status["paused"] = bool(self.config.get("paused", False))
            await self._effective_capabilities()
            self._write_status()
            if self.websocket and command in ("pause", "resume", "capability"):
                await self._send(
                    {
                        "type": "heartbeat",
                        "connection_epoch": self.epoch,
                        "capabilities": self.status["capabilities"],
                        "paused": self.status["paused"],
                    }
                )
            response = {"ok": True, **self.status}
        except (ValueError, ExecutionError, OSError, TimeoutError, ConnectionClosed) as error:
            response = {"ok": False, "error": str(error)}
        writer.write((json.dumps(response, ensure_ascii=False) + "\n").encode())
        await writer.drain()
        writer.close()
        await writer.wait_closed()

    def _write_status(self) -> None:
        self.status["paused"] = bool(self.config.get("paused", False))
        self.status["active_operations"] = list(self.operations)
        self.status["active_controllers"] = list(dict.fromkeys(self.operation_controllers.values()))
        self.status["requested_capabilities"] = self.config.get("capabilities", {})
        self.status["updated_at"] = time.time()
        _write_json(self.state_dir / "status.json", self.status)


class OperationJournal:
    """Persist execution intent before side effects, without screenshot/text payloads."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.connection = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, status TEXT NOT NULL, updated_at REAL NOT NULL)"
        )
        self.connection.execute("UPDATE operations SET status = 'outcome_unknown' WHERE status = 'executing'")
        self.connection.commit()

    def get(self, operation_id: str) -> dict[str, str] | None:
        row = self.connection.execute(
            "SELECT request_hash, status FROM operations WHERE id = ?", (operation_id,)
        ).fetchone()
        return {"request_hash": row[0], "status": row[1]} if row else None

    def start(self, operation_id: str, request_hash: str) -> None:
        self.connection.execute(
            "INSERT INTO operations VALUES (?, ?, 'executing', ?)", (operation_id, request_hash, time.time())
        )
        self.connection.commit()

    def finish(self, operation_id: str, status: str) -> None:
        self.connection.execute(
            "UPDATE operations SET status = ?, updated_at = ? WHERE id = ?",
            (status, time.time(), operation_id),
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()


def validate_server_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise ValueError("Use a service URL without credentials, query parameters or fragments")
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
    ):
        raise ValueError("Use HTTPS, or HTTP through a localhost SSH tunnel")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def save_config(state_dir: Path, config: dict[str, Any]) -> None:
    _write_json(state_dir / "config.json", config)


def keychain_account(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()


async def local_control(state_dir: Path, request: dict[str, Any]) -> dict[str, Any]:
    socket_path = state_dir / "control.sock"
    if len(str(socket_path).encode()) >= 100:
        socket_path = Path("/tmp") / (
            "abridge-" + hashlib.sha256(str(state_dir).encode()).hexdigest()[:20] + ".sock"
        )
    reader, writer = await asyncio.open_unix_connection(str(socket_path))
    writer.write((json.dumps(request) + "\n").encode())
    await writer.drain()
    response = json.loads(await asyncio.wait_for(reader.readline(), timeout=15))
    writer.close()
    await writer.wait_closed()
    return response


def main() -> None:
    parser = argparse.ArgumentParser(description="aBridge device client")
    parser.add_argument(
        "--state-dir", type=Path, default=Path(os.environ.get("ABRIDGE_CLIENT_STATE", DEFAULT_STATE_DIR))
    )
    parser.add_argument("--helper", default=os.environ.get("ABRIDGE_DESKTOP_HELPER"))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("run")
    configure = commands.add_parser("configure")
    configure.add_argument("--stdin", action="store_true", required=True)
    control = commands.add_parser("control")
    control.add_argument("action", choices=("status", "pause", "resume", "stop", "unbind", "capability"))
    control.add_argument("--capability", choices=CAPABILITIES)
    control.add_argument("--enabled", choices=("true", "false"))
    args = parser.parse_args()
    try:
        asyncio.run(_main(args))
    except (ValueError, OSError, ExecutionError, RuntimeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        raise SystemExit(1) from None


async def _main(args: argparse.Namespace) -> None:
    if args.command == "configure":
        if not args.helper:
            raise ValueError("The native Keychain helper is required")
        request = json.load(sys.stdin)
        url = validate_server_url(str(request.get("url", "")))
        key = request.get("device_key")
        if not isinstance(key, str) or not key or key.startswith("abr_agent_"):
            raise ValueError("Use a Device Key")
        capabilities = request.get("capabilities", {})
        if not isinstance(capabilities, dict) or any(
            key not in CAPABILITIES or not isinstance(value, bool) for key, value in capabilities.items()
        ):
            raise ValueError("Capabilities must be explicitly selected")
        await native_request(
            args.helper,
            {
                "action": "keychain_set",
                "service": KEYCHAIN_SERVICE,
                "account": keychain_account(url),
                "secret": key,
            },
        )
        config = {
            "url": url,
            "capabilities": {key: capabilities.get(key, False) for key in CAPABILITIES},
            "paused": False,
            "revoked": False,
        }
        save_config(args.state_dir, config)
        print(json.dumps({"ok": True}))
        return
    if args.command == "control":
        request: dict[str, Any] = {"command": args.action}
        if args.action == "capability":
            if args.capability is None or args.enabled is None:
                raise ValueError("capability and enabled are required")
            request.update(capability=args.capability, enabled=args.enabled == "true")
        print(json.dumps(await local_control(args.state_dir, request), ensure_ascii=False))
        return
    config = json.loads((args.state_dir / "config.json").read_text())
    config["url"] = validate_server_url(config["url"])
    if not args.helper:
        raise ValueError("The native Keychain helper is required")
    credential = await native_request(
        args.helper,
        {"action": "keychain_get", "service": KEYCHAIN_SERVICE, "account": keychain_account(config["url"])},
    )
    expected_parent = os.environ.get("ABRIDGE_PARENT_PID")
    parent_pid = int(expected_parent) if expected_parent is not None else None
    client = DeviceClient(args.state_dir, config, credential["secret"], args.helper, parent_pid=parent_pid)
    loop = asyncio.get_running_loop()
    import signal

    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, client.shutdown.set)
    await client.run()


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, ensure_ascii=False)
    temporary.replace(path)


if __name__ == "__main__":
    main()
