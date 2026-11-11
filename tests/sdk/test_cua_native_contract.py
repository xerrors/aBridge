"""Optional fixed-wheel lifecycle check; never captures or opens a browser."""

import inspect
import json
import re
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
        assert re.fullmatch(r"__cua_runtime_[0-9a-f]{32}:", adapter._driver.runtime_scope_prefix())
        inventory = json.loads(await adapter._driver.list_tools_json())["tools"]
        click = next(tool for tool in inventory if tool["name"] == "browser_click")
        assert "dom_event" in click["inputSchema"]["properties"]["input_route"]["enum"]
        prepare = next(tool for tool in inventory if tool["name"] == "browser_prepare")
        properties = prepare["inputSchema"]["properties"]
        assert properties["strategy"]["properties"]["kind"]["enum"] == ["existing_profile"]
        assert properties["delivery_mode"]["default"] == "background"
        window_state = next(tool for tool in inventory if tool["name"] == "get_window_state")
        assert "elements" in window_state["inputSchema"]["properties"]["tree_format"]["enum"]
    finally:
        await adapter.shutdown()


@pytest.mark.skipif(not fixed_sdk_installed(), reason="The optional fixed macOS Cua wheel is not installed")
async def test_actual_generated_records_keep_apps_windows_ax_and_geometry():
    import cua_driver as sdk

    bounds = sdk.WindowBounds(x=10.0, y=20.0, width=640.0, height=560.0)
    app = sdk.AppInfo(
        pid=44,
        name="Fixture",
        running=True,
        active=False,
        bundle_id="dev.abridge.fixture",
        launch_path="/private/fixture",
        kind=None,
        last_used=None,
    )
    window = sdk.WindowInfo(
        window_id=99,
        pid=44,
        app_name="Fixture",
        title="测试窗口",
        bounds=bounds,
        is_on_screen=True,
        z_index=1,
        layer=0,
        minimized=False,
        current_space_id=None,
        on_current_space=True,
        space_ids=None,
    )
    element = generated_record(
        sdk.WindowElement,
        element_index=1,
        role="AXTextField",
        depth=0,
        element_token="s00000001:1",
        label="输入中文",
        enabled=True,
        actions=["AXSetValue"],
        frame=sdk.ElementFrame(x=10.0, y=20.0, w=100.0, h=20.0),
    )
    state = generated_record(
        sdk.WindowStateOutput,
        pid=44,
        window_id=99,
        app_name="Fixture",
        window_title="测试窗口",
        tree_markdown="- text field 输入中文",
        elements=[element],
        images=[],
        window_bounds=bounds,
        screenshot_width=640,
        screenshot_height=560,
        screenshot_scale=1.0,
        screenshot_file_path="/private/fixture.png",
    )

    class SyntheticDriver:
        def execution_mode(self):
            return sdk.DriverExecutionMode.EMBEDDED

        def socket_path(self):
            return ""

        async def start_session(self, request):
            return None

        async def list_apps(self, request):
            return sdk.ListAppsOutput(apps=[app])

        async def list_windows(self, request):
            return sdk.ListWindowsOutput(windows=[window], current_space_id=1)

        async def get_window_state(self, request):
            assert request.tree_format == "elements"
            return state

    adapter = CuaDriverAdapter(sdk=sdk, driver=SyntheticDriver())
    apps = await adapter.list_apps("synthetic")
    assert apps["apps"][0]["pid"] == 44
    assert "launch_path" not in apps["apps"][0]
    windows = await adapter.list_windows("synthetic", 44)
    assert windows["windows"][0]["window_id"] == 99
    assert windows["windows"][0]["bounds"]["width"] == 640.0
    observed = await adapter.computer_observe("synthetic", 44, 99, screenshot=False)
    assert observed["window_title"] == "测试窗口"
    assert observed["elements"][0]["element_ref"] == "s00000001:1"
    assert observed["elements"][0]["frame"]["w"] == 100.0
    assert observed["geometry"]["window_bounds"]["width"] == 640.0
    assert "screenshot_file_path" not in observed
    assert "images" not in observed


def generated_record(record_type, **values):
    arguments = dict.fromkeys(inspect.signature(record_type).parameters)
    arguments.update(values)
    return record_type(**arguments)
