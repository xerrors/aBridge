"""Public capability contracts must describe executable device features only."""

import time
from pathlib import Path

import httpx
import pytest

from abridge.client import CAPABILITIES as CLIENT_CAPABILITIES
from abridge.executor import TOOL_CAPABILITIES
from abridge.mcp_gateway import create_mcp
from abridge.runtime import TOOL_CAPABILITY as SERVER_TOOL_CAPABILITIES
from abridge.runtime import BridgeError, Connection, Runtime
from abridge.server import create_app
from abridge.storage import CAPABILITIES, Store


async def test_management_rejects_unimplemented_capabilities(tmp_path: Path) -> None:
    app = create_app(tmp_path / "server.db")
    store = app.state.store
    store.create_user("owner", "owner-password-123")
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as account:
            assert (
                await account.post("/api/login", json={"username": "owner", "password": "owner-password-123"})
            ).status_code == 200
            refused = await account.post(
                "/api/devices", json={"name": "unsupported", "capabilities": ["browser"]}
            )
            assert refused.status_code == 422
            created = await account.post(
                "/api/devices", json={"name": "Mac", "capabilities": ["screen", "input"]}
            )
            assert created.status_code == 201
            device = created.json()
            refused = await account.patch(
                f"/api/devices/{device['id']}", json={"name": "Mac", "capabilities": ["browser"]}
            )
            assert refused.status_code == 422
            refused = await account.post(
                "/api/client-grants",
                json={"name": "unsupported", "device_ids": [device["id"]], "capabilities": ["browser"]},
            )
            assert refused.status_code == 422
            assert (await account.get("/api/devices")).json()["devices"][0]["capabilities"] == [
                "input",
                "screen",
            ]
    finally:
        store.close()


async def test_public_views_hide_unimplemented_legacy_metadata(tmp_path: Path) -> None:
    app = create_app(tmp_path / "server.db")
    store = app.state.store
    owner = store.create_user("owner", "owner-password-123")
    # Store accepts trusted internal records; simulate metadata left by an unshipped experiment.
    device, _ = store.create_device(owner["id"], "Mac", ["screen", "browser"])
    store.create_grant(owner["id"], "Agent", [device["id"]], ["screen", "browser"], time.time() + 600)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as account:
            await account.post("/api/login", json={"username": "owner", "password": "owner-password-123"})
            assert (await account.get("/api/devices")).json()["devices"][0]["capabilities"] == ["screen"]
            assert (await account.get("/api/client-grants")).json()["grants"][0]["capabilities"] == ["screen"]
    finally:
        store.close()


async def test_mcp_and_device_share_the_implemented_capability_contract(tmp_path: Path) -> None:
    store = Store(tmp_path / "server.db")
    try:
        owner = store.create_user("owner", "owner-password-123")
        device, _ = store.create_device(owner["id"], "Mac", ["screen", "input"])
        grant, _ = store.create_grant(
            owner["id"], "Agent", [device["id"]], ["screen", "input"], time.time() + 600
        )
        runtime = Runtime(store)
        runtime.connections[device["id"]] = Connection(
            None, store.next_epoch(device["id"]), 1, {"screen": True, "input": True}, False, "darwin", "test"
        )
        with pytest.raises(BridgeError) as refused:
            runtime.open_session(grant, device["id"], ["browser"])
        assert refused.value.code == "invalid_capabilities"

        tools = {tool.name: tool for tool in await create_mcp(runtime).list_tools()}
        assert len(tools) == 12
        assert not any(name.startswith("browser_") for name in tools)
        schema = tools["session_open"].inputSchema["properties"]["capabilities"]["items"]
        assert set(schema["enum"]) == CAPABILITIES == set(CLIENT_CAPABILITIES)
        assert SERVER_TOOL_CAPABILITIES == TOOL_CAPABILITIES
    finally:
        store.close()
