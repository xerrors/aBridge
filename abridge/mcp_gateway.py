"""Official MCP Streamable HTTP transport over aBridge's authorization boundary."""

from __future__ import annotations

from typing import Any, Literal

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.fastmcp.utilities.types import Image
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import TextContent

from abridge.runtime import BridgeError, Runtime


def create_mcp(runtime: Runtime) -> FastMCP:
    mcp = FastMCP(
        "aBridge",
        stateless_http=True,
        json_response=True,
        instructions="Choose device_id explicitly. Open a scoped session before execution. Never retry side effects with a new operation_id after an unknown outcome; observe first. Local pause and capability limits always apply.",
        transport_security=TransportSecuritySettings(
            allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*", "testserver"],
            allowed_origins=["http://127.0.0.1:*", "http://localhost:*"],
        ),
    )

    @mcp.tool()
    async def devices_list(ctx: Context) -> dict[str, Any]:
        """List only devices and capabilities accessible to this Agent Key."""
        return {"devices": runtime.devices(agent(ctx))}

    @mcp.tool()
    async def device_get(device_id: str, ctx: Context) -> dict[str, Any]:
        """Get an explicitly selected device's connection and capability state."""
        grant = agent(ctx)
        return runtime.device_view(runtime.authorized_device(grant, device_id), grant)

    @mcp.tool()
    async def session_open(
        device_id: str, capabilities: list[Literal["screen", "input", "shell", "files"]], ctx: Context
    ) -> dict[str, Any]:
        """Open a 30-second scoped session. Input control is exclusive per desktop."""
        return guarded(lambda: runtime.open_session(agent(ctx), device_id, capabilities))

    @mcp.tool()
    async def session_close(session_id: str, ctx: Context) -> dict[str, Any]:
        """Close a session and request cancellation of its running operations."""
        return await guarded_async(runtime.close_session(agent(ctx), session_id))

    @mcp.tool(structured_output=False)
    async def computer_observe(session_id: str, ctx: Context, operation_id: str | None = None) -> list[Any]:
        """Capture the Mac screen, window and display coordinate metadata. Input requires its observation_id within expires_in (10s)."""
        response = await guarded_async(
            runtime.execute(agent(ctx), session_id, "computer_observe", {}, operation_id)
        )
        result = response.get("result", {})
        encoded = result.get("image_base64") if isinstance(result, dict) else None
        if encoded:
            import base64
            import json

            metadata = {key: value for key, value in result.items() if key != "image_base64"}
            return [
                TextContent(
                    type="text", text=json.dumps({**response, "result": metadata}, ensure_ascii=False)
                ),
                Image(data=base64.b64decode(encoded), format="png").to_image_content(),
            ]
        return [response]

    @mcp.tool()
    async def computer_act(
        session_id: str,
        observation_id: str,
        action: dict[str, Any],
        ctx: Context,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        """Act on an observation less than 10s old. action examples: {type:'click',x:100,y:200}, {type:'type',text:'你好'}, {type:'key',key:'return',modifiers:['cmd']}, {type:'scroll',delta_y:-3}, {type:'drag',x:100,y:100,to_x:300,to_y:200}. Coordinates are pixels in the observed screenshot; the Mac converts these to global logical points. Types: click,double_click,move,drag,scroll,key,type."""
        return await guarded_async(
            runtime.execute(
                agent(ctx),
                session_id,
                "computer_act",
                {"observation_id": observation_id, "action": action},
                operation_id,
            )
        )

    @mcp.tool()
    async def command_execute(
        session_id: str,
        command: str,
        ctx: Context,
        cwd: str | None = None,
        timeout: float = 30,
        env: dict[str, str] | None = None,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        """Start a user-level shell command (1–120s); poll command_status for output and exit state."""
        if not command.strip() or len(command) > 65536 or not 1 <= timeout <= 120:
            raise ToolError("invalid_arguments: command must be nonempty and timeout must be 1–120 seconds")
        arguments: dict[str, Any] = {"command": command, "timeout": timeout}
        if cwd is not None:
            arguments["cwd"] = cwd
        if env is not None:
            arguments["env"] = env
        return await guarded_async(
            runtime.execute(agent(ctx), session_id, "command_execute", arguments, operation_id, wait=False)
        )

    @mcp.tool()
    async def command_status(operation_id: str, ctx: Context) -> dict[str, Any]:
        """Read this grant's operation status and bounded output. Results expire after ten minutes."""
        return guarded(lambda: runtime.operation_status(agent(ctx), operation_id))

    @mcp.tool()
    async def command_cancel(operation_id: str, ctx: Context) -> dict[str, Any]:
        """Request cancellation and process-tree termination; poll status for the final acknowledgement."""
        return await guarded_async(runtime.cancel_operation(agent(ctx), operation_id))

    @mcp.tool()
    async def files_list(
        session_id: str, path: str, ctx: Context, limit: int = 200, operation_id: str | None = None
    ) -> dict[str, Any]:
        """List up to 500 entries readable by the current macOS user."""
        if not 1 <= limit <= 500:
            raise ToolError("invalid_arguments: limit must be 1–500")
        return await guarded_async(
            runtime.execute(
                agent(ctx), session_id, "files_list", {"path": path, "limit": limit}, operation_id
            )
        )

    @mcp.tool()
    async def file_read(
        session_id: str, path: str, ctx: Context, max_bytes: int = 1048576, operation_id: str | None = None
    ) -> dict[str, Any]:
        """Read UTF-8 text, bounded to 1 MiB and current OS file permissions."""
        if not 1 <= max_bytes <= 1048576:
            raise ToolError("invalid_arguments: max_bytes must be 1–1048576")
        return await guarded_async(
            runtime.execute(
                agent(ctx), session_id, "file_read", {"path": path, "max_bytes": max_bytes}, operation_id
            )
        )

    @mcp.tool()
    async def file_write(
        session_id: str,
        path: str,
        content: str,
        ctx: Context,
        overwrite: bool = False,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        """Write UTF-8 text up to 1 MiB. Existing files are refused unless overwrite=true."""
        if len(content.encode()) > 1048576:
            raise ToolError("invalid_arguments: content exceeds 1 MiB")
        return await guarded_async(
            runtime.execute(
                agent(ctx),
                session_id,
                "file_write",
                {"path": path, "content": content, "overwrite": overwrite},
                operation_id,
            )
        )

    def agent(ctx: Context) -> dict[str, Any]:
        request = ctx.request_context.request
        header = request.headers.get("authorization", "") if request else ""
        token = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
        grant = runtime.store.authenticate_agent(token)
        if not grant:
            raise ToolError("unauthorized: Agent Key is invalid, expired, or revoked")
        return grant

    return mcp


def guarded(action: Any) -> Any:
    try:
        return action()
    except BridgeError as error:
        raise ToolError(f"{error.code}: {error.message}") from error


async def guarded_async(action: Any) -> Any:
    try:
        return await action
    except BridgeError as error:
        raise ToolError(f"{error.code}: {error.message}") from error
