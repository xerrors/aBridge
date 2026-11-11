"""Optional fixed-wheel lifecycle check; never captures or opens a browser."""

import json
import sys
from importlib import metadata

import pytest

from abridge.cua_driver import CUA_VERSION, CuaDriverAdapter


def fixed_sdk_installed():
    if sys.platform != "darwin":
        return False
    try:
        return metadata.version("cua-driver") == CUA_VERSION
    except metadata.PackageNotFoundError:
        return False


@pytest.mark.skipif(not fixed_sdk_installed(), reason="The optional fixed macOS Cua wheel is not installed")
async def test_actual_wheel_initializes_embedded_and_shuts_down():
    adapter = CuaDriverAdapter()
    try:
        diagnostics = await adapter.diagnostics()
        assert diagnostics["driver"]["loaded"] is True, diagnostics
        assert diagnostics["driver"]["version"] == CUA_VERSION
        assert diagnostics["driver"]["execution_mode"] == "embedded"
        # This public SDK inventory is metadata, not user desktop/browser state.
        assert adapter._driver.socket_path() == ""
        inventory = json.loads(await adapter._driver.list_tools_json())["tools"]
        click = next(tool for tool in inventory if tool["name"] == "browser_click")
        assert "dom_event" in click["inputSchema"]["properties"]["input_route"]["enum"]
    finally:
        await adapter.shutdown()
