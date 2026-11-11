"""Single-process management API, MCP gateway and outbound device router."""

import asyncio
import contextlib
import json
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from abridge import __version__
from abridge.mcp_gateway import create_mcp
from abridge.runtime import BridgeError, Connection, Runtime
from abridge.storage import CAPABILITIES, Store

STATIC = Path(__file__).parent / "static"
SESSION_COOKIE = "abridge_session"


def create_app(db_path: str | Path | None = None) -> FastAPI:
    store = Store(db_path or os.environ.get("ABRIDGE_DB", "~/.local/share/abridge/server.db"))
    runtime = Runtime(store)
    mcp = create_mcp(runtime)
    mcp_app = mcp.streamable_http_app()
    login_attempts: dict[str, deque[float]] = defaultdict(deque)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        store.recover_after_restart()
        async with mcp.session_manager.run():
            monitor = asyncio.create_task(runtime.monitor())
            try:
                yield
            finally:
                monitor.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await monitor
                for device_id, connection in list(runtime.connections.items()):
                    with contextlib.suppress(RuntimeError, OSError):
                        await connection.websocket.close(code=1012, reason="服务正在重启")
                    await runtime.disconnect(device_id, connection)
                store.close()

    application = FastAPI(
        title="aBridge", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None
    )
    application.state.store = store
    application.state.runtime = runtime

    @application.exception_handler(BridgeError)
    async def bridge_error(_request: Request, error: BridgeError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": error.code, "message": error.message}}, status_code=error.status
        )

    @application.middleware("http")
    async def boundaries(request: Request, call_next: Any) -> Response:
        origin = request.headers.get("origin")
        expected_origin = f"{request.url.scheme}://{request.headers.get('host')}"
        if origin and origin != expected_origin:
            return JSONResponse(
                {"error": {"code": "origin_rejected", "message": "请求来源不匹配"}}, status_code=403
            )
        content_length = request.headers.get("content-length")
        if content_length and (not content_length.isdigit() or int(content_length) > 2 * 1024 * 1024):
            return JSONResponse({"error": {"code": "body_too_large", "message": "请求过大"}}, status_code=413)
        if request.url.path == "/mcp" or request.url.path.startswith("/mcp/"):
            header = request.headers.get("authorization", "")
            token = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
            if not store.authenticate_agent(token):
                return JSONResponse(
                    {"error": {"code": "unauthorized", "message": "Agent Key 无效或已失效"}},
                    status_code=401,
                    headers={"WWW-Authenticate": 'Bearer realm="aBridge"'},
                )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api") or request.url.path.startswith("/mcp"):
            response.headers["Cache-Control"] = "no-store"
        return response

    async def account(request: Request) -> dict[str, Any]:
        # Keep this short SQLite lookup on the ASGI loop, like every other Store call.
        # A synchronous dependency is dispatched into FastAPI's worker thread pool.
        user = store.account(request.cookies.get(SESSION_COOKIE, ""))
        if not user:
            raise BridgeError("unauthorized", "请先登录", 401)
        return user

    User = Annotated[dict[str, Any], Depends(account)]

    def owned_device(device_id: str, user: dict[str, Any]) -> dict[str, Any]:
        device = store.device(device_id)
        if not device or device["owner_id"] != user["id"]:
            raise BridgeError("not_found", "设备不存在", 404)
        return device

    @application.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "version": __version__}

    @application.post("/api/login")
    async def login(data: LoginInput, request: Request) -> JSONResponse:
        address = request.client.host if request.client else "unknown"
        attempts = login_attempts[address]
        now = time.monotonic()
        while attempts and attempts[0] < now - 60:
            attempts.popleft()
        if len(attempts) >= 10:
            raise BridgeError("rate_limited", "登录尝试过多，请稍后重试", 429)
        attempts.append(now)
        result = store.login(data.username, data.password)
        if not result:
            raise BridgeError("invalid_login", "账户或密码不正确", 401)
        user, token = result
        response = JSONResponse(user)
        response.set_cookie(
            SESSION_COOKIE,
            token,
            max_age=12 * 3600,
            httponly=True,
            secure=request.url.scheme == "https",
            samesite="strict",
            path="/",
        )
        return response

    @application.post("/api/logout")
    async def logout(request: Request, user: User) -> Response:
        store.logout(request.cookies.get(SESSION_COOKIE, ""))
        response = JSONResponse({"status": "logged_out"})
        response.delete_cookie(SESSION_COOKIE)
        return response

    @application.get("/api/me")
    async def me(user: User) -> dict[str, Any]:
        return user

    @application.get("/api/devices")
    async def devices(user: User) -> dict[str, Any]:
        return {"devices": [runtime.device_view(device) for device in store.devices(user["id"])]}

    @application.post("/api/devices", status_code=201)
    async def add_device(data: DeviceInput, user: User) -> dict[str, Any]:
        device, key = store.create_device(user["id"], data.name, data.capabilities)
        return {**runtime.device_view(device), "key": key}

    @application.patch("/api/devices/{device_id}")
    async def update_device(device_id: str, data: DeviceInput, user: User) -> dict[str, Any]:
        device = owned_device(device_id, user)
        if device["revoked_at"]:
            raise BridgeError("revoked", "设备已解绑")
        removed = set(device["capabilities"]) - set(data.capabilities)
        store.update_device(device_id, data.name, data.capabilities)
        if removed:
            await runtime.disable_capabilities(device_id, removed)
        store.audit(user["id"], device_id, None, None, "device_update", "changed")
        return runtime.device_view(store.device(device_id))

    @application.post("/api/devices/{device_id}/stop")
    async def stop_device(device_id: str, user: User) -> dict[str, str]:
        owned_device(device_id, user)
        await runtime.stop_device(device_id, "设备所有者已停止当前执行")
        store.audit(user["id"], device_id, None, None, "device_stop", "cancel_requested")
        return {"status": "cancel_requested"}

    @application.post("/api/devices/{device_id}/revoke")
    async def revoke_device(device_id: str, user: User) -> dict[str, str]:
        owned_device(device_id, user)
        store.revoke_device(device_id)
        await runtime.invalidate_device(device_id, "设备已解除绑定")
        store.audit(user["id"], device_id, None, None, "device_revoke", "revoked")
        return {"status": "revoked"}

    @application.post("/api/devices/{device_id}/credentials")
    async def rotate_device(device_id: str, user: User) -> dict[str, str]:
        device = owned_device(device_id, user)
        if device["revoked_at"]:
            raise BridgeError("revoked", "设备已解绑")
        key = store.rotate_device(device_id)
        await runtime.invalidate_device(device_id, "设备 Key 已轮换，请使用新 Key 连接")
        store.audit(user["id"], device_id, None, None, "device_key_rotate", "changed")
        return {"id": device_id, "key": key}

    @application.get("/api/client-grants")
    async def grants(user: User) -> dict[str, Any]:
        return {"grants": [public_grant(grant) for grant in store.grants(user["id"])]}

    @application.post("/api/client-grants", status_code=201)
    async def add_grant(data: GrantInput, user: User) -> dict[str, Any]:
        for device_id in data.device_ids:
            device = owned_device(device_id, user)
            if device["revoked_at"]:
                raise BridgeError("revoked", "不能授权已解绑的设备")
        expires_at = data.expires_at or time.time() + 30 * 86400
        if expires_at <= time.time() or expires_at > time.time() + 366 * 86400:
            raise BridgeError("invalid_expiry", "到期时间需在一年内", 422)
        grant, key = store.create_grant(user["id"], data.name, data.device_ids, data.capabilities, expires_at)
        return {**public_grant(grant), "key": key}

    @application.post("/api/client-grants/{grant_id}/revoke")
    async def revoke_grant(grant_id: str, user: User) -> dict[str, str]:
        grant = store.grant(grant_id)
        if not grant or grant["owner_id"] != user["id"]:
            raise BridgeError("not_found", "Agent 授权不存在", 404)
        store.revoke_grant(grant_id)
        for device_id in grant["device_ids"]:
            await runtime.cancel_operations(device_id, grant_id=grant_id, reason="Agent 授权已撤销")
            for session in store.sessions(device_id):
                if session["grant_id"] == grant_id:
                    await runtime.end_session(session, reason="Agent 授权已撤销")
        store.audit(user["id"], None, grant_id, None, "client_grant_revoke", "revoked")
        return {"status": "revoked"}

    @application.get("/api/activity")
    async def activity(user: User) -> dict[str, Any]:
        return {"operations": store.operations(user["id"]), "events": store.audit_events(user["id"])}

    @application.websocket("/ws/device")
    async def device_socket(websocket: WebSocket) -> None:
        header = websocket.headers.get("authorization", "")
        key = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
        device = store.authenticate_device(key)
        if not device:
            await websocket.close(code=4401, reason="设备 Key 无效或已失效")
            return
        origin = websocket.headers.get("origin")
        if origin:
            await websocket.close(code=4403, reason="设备连接不接受浏览器来源")
            return
        await websocket.accept()
        connection: Connection | None = None
        try:
            async with asyncio.timeout(10):
                hello = await websocket.receive_json()
            if (
                not isinstance(hello, dict)
                or hello.get("type") != "hello"
                or not isinstance(hello.get("capabilities"), dict)
            ):
                await websocket.close(code=4400, reason="需要有效 hello 消息")
                return
            # A key may be rotated while the peer is preparing its hello.
            authenticated = store.authenticate_device(key)
            if not authenticated:
                await websocket.close(code=4403, reason="设备凭据已失效")
                return
            device = authenticated
            old = runtime.connections.get(device["id"])
            if old:
                await runtime.stop_device(device["id"], "设备连接已被新连接替换")
                await old.websocket.close(code=4409, reason="新连接代次")
                await runtime.disconnect(device["id"], old)
            epoch = store.next_epoch(device["id"])
            connection = Connection(
                websocket,
                epoch,
                device["credential_version"],
                {cap: hello["capabilities"].get(cap) is True for cap in CAPABILITIES},
                hello.get("paused") is True,
                str(hello.get("platform", "macOS"))[:80],
                str(hello.get("version", "unknown"))[:30],
            )
            runtime.connections[device["id"]] = connection
            owner = store.user(device["owner_id"])
            await connection.send(
                {
                    "type": "welcome",
                    "protocol": "abridge/1",
                    "device_id": device["id"],
                    "owner_name": owner["username"],
                    "connection_epoch": epoch,
                    "capabilities": device["capabilities"],
                    "heartbeat_interval": 10,
                    "lease_seconds": 30,
                }
            )
            while True:
                async with asyncio.timeout(35):
                    raw = await websocket.receive_text()
                if len(raw) > 8 * 1024 * 1024:
                    raise BridgeError("message_too_large", "设备消息超过限制", 413)
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise BridgeError("invalid_message", "设备消息无效", 422)
                current_device = store.device(device["id"])
                if (
                    runtime.connections.get(device["id"]) is not connection
                    or message.get("connection_epoch") != connection.epoch
                    or not current_device
                    or current_device["revoked_at"]
                    or current_device["credential_version"] != connection.credential_version
                ):
                    raise BridgeError("stale_connection", "设备连接或凭据已失效")
                if message.get("type") == "unbind":
                    store.revoke_device(device["id"])
                    await runtime.invalidate_device(device["id"], "本机已解除绑定")
                    store.audit(
                        device["owner_id"], device["id"], None, None, "device_unbind_local", "revoked"
                    )
                    break
                await runtime.receive(device["id"], connection, message)
        except (WebSocketDisconnect, TimeoutError):
            pass
        except (BridgeError, json.JSONDecodeError, ValueError):
            with contextlib.suppress(RuntimeError, OSError):
                await websocket.close(code=4400, reason="设备消息或连接无效")
        finally:
            if connection:
                await runtime.disconnect(device["id"], connection)

    @application.get("/")
    async def index() -> FileResponse:
        return FileResponse(
            STATIC / "index.html",
            headers={
                "Cache-Control": "no-cache",
                "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
            },
        )

    application.mount("/static", StaticFiles(directory=STATIC), name="static")
    application.mount("/", mcp_app)
    return application


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginInput(StrictInput):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=1024)


class DeviceInput(StrictInput):
    name: str = Field(min_length=1, max_length=80)
    capabilities: list[str] = Field(min_length=1, max_length=len(CAPABILITIES))

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("名称不能为空")
        return value.strip()

    @field_validator("capabilities")
    @classmethod
    def known_capabilities(cls, value: list[str]) -> list[str]:
        if not set(value) <= CAPABILITIES or len(value) != len(set(value)):
            raise ValueError("能力无效或重复")
        return value


class GrantInput(DeviceInput):
    device_ids: list[str] = Field(min_length=1, max_length=100)
    expires_at: float | None = Field(default=None, allow_inf_nan=False)

    @field_validator("device_ids")
    @classmethod
    def unique_devices(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("设备不能重复")
        return value


def public_grant(grant: dict[str, Any]) -> dict[str, Any]:
    public = {key: value for key, value in grant.items() if key not in {"token_digest", "owner_id"}}
    public["capabilities"] = [
        capability for capability in grant["capabilities"] if capability in CAPABILITIES
    ]
    return public


app = create_app()
