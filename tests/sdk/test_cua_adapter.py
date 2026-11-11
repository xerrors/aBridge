"""Portable adapter checks; no desktop, browser, account or native library is used."""

import asyncio
import json
from dataclasses import dataclass
from enum import Enum
from types import SimpleNamespace

import pytest

from abridge.cua_driver import CUA_VERSION, CuaDriverAdapter, CuaError


async def test_window_elements_are_session_bound_and_consumed_after_action():
    adapter, driver = make_adapter()
    observed = await adapter.computer_observe("session-a", 44, 99, screenshot=False)
    ref = observed["elements"][0]["element_ref"]
    assert ref == "s00000001:1"
    assert observed["coordinate_space"] == "screenshot_pixels"
    with pytest.raises(CuaError, match="Observe") as error:
        await adapter.computer_act(
            "session-b", observed["observation_id"], {"type": "click", "element_ref": ref}
        )
    assert error.value.code == "stale_observation"
    assert len(driver.started) == 1
    await adapter.computer_act("session-a", observed["observation_id"], {"type": "click", "element_ref": ref})
    tool, arguments = driver.calls[-1]
    assert tool == "click"
    assert arguments["target"] == {"kind": "window", "pid": 44, "window_id": 99}
    assert arguments["element_token"] == ref
    with pytest.raises(CuaError) as error:
        await adapter.computer_act(
            "session-a", observed["observation_id"], {"type": "click", "element_ref": ref}
        )
    assert error.value.code == "stale_observation"


async def test_no_observation_does_not_load_driver():
    adapter = CuaDriverAdapter()
    with pytest.raises(CuaError) as error:
        await adapter.computer_act("missing", "unknown", {"type": "click", "x": 1, "y": 2})
    assert error.value.code == "stale_observation"
    with pytest.raises(CuaError) as error:
        await adapter.browser_observe("missing")
    assert error.value.code == "browser_not_open"
    assert adapter._driver is None


async def test_expired_observation_refuses_before_native_dispatch(monkeypatch):
    adapter, driver = make_adapter()
    observed = await adapter.computer_observe("one", 44, 99, screenshot=False)
    prior_calls = len(driver.calls)
    monkeypatch.setattr("abridge.cua_driver.time.monotonic", lambda: 10**12)
    with pytest.raises(CuaError) as error:
        await adapter.computer_act("one", observed["observation_id"], {"type": "type", "text": "不应输入"})
    assert error.value.code == "stale_observation"
    assert len(driver.calls) == prior_calls


@pytest.mark.parametrize("change", ["pid", "title", "window"])
async def test_desktop_focus_change_refuses_before_native_input(change):
    adapter, driver = make_adapter()
    observed = await adapter.computer_observe("one", screenshot=False)
    if change == "pid":
        driver.focus_pid = 55
    elif change == "title":
        driver.focus_title = "另一文稿"
    else:
        driver.focus_window = 123
    with pytest.raises(CuaError) as error:
        await adapter.computer_act("one", observed["observation_id"], {"type": "type", "text": "不应输入"})
    assert error.value.code == "focus_changed"
    assert not any(tool == "type_text" for tool, _ in driver.calls)


async def test_desktop_capture_checks_focus_before_and_after_screenshot():
    adapter, driver = make_adapter()
    driver.change_during_capture = True
    with pytest.raises(CuaError) as error:
        await adapter.computer_observe("one", screenshot=False)
    assert error.value.code == "focus_changed"
    assert adapter._sessions["one"].observation is None


async def test_unknown_window_stacking_does_not_capture_or_guess_by_array_order():
    adapter, driver = make_adapter()
    driver.z_index = None
    with pytest.raises(CuaError) as error:
        await adapter.computer_observe("one", screenshot=False)
    assert error.value.code == "focus_unavailable"
    assert driver.captures == 0


async def test_explicit_window_action_keeps_original_target_when_user_changes_app():
    adapter, driver = make_adapter()
    observed = await adapter.computer_observe("one", 44, 99, screenshot=False)
    driver.focus_pid = 55
    await adapter.computer_act("one", observed["observation_id"], {"type": "type", "text": "指定窗口"})
    assert driver.calls[-1][1]["target"] == {"kind": "window", "pid": 44, "window_id": 99}


async def test_desktop_pixels_keep_capture_binding_and_do_not_double_scale():
    adapter, driver = make_adapter()
    observed = await adapter.computer_observe("one", screenshot=False)
    await adapter.computer_act("one", observed["observation_id"], {"type": "click", "x": 80, "y": 40})
    arguments = driver.calls[-1][1]
    assert arguments["x"] == 80
    assert arguments["y"] == 40
    assert arguments["capture_id"] == "capture-owned"


