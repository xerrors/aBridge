"""Authorizes every operation and fences execution to one live connection."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from abridge.protocol import TOOL_CAPABILITIES as TOOL_CAPABILITY
from abridge.storage import CAPABILITIES, Store, identifier

FINAL_STATES = {"executed", "failed", "refused", "outcome_unknown", "cancelled"}
logger = logging.getLogger(__name__)


class BridgeError(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


@dataclass
class Connection:
    websocket: WebSocket
    epoch: int
    credential_version: int
    capabilities: dict[str, bool]
    paused: bool
    platform: str
    version: str
    heartbeat_at: float = field(default_factory=time.monotonic)
    sequence: int = 0
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, payload: dict[str, Any]) -> None:
        async with self.send_lock:
            await self.websocket.send_json(payload)


class Runtime:
    def __init__(self, store: Store):
        self.store = store
        self.connections: dict[str, Connection] = {}
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.results: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.result_sizes: dict[str, int] = {}
        self.cached_bytes = 0
        self.output: dict[str, dict[str, str]] = {}

    def devices(self, grant: dict[str, Any]) -> list[dict[str, Any]]:
        grant = self.active_grant(grant)
        return [
            self.device_view(device, grant)
            for device in self.store.devices(grant["owner_id"])
            if device["id"] in grant["device_ids"] and device["revoked_at"] is None
        ]

    def device_view(self, device: dict[str, Any], grant: dict[str, Any] | None = None) -> dict[str, Any]:
        connection = self.connections.get(device["id"])
        allowed = set(device["capabilities"]) & CAPABILITIES
        if grant:
            allowed.intersection_update(grant["capabilities"])
        available = {}
        for capability in sorted(allowed):
            available[capability] = bool(
                connection and connection.capabilities.get(capability) and not connection.paused
            )
        return {
            "id": device["id"],
            "name": device["name"],
            "status": "revoked" if device["revoked_at"] else "online" if connection else "offline",
            "paused": bool(connection and connection.paused),
            "capabilities": sorted(allowed),
            "available": available,
            "platform": "macOS" if not connection or connection.platform == "darwin" else connection.platform,
            "version": connection.version if connection else None,
            "last_seen": device["last_seen"],
            "created_at": device["created_at"],
            "active_operations": [
                operation_id
                for operation_id in self.pending
                if self.store.operation(operation_id)["device_id"] == device["id"]
            ],
        }

    def active_grant(self, grant: dict[str, Any]) -> dict[str, Any]:
        current = self.store.grant(grant["id"])
        if not current or current["revoked_at"] or current["expires_at"] <= time.time():
            raise BridgeError("unauthorized", "Agent 授权已撤销或到期", 401)
        return current

    def authorized_device(self, grant: dict[str, Any], device_id: str) -> dict[str, Any]:
        grant = self.active_grant(grant)
        device = self.store.device(device_id)
        if (
            not device
            or device["owner_id"] != grant["owner_id"]
            or device_id not in grant["device_ids"]
            or device["revoked_at"]
        ):
            raise BridgeError("not_found", "设备不存在或未获授权", 404)
        return device

    def open_session(self, grant: dict[str, Any], device_id: str, capabilities: list[str]) -> dict[str, Any]:
        grant = self.active_grant(grant)
        device = self.authorized_device(grant, device_id)
        if not capabilities or not set(capabilities) <= CAPABILITIES:
            raise BridgeError("invalid_capabilities", "至少选择一个有效能力", 422)
        if not set(capabilities) <= set(grant["capabilities"]) & set(device["capabilities"]):
            raise BridgeError("forbidden", "请求的能力未获授权", 403)
        connection = self.ready_connection(device_id)
        if not all(connection.capabilities.get(capability) for capability in capabilities):
            raise BridgeError("capability_unavailable", "本机能力未启用或系统权限不足")
        for session in self.store.sessions(device_id):
            if session["lease_until"] <= time.time():
                # The monitor owns expiry and cancels any remaining operations.
                continue
            elif "input" in capabilities and "input" in session["capabilities"]:
                raise BridgeError("desktop_busy", "桌面正在由另一个会话控制")
        session = self.store.create_session(grant["id"], device_id, capabilities, time.time() + 30)
        self.store.audit(grant["owner_id"], device_id, grant["id"], None, "session_open", "active")
        return session

    async def close_session(self, grant: dict[str, Any], session_id: str) -> dict[str, Any]:
        session = self.authorized_session(grant, session_id)
        await self.end_session(session, reason="会话已关闭")
        return {"session_id": session_id, "status": "stopped"}

    async def end_session(self, session: dict[str, Any], *, reason: str, status: str = "stopped") -> None:
        """Stop a session and cancel only the operations it owns."""
        self.store.close_session(session["id"], status)
        await self.cancel_operations(session["device_id"], session_id=session["id"], reason=reason)
        connection = self.connections.get(session["device_id"])
        if connection:
            try:
                await connection.send(
                    {
                        "type": "session_close",
                        "session_id": session["id"],
                        "connection_epoch": connection.epoch,
                        "reason": reason,
                    }
                )
            except (RuntimeError, OSError, WebSocketDisconnect):
                await self.disconnect(session["device_id"], connection)

    async def execute(
        self,
        grant: dict[str, Any],
        session_id: str,
        tool: str,
        arguments: dict[str, Any],
        operation_id: str | None = None,
        wait: bool = True,
    ) -> dict[str, Any]:
        grant = self.active_grant(grant)
        session = self.authorized_session(grant, session_id)
        device = self.authorized_device(grant, session["device_id"])
        capability = TOOL_CAPABILITY[tool]
        if (
            capability not in session["capabilities"]
            or capability not in grant["capabilities"]
            or capability not in device["capabilities"]
        ):
            raise BridgeError("forbidden", "此会话或授权未启用该能力", 403)
        request_hash = hashlib.sha256(
            json.dumps(
                {"tool": tool, "arguments": arguments, "session_id": session_id},
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        operation_id = operation_id or identifier("op")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", operation_id):
            raise BridgeError("invalid_operation_id", "operation_id 仅允许字母、数字、下划线和连字符", 422)
        previous = self.store.operation(operation_id)
        if previous:
            self.authorized_operation(grant, operation_id)
            if previous["request_hash"] != request_hash:
                raise BridgeError("operation_conflict", "相同 operation_id 的参数不能改变")
            return self.operation_status(grant, operation_id)
        connection = self.ready_connection(device["id"])
        if not connection.capabilities.get(capability):
            raise BridgeError("capability_unavailable", "本机能力未启用或系统权限不足")
        if (
            len(self.pending) >= 64
            or sum(self.store.operation(op)["device_id"] == device["id"] for op in self.pending) >= 8
        ):
            raise BridgeError("busy", "设备当前执行队列已满", 429)
        self.store.create_operation(
            operation_id,
            grant["owner_id"],
            grant["id"],
            device["id"],
            session_id,
            tool,
            request_hash,
            connection.epoch,
        )
        future = asyncio.get_running_loop().create_future()
        self.pending[operation_id] = future
        self.output[operation_id] = {"stdout": "", "stderr": ""}
        self.store.renew_session(session_id, time.time() + 30)
        connection.sequence += 1
        payload = {
            "type": "dispatch",
            "protocol": "abridge/1",
            "operation_id": operation_id,
            "session_id": session_id,
            "session_capabilities": session["capabilities"],
            "device_id": device["id"],
            "client_name": grant["name"],
            "connection_epoch": connection.epoch,
            "grant_version": device["credential_version"],
            "sequence": connection.sequence,
            "expires_at": time.time() + 30,
            "tool": tool,
            "arguments": arguments,
        }
        self.store.set_operation(operation_id, "dispatched")
        try:
            await connection.send(payload)
        except (RuntimeError, OSError, WebSocketDisconnect):
            self.finish(
                operation_id,
                "outcome_unknown",
                error={"code": "connection_lost", "message": "投递时连接断开，未自动重试"},
            )
        self.store.audit(
            grant["owner_id"],
            device["id"],
            grant["id"],
            operation_id,
            tool,
            self.store.operation(operation_id)["status"],
        )
        if not wait:
            return self.operation_status(grant, operation_id)
        try:
            async with asyncio.timeout(30):
                return await asyncio.shield(future)
        except TimeoutError:
            await self.cancel_operations(device["id"], operation_id=operation_id, reason="等待操作结果超时")
            self.finish(
                operation_id,
                "outcome_unknown",
                error={"code": "result_timeout", "message": "未取得执行回执，请重新观察核对"},
            )
            return self.operation_status(grant, operation_id)

    def operation_status(self, grant: dict[str, Any], operation_id: str) -> dict[str, Any]:
        operation = self.authorized_operation(grant, operation_id)
        if operation_id in self.results:
            return self.results[operation_id]
        response = {"operation_id": operation_id, "status": operation["status"]}
        if operation_id in self.output:
            response["output"] = self.output[operation_id]
        elif operation["status"] == "executed":
            response["result_available"] = False
            response["message"] = "执行已记录，临时结果已过期；不会重新执行"
        return response

    async def cancel_operation(self, grant: dict[str, Any], operation_id: str) -> dict[str, Any]:
        operation = self.authorized_operation(grant, operation_id)
        await self.cancel_operations(operation["device_id"], operation_id=operation_id, reason="调用方已取消")
        return {
            "operation_id": operation_id,
            "status": "cancel_requested" if operation_id in self.pending else operation["status"],
        }

    async def cancel_operations(
        self,
        device_id: str,
        *,
        grant_id: str | None = None,
        session_id: str | None = None,
        operation_id: str | None = None,
        reason: str,
    ) -> None:
        matching = []
        for pending_id in list(self.pending):
            operation = self.store.operation(pending_id)
            if operation["device_id"] != device_id:
                continue
            if grant_id and operation["grant_id"] != grant_id:
                continue
            if session_id and operation["session_id"] != session_id:
                continue
            if operation_id and pending_id != operation_id:
                continue
            matching.append(pending_id)
        connection = self.connections.get(device_id)
        if matching and connection:
            try:
                await connection.send({"type": "cancel", "operation_ids": matching, "reason": reason})
            except (RuntimeError, OSError, WebSocketDisconnect):
                for pending_id in matching:
                    self.finish(
                        pending_id, "outcome_unknown", error={"code": "connection_lost", "message": reason}
                    )

    async def stop_device(self, device_id: str, reason: str) -> None:
        for session in self.store.sessions(device_id):
            self.store.close_session(session["id"])
        await self.cancel_operations(device_id, reason=reason)
        connection = self.connections.get(device_id)
        if connection:
            try:
                await connection.send({"type": "stop", "reason": reason})
            except (RuntimeError, OSError, WebSocketDisconnect):
                await self.disconnect(device_id, connection)

    async def disable_capabilities(
        self, device_id: str, capabilities: set[str], *, reason: str = "本机能力已关闭"
    ) -> None:
        for session in self.store.sessions(device_id):
            if capabilities.intersection(session["capabilities"]):
                await self.end_session(session, reason=reason)

    async def disconnect(self, device_id: str, connection: Connection) -> None:
        is_current = self.connections.get(device_id) is connection
        if is_current:
            del self.connections[device_id]
        for operation_id in list(self.pending):
            operation = self.store.operation(operation_id)
            if operation["device_id"] == device_id and operation["epoch"] == connection.epoch:
                self.finish(
                    operation_id,
                    "outcome_unknown",
                    error={"code": "connection_lost", "message": "连接已断开，操作不会重放"},
                )
        if is_current:
            for session in self.store.sessions(device_id):
                self.store.close_session(session["id"], "expired")

    async def invalidate_device(self, device_id: str, reason: str) -> None:
        connection = self.connections.get(device_id)
        await self.stop_device(device_id, reason)
        if connection:
            try:
                await connection.send({"type": "revoke", "reason": reason})
                await connection.websocket.close(code=4403, reason=reason)
            except (RuntimeError, OSError, WebSocketDisconnect):
                logger.info("Device connection was already closed during invalidation: %s", device_id)
            finally:
                await self.disconnect(device_id, connection)

    async def receive(self, device_id: str, connection: Connection, message: dict[str, Any]) -> None:
        if (
            self.connections.get(device_id) is not connection
            or message.get("connection_epoch") != connection.epoch
        ):
            raise BridgeError("stale_connection", "连接代次已失效")
        device = self.store.device(device_id)
        if (
            not device
            or device["revoked_at"]
            or device["credential_version"] != connection.credential_version
        ):
            raise BridgeError("revoked", "设备凭据已失效")
        if message.get("type") == "local_stop":
            await self.stop_device(device_id, "本机已停止当前执行")
            return
        if message.get("type") == "browser_target_changed":
            await self.disable_capabilities(device_id, {"browser"}, reason="本机浏览器目标已更换")
            return
        if message.get("type") in {"heartbeat", "capabilities"}:
            was_paused = connection.paused
            old_capabilities = connection.capabilities
            connection.heartbeat_at = time.monotonic()
            capabilities = message.get("capabilities", old_capabilities)
            if not isinstance(capabilities, dict):
                raise BridgeError("invalid_message", "能力状态无效", 422)
            connection.capabilities = {cap: capabilities.get(cap) is True for cap in CAPABILITIES}
            connection.paused = message.get("paused", connection.paused) is True
            self.store.touch_device(device_id)
            disabled = {
                cap
                for cap, enabled in old_capabilities.items()
                if enabled and not connection.capabilities.get(cap)
            }
            if connection.paused and not was_paused:
                await self.stop_device(device_id, "本机暂停或能力已关闭")
            elif disabled:
                await self.disable_capabilities(device_id, disabled)
            await connection.send(
                {"type": "heartbeat_ack", "connection_epoch": connection.epoch, "lease_seconds": 30}
            )
            return
        operation_id = message.get("operation_id")
        operation = self.store.operation(operation_id) if isinstance(operation_id, str) else None
        if (
            not operation
            or operation["device_id"] != device_id
            or operation["epoch"] != connection.epoch
            or operation_id not in self.pending
        ):
            return
        if message.get("type") == "output":
            stream, data = message.get("stream"), message.get("data")
            if stream in {"stdout", "stderr"} and isinstance(data, str):
                self.output[operation_id][stream] = (self.output[operation_id][stream] + data)[-65536:]
        elif message.get("type") == "result":
            status = message.get("status")
            if status not in FINAL_STATES:
                raise BridgeError("invalid_result", "执行结果状态无效", 422)
            self.finish(operation_id, status, result=message.get("result"), error=message.get("error"))

    def finish(self, operation_id: str, status: str, result: Any = None, error: Any = None) -> None:
        if operation_id not in self.pending:
            return
        self.store.set_operation(operation_id, status)
        response = {"operation_id": operation_id, "status": status}
        if result is not None:
            response["result"] = result
        if error:
            response["error"] = error
        self.results[operation_id] = response
        self.result_sizes[operation_id] = len(json.dumps(response, ensure_ascii=False).encode())
        self.cached_bytes += self.result_sizes[operation_id]
        self.output.pop(operation_id, None)
        while len(self.results) > 128 or self.cached_bytes > 32 * 1024 * 1024:
            expired_id, _ = self.results.popitem(last=False)
            self.cached_bytes -= self.result_sizes.pop(expired_id)
        future = self.pending.pop(operation_id)
        if not future.done():
            future.set_result(response)
        operation = self.store.operation(operation_id)
        self.store.audit(
            operation["owner_id"],
            operation["device_id"],
            operation["grant_id"],
            operation_id,
            operation["tool"],
            status,
        )

    async def monitor(self) -> None:
        while True:
            await asyncio.sleep(1)
            for device_id, connection in list(self.connections.items()):
                device = self.store.device(device_id)
                if time.monotonic() - connection.heartbeat_at > 30:
                    try:
                        await connection.websocket.close(code=4408, reason="心跳超时")
                    except (RuntimeError, OSError, WebSocketDisconnect):
                        logger.info("Device connection was already closed on heartbeat expiry: %s", device_id)
                    await self.disconnect(device_id, connection)
                    continue
                if (
                    not device
                    or device["revoked_at"]
                    or device["credential_version"] != connection.credential_version
                ):
                    await self.invalidate_device(device_id, "设备凭据已失效")
                    continue
                for session in self.store.sessions(device_id):
                    grant = self.store.grant(session["grant_id"])
                    if not grant or grant["revoked_at"] or grant["expires_at"] <= time.time():
                        await self.end_session(session, reason="Agent 授权已失效", status="expired")
                    elif any(self.store.operation(op)["session_id"] == session["id"] for op in self.pending):
                        self.store.renew_session(session["id"], time.time() + 30)
                    elif session["lease_until"] <= time.time():
                        await self.end_session(session, reason="会话租约到期", status="expired")
            # Results can contain screenshots or file contents: retain only briefly in RAM.
            for operation_id in list(self.results):
                operation = self.store.operation(operation_id)
                if operation["finished_at"] and operation["finished_at"] < time.time() - 600:
                    self.results.pop(operation_id, None)
                    self.cached_bytes -= self.result_sizes.pop(operation_id)

    def authorized_session(self, grant: dict[str, Any], session_id: str) -> dict[str, Any]:
        self.active_grant(grant)
        session = self.store.session(session_id)
        if not session or session["grant_id"] != grant["id"]:
            raise BridgeError("not_found", "会话不存在或未获授权", 404)
        if session["status"] != "active" or session["lease_until"] <= time.time():
            raise BridgeError("session_expired", "会话已停止或租约到期，请建立新会话")
        return session

    def authorized_operation(self, grant: dict[str, Any], operation_id: str) -> dict[str, Any]:
        self.active_grant(grant)
        operation = self.store.operation(operation_id)
        if (
            not operation
            or operation["owner_id"] != grant["owner_id"]
            or operation["grant_id"] != grant["id"]
        ):
            raise BridgeError("not_found", "操作不存在或未获授权", 404)
        return operation

    def ready_connection(self, device_id: str) -> Connection:
        connection = self.connections.get(device_id)
        if not connection or time.monotonic() - connection.heartbeat_at > 30:
            raise BridgeError("device_offline", "设备离线，不会切换到其他设备")
        device = self.store.device(device_id)
        if (
            not device
            or device["revoked_at"]
            or device["credential_version"] != connection.credential_version
            or device["epoch"] != connection.epoch
        ):
            raise BridgeError("device_offline", "设备连接或凭据已失效")
        if connection.paused:
            raise BridgeError("device_paused", "本机已暂停，请在本机恢复")
        return connection
