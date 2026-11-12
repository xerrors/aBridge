"""Official MCP Streamable HTTP transport over aBridge's authorization boundary."""

from __future__ import annotations

import base64
import json
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.fastmcp.utilities.types import Image
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import TextContent

from abridge.protocol import Capability
from abridge.runtime import BridgeError, Runtime


def create_mcp(runtime: Runtime) -> FastMCP:
    mcp = FastMCP(
        "aBridge",
        stateless_http=True,
        json_response=True,
        instructions="Choose device_id explicitly. Open a scoped session before execution. Refresh application/window inventory instead of reusing old PIDs or window IDs. Prefer an explicitly selected window; unavailable browser access is not permission to fall back to a whole-desktop screenshot. Images are returned as native MCP image blocks and do not require shell/files access. Never retry side effects with a new operation_id after an unknown outcome; observe first. Local pause and capability limits always apply.",
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
    async def session_open(device_id: str, capabilities: list[Capability], ctx: Context) -> dict[str, Any]:
        """Open a scoped session with a 5-minute idle lease, renewed by admitted tool requests and running operations. Expired sessions cannot be resumed. Observation references still expire after 10s. Input control is exclusive per desktop."""
        return guarded(lambda: runtime.open_session(agent(ctx), device_id, capabilities))

    @mcp.tool()
    async def session_close(session_id: str, ctx: Context) -> dict[str, Any]:
        """Close a session and request cancellation of its running operations."""
        return await guarded_async(runtime.close_session(agent(ctx), session_id))

    @mcp.tool(structured_output=False)
    async def computer_observe(
        session_id: str,
        ctx: Context,
        operation_id: str | None = None,
        pid: int | None = None,
        window_id: int | None = None,
        screenshot: bool = True,
    ) -> list[Any]:
        """Observe a Mac window's AX elements and optional native PNG image block; no shell or file permission is needed to receive the image. Choose exact pid/window_id from computer_apps/windows. Omitting both observes the current desktop and requires reliable foreground evidence; if focus_unavailable, choose an explicit window. Use its element_ref or reported coordinate_space within 10s; observations belong only to this session."""
        arguments = {"screenshot": screenshot}
        if pid is not None:
            arguments["pid"] = pid
        if window_id is not None:
            arguments["window_id"] = window_id
        response = await guarded_async(
            runtime.execute(agent(ctx), session_id, "computer_observe", arguments, operation_id)
        )
        return image_response(response)

    @mcp.tool()
    async def computer_apps(
        session_id: str, ctx: Context, operation_id: str | None = None, query: str | None = None
    ) -> dict[str, Any]:
        """List local application names and PIDs without reading windows. For a known app, pass query='Chrome' first to keep discovery focused. Query matches case-insensitive substrings of app name or bundle_id; omitted or empty query returns the complete list. Requires screen capability."""
        arguments = {} if query is None else {"query": query}
        return await guarded_async(
            runtime.execute(agent(ctx), session_id, "computer_apps", arguments, operation_id)
        )

    @mcp.tool()
    async def computer_windows(
        session_id: str, pid: int, ctx: Context, operation_id: str | None = None
    ) -> dict[str, Any]:
        """List windows for the explicitly selected application PID across available Spaces, including off-screen windows. An empty list does not establish a Space or permission problem; read its metadata and refresh computer_apps rather than reusing an old PID/window_id. Observe an exact returned window before acting."""
        return await guarded_async(
            runtime.execute(agent(ctx), session_id, "computer_windows", {"pid": pid}, operation_id)
        )

    @mcp.tool()
    async def computer_act(
        session_id: str,
        observation_id: str,
        action: dict[str, Any],
        ctx: Context,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        """Act on this session's observation within 10s. Use {type:'click',element_ref:'...'} or {type:'type',element_ref:'...',text:'你好'} for AX controls. Coordinates must match the observation's coordinate_space. Legacy examples: {type:'click',x:100,y:200}, {type:'type',text:'你好'}, {type:'key',key:'return',modifiers:['cmd']}. Observe again after each action; stale or cross-session refs are refused."""
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
    async def browser_open(
        session_id: str, url: str, ctx: Context, operation_id: str | None = None
    ) -> dict[str, Any]:
        """Open an HTTP(S) URL in the locally selected Chrome target. In existing_profile mode this navigates only the approved window's pinned active tab, reusing its login state; isolated mode creates a temporary profile. Requires browser capability and owner-local selection/approval. Agents cannot choose a profile, PID or path."""
        return await guarded_async(
            runtime.execute(agent(ctx), session_id, "browser_open", {"url": url}, operation_id)
        )

    @mcp.tool(structured_output=False)
    async def browser_observe(
        session_id: str, ctx: Context, screenshot: bool = False, operation_id: str | None = None
    ) -> list[Any]:
        """Read only this session's bound Chrome tab: DOM elements and optional PNG. Returned observation_id/element_ref expire after 10s and after any action. Call browser_open first. Existing-profile close detaches without closing personal tabs."""
        response = await guarded_async(
            runtime.execute(
                agent(ctx), session_id, "browser_observe", {"screenshot": screenshot}, operation_id
            )
        )
        return image_response(response)

    @mcp.tool()
    async def browser_act(
        session_id: str,
        observation_id: str,
        action: dict[str, Any],
        ctx: Context,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        """Act on this session's fresh DOM observation: {type:'click',element_ref:'...'} or {type:'fill',element_ref:'...',text:'你好'}. Click explicitly uses synthetic DOM events, not trusted physical input; sites may reject them. Fill replaces the field through the driver's insert_text route. Observe again to verify business state after every action. No JavaScript, raw CDP or Cookie export is exposed; existing login state stays inside the approved browser context."""
        return await guarded_async(
            runtime.execute(
                agent(ctx),
                session_id,
                "browser_act",
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


def image_response(response: dict[str, Any]) -> list[Any]:
    """Keep images as native MCP blocks, without embedding a second base64 copy in JSON."""
    result = response.get("result", {})
    encoded = result.get("image_base64") if isinstance(result, dict) else None
    if not encoded:
        return [response]
    metadata = {key: value for key, value in result.items() if key != "image_base64"}
    image_format = result.get("mime_type", "image/png").removeprefix("image/")
    return [
        TextContent(type="text", text=json.dumps({**response, "result": metadata}, ensure_ascii=False)),
        Image(data=base64.b64decode(encoded), format=image_format).to_image_content(),
    ]


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