async def test_browser_isolated_ownership_and_literal_unicode_fill():
    adapter, driver = make_adapter()
    observed = await adapter.browser_open("browser-session", "https://example.com/form")
    prepare = next(arguments for tool, arguments in driver.calls if tool == "browser_prepare")
    assert prepare == {
        "session": driver.started[0],
        "profile": {"mode": "isolated_new"},
        "allow_launch": True,
    }
    literal = '你好 "); __import__("os").system("should-never-run")'
    await adapter.browser_act(
        "browser-session",
        observed["observation_id"],
        {"type": "fill", "element_ref": "p3:7", "text": literal, "target_id": "other-user-target"},
    )
    tool, arguments = driver.calls[-1]
    assert tool == "browser_type"
    assert arguments["text"] == literal
    assert arguments["replace"] is True
    assert arguments["target_id"] == "owned-target"
    assert arguments["tab_id"] == "owned-tab"
    assert not any(tool in {"page", "run_script", "clipboard_read"} for tool, _ in driver.calls)


@pytest.mark.parametrize(
    "url",
    ["file:///tmp/a", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com:bad"],
)
async def test_unsafe_browser_url_does_not_create_session(url):
    adapter, driver = make_adapter()
    with pytest.raises(CuaError) as error:
        await adapter.browser_open("one", url)
    assert error.value.code == "invalid_arguments"
    assert driver.started == []


async def test_browser_reopen_reuses_owned_target_without_launching_again():
    adapter, driver = make_adapter()
    await adapter.browser_open("one", "https://example.com/a")
    await adapter.browser_open("one", "https://example.com/a")
    await adapter.browser_open("one", "https://example.com/b")
    assert sum(tool == "browser_prepare" for tool, _ in driver.calls) == 1
    assert sum(tool == "browser_navigate" for tool, _ in driver.calls) == 2


async def test_browser_click_is_one_explicit_synthetic_dom_dispatch():
    adapter, driver = make_adapter()
    observed = await adapter.browser_open("one", "https://example.com")
    result = await adapter.browser_act(
        "one", observed["observation_id"], {"type": "click", "element_ref": "p3:7"}
    )
    clicks = [arguments for tool, arguments in driver.calls if tool == "browser_click"]
    assert len(clicks) == 1
    assert clicks[0]["input_route"] == "dom_event"
    assert result["synthetic"] is True
    assert result["input_route"] == "dom_event"
    assert result["business_verified"] is False


async def test_close_cancels_inflight_native_call_then_ends_only_its_session():
    adapter, driver = make_adapter()
    observed = await adapter.browser_open("one", "https://example.com")
    await adapter.browser_open("two", "https://example.com")
    driver.block = True
    running = asyncio.create_task(
        adapter.browser_act("one", observed["observation_id"], {"type": "click", "element_ref": "p3:7"})
    )
    await driver.entered.wait()
    await adapter.close_session("one")
    assert running.cancelled()
    assert driver.cancelled is True
    assert driver.ended == [driver.started[0]]
    assert (await adapter.browser_observe("two"))["observation_id"]
    await adapter.shutdown()
    assert driver.shutdown_called is True


async def test_failed_browser_binding_cleans_isolated_process():
    adapter, driver = make_adapter()
    driver.bad_binding = True
    with pytest.raises(CuaError) as error:
        await adapter.browser_open("one", "https://example.com")
    assert error.value.code == "cua_response_contract"
    assert driver.ended == driver.started


@pytest.mark.parametrize(
    "override", [{"status": "error"}, {"binding_quality": "heuristic"}, {"mutation_allowed": False}]
)
async def test_readonly_or_ambiguous_browser_binding_never_navigates(override):
    adapter, driver = make_adapter()
    driver.binding_authority.update(override)
    with pytest.raises(CuaError) as error:
        await adapter.browser_open("one", "https://example.com")
    assert error.value.code == "browser_binding_ambiguous"
    assert not any(tool == "browser_navigate" for tool, _ in driver.calls)
    assert driver.ended == driver.started


async def test_browser_observation_refuses_degraded_authority():
    adapter, driver = make_adapter()
    first = await adapter.browser_open("one", "https://example.com")
    driver.binding_authority["mutation_allowed"] = False
    with pytest.raises(CuaError) as error:
        await adapter.browser_observe("one")
    assert error.value.code == "browser_binding_ambiguous"
    with pytest.raises(CuaError) as error:
        await adapter.browser_act("one", first["observation_id"], {"type": "click", "element_ref": "p3:7"})
    assert error.value.code == "stale_observation"


async def test_transport_exception_is_unknown_and_never_replayed():
    adapter, driver = make_adapter()
    observed = await adapter.computer_observe("one", 44, 99, screenshot=False)
    driver.fail = True
    with pytest.raises(CuaError) as error:
        await adapter.computer_act("one", observed["observation_id"], {"type": "type", "text": "你好"})
    assert error.value.code == "outcome_unknown"
    assert "private driver failure" not in str(error.value)
    assert sum(tool == "type_text" for tool, _ in driver.calls) == 1


async def test_dependency_diagnostics_keep_installed_version_when_incompatible():
    sdk = fake_sdk()
    sdk.__version__ = "0.47.10"
    diagnostics = await CuaDriverAdapter(sdk=sdk).diagnostics()
    assert diagnostics["driver"]["installed"] is True
    assert diagnostics["driver"]["version"] == "0.47.10"
    assert diagnostics["driver"]["loaded"] is False
    assert diagnostics["driver"]["error"]["code"] == "cua_version_mismatch"
    assert diagnostics["permissions"]["checked"] is False


async def test_non_macos_does_not_import_optional_binary(monkeypatch):
    monkeypatch.setattr("abridge.cua_driver.sys.platform", "linux")
    imported = []
    monkeypatch.setattr("abridge.cua_driver.importlib.import_module", lambda name: imported.append(name))
    diagnostics = await CuaDriverAdapter().diagnostics()
    assert diagnostics["driver"]["error"]["code"] == "cua_platform_unsupported"
    assert imported == []


@dataclass
class Window:
    pid: int = 44
    window_id: int = 99
    layer: int = 0
    title: str = "文稿"
    is_on_screen: bool = True
    z_index: int | None = 3


@dataclass
class Element:
    element_token: str = "s00000001:1"
    role: str = "AXButton"
    label: str = "确定"


@dataclass
class WindowState:
    pid: int = 44
    window_id: int = 99
    elements: list | None = None
    images: list | None = None
    screenshot_width: int = 640
    screenshot_height: int = 480
    screenshot_scale: float = 2
    window_bounds: dict | None = None


class Mode(Enum):
    EMBEDDED = 0


class FakeDriver:
    def __init__(self):
        self.started = []
        self.ended = []
        self.calls = []
        self.block = False
        self.fail = False
        self.bad_binding = False
        self.binding_authority = {"status": "ok", "binding_quality": "exact", "mutation_allowed": True}
        self.entered = asyncio.Event()
        self.cancelled = False
        self.shutdown_called = False
        self.focus_pid = 44
        self.focus_title = "文稿"
        self.focus_window = 99
        self.z_index = 3
        self.captures = 0
        self.change_during_capture = False

    def execution_mode(self):
        return Mode.EMBEDDED

    def socket_path(self):
        return ""

    def is_available(self):
        return True

    async def start_session(self, request):
        self.started.append(request.session)

    async def end_session(self, request):
        self.ended.append(request.session)

    async def shutdown(self):
        self.shutdown_called = True

    async def get_window_state(self, request):
        return WindowState(elements=[Element()], images=[])

    async def get_desktop_state(self, request):
        self.captures += 1
        if self.change_during_capture:
            self.focus_title = "捕获期间已更换"
        return SimpleNamespace(
            is_error=False,
            error_code=None,
            text="",
            images=[],
            structured_json=json.dumps(
                {"screenshot_width": 640, "screenshot_height": 480, "capture_id": "capture-owned"}
            ),
        )

    async def list_apps(self, request):
        return SimpleNamespace(apps=[SimpleNamespace(pid=self.focus_pid, running=True, active=True)])

    async def list_windows(self, request):
        return SimpleNamespace(
            windows=[
                Window(
                    pid=request.pid or 44,
                    window_id=self.focus_window,
                    title=self.focus_title,
                    z_index=self.z_index,
                )
            ],
            current_space_id=1,
        )

    async def call_tool(self, tool, encoded):
        arguments = json.loads(encoded)
        self.calls.append((tool, arguments))
        if self.fail:
            raise RuntimeError("private driver failure")
        if tool == "browser_click" and self.block:
            self.entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        data = {}
        if tool == "browser_prepare":
            data = {"prepared": True, "prepared_pid": 44}
        elif tool == "get_browser_state":
            if "pid" in arguments:
                data = (
                    self.binding_authority.copy()
                    if self.bad_binding
                    else {
                        **self.binding_authority,
                        "target_id": "owned-target",
                        "tabs": [{"tab_id": "owned-tab"}],
                    }
                )
            else:
                data = {**self.binding_authority, "nodes": [{"ref": "p3:7", "name": "提交"}]}
        return SimpleNamespace(
            is_error=False, error_code=None, structured_json=json.dumps(data), text="", images=[]
        )


def fake_sdk():
    return SimpleNamespace(
        __version__=CUA_VERSION,
        DriverExecutionMode=Mode,
        StartSessionInput=SimpleNamespace,
        EndSessionInput=SimpleNamespace,
        GetWindowStateInput=SimpleNamespace,
        GetDesktopStateInput=SimpleNamespace,
        ListAppsInput=SimpleNamespace,
        ListWindowsInput=SimpleNamespace,
        current_mac_os_permission_status=lambda: SimpleNamespace(screen_recording=True, accessibility=True),
    )


def make_adapter():
    driver = FakeDriver()
    return CuaDriverAdapter(sdk=fake_sdk(), driver=driver), driver
