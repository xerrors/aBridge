"""Portable adapter checks; no desktop, browser, account or native library is used."""

import asyncio
import json
import sys
import time
from dataclasses import dataclass
from enum import Enum
from types import ModuleType, SimpleNamespace

import pytest

from abridge.cua_driver import CUA_VERSION, BrowserProfile, CuaDriverAdapter, CuaError


async def test_window_elements_are_session_bound_and_consumed_after_action():
    adapter, driver = make_adapter()
    observed = await adapter.computer_observe("session-a", 44, 99, screenshot=False)
    assert driver.window_state_request.tree_format == "elements"
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


async def test_fake_sdk_constructs_without_the_optional_native_package(constructed_fake):
    adapter, driver, loops = constructed_fake
    assert adapter._driver is None
    diagnostic = await adapter.diagnostics()
    assert diagnostic["driver"]["loaded"] is True
    assert adapter._driver is driver
    assert loops == [asyncio.get_running_loop()]
    assert sys.modules["cua_driver"].__path__ == []


async def test_late_authorization_after_shutdown_is_denied_without_driver(constructed_fake):
    adapter, _, loops = constructed_fake
    adapter._ensure_driver()
    host = adapter._authorization_host
    await adapter.shutdown()
    assert adapter._driver is None
    request = authorization_request("synthetic-closed-callback")
    decision = await host.authorize(request)
    assert decision.action == "deny"
    assert decision.request_digest == request.request_digest
    checks = adapter.browser_diagnostics()["authorization"]["checks"]
    assert checks["runtime_scope_valid"] is False
    assert checks["runtime_running"] is False
    assert loops == [asyncio.get_running_loop()]


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


async def test_default_profile_waits_for_local_owner_preparation():
    driver = FakeDriver()
    adapter = CuaDriverAdapter(sdk=fake_sdk(), driver=driver)
    browser = (await adapter.diagnostics())["browser"]
    assert BrowserProfile().mode == "existing_profile"
    assert browser["status"] == "awaiting_selection"
    assert browser["ready"] is False
    with pytest.raises(CuaError) as caught:
        await adapter.browser_open("remote", "https://example.com")
    assert caught.value.code == "browser_not_prepared"
    assert driver.started == []
    assert driver.calls == []


async def test_approved_config_alone_does_not_allow_remote_preparation(existing_adapter):
    adapter, driver = existing_adapter
    assert (await adapter.diagnostics())["browser"]["status"] == "awaiting_preparation"
    with pytest.raises(CuaError) as caught:
        await adapter.browser_open("remote", "https://example.com")
    assert caught.value.code == "browser_not_prepared"
    assert driver.calls == []
    assert driver.started == []


async def test_owner_context_has_explicit_trusted_ttls_and_one_foreground_connection(existing_adapter):
    adapter, driver = existing_adapter
    prepared = await adapter.prepare_browser()
    assert prepared["prepared"] is True
    assert prepared["detached"] is False
    assert prepared["session_ttl_seconds"] == 28800
    assert prepared["idle_ttl_seconds"] == 1800
    options = driver.trusted_options[0]
    assert (options.ttl_seconds, options.idle_ttl_seconds) == (28800, 1800)
    assert driver.ended == []
    assert [args["delivery_mode"] for tool, args in driver.calls if tool == "browser_prepare"] == [
        "foreground"
    ]
    count = len(driver.calls)
    assert (await adapter.prepare_browser())["already_prepared"] is True
    assert len(driver.calls) == count
    await adapter.stop()
    assert driver.ended == driver.started
    assert driver.handles[0].closed is True


async def test_remote_borrowers_are_exclusive_ref_isolated_and_keep_original_tab(existing_adapter):
    adapter, driver = existing_adapter
    driver.browser_tabs = [{"tab_id": "personal", "active": False}, {"tab_id": "approved", "active": True}]
    await adapter.prepare_browser()
    first = await adapter.browser_open("one", "https://example.com/a")
    with pytest.raises(CuaError) as caught:
        await adapter.browser_open("two", "https://example.com")
    assert caught.value.code == "browser_in_use"
    await adapter.close_session("one")
    assert driver.ended == []
    driver.browser_tabs = [{"tab_id": "new-active", "active": True}]
    second = await adapter.browser_open("three", "https://example.com/b")
    with pytest.raises(CuaError) as caught:
        await adapter.browser_act("three", first["observation_id"], {"type": "click", "element_ref": "p3:7"})
    assert caught.value.code == "stale_observation"
    second = await adapter.browser_observe("three")
    await adapter.browser_act(
        "three", second["observation_id"], {"type": "fill", "element_ref": "p3:7", "text": "中文"}
    )
    assert driver.calls[-1][1]["tab_id"] == "approved"
    assert len(driver.started) == 1
    assert sum(tool == "browser_prepare" for tool, _ in driver.calls) == 1
    await adapter.stop()


async def test_clean_disconnect_releases_remote_state_but_retains_owner(existing_adapter):
    adapter, driver = existing_adapter
    await adapter.prepare_browser()
    previous = await adapter.browser_open("old", "https://example.com")
    desktop = await adapter.computer_observe("desktop", 44, 99, screenshot=False)
    await adapter.release_remote_sessions()
    assert driver.ended == [driver.started[1]]
    assert adapter.browser_diagnostics()["prepared"] is True
    with pytest.raises(CuaError):
        await adapter.computer_act("desktop", desktop["observation_id"], {"type": "type", "text": "no"})
    current = await adapter.browser_open("new", "https://example.com")
    assert current["observation_id"] != previous["observation_id"]
    await adapter.stop()


async def test_disconnect_cancels_uncertain_browser_input_and_ends_owner(existing_adapter):
    adapter, driver = existing_adapter
    await adapter.prepare_browser()
    observed = await adapter.browser_open("one", "https://example.com")
    driver.block = True
    action = asyncio.create_task(
        adapter.browser_act("one", observed["observation_id"], {"type": "click", "element_ref": "p3:7"})
    )
    await driver.entered.wait()
    await adapter.release_remote_sessions()
    assert action.cancelled()
    assert adapter.browser_diagnostics()["prepared"] is False
    assert driver.handles[0].closed is True
    assert driver.ended == driver.started


async def test_disconnect_does_not_cancel_local_owner_prepare(existing_adapter):
    adapter, driver = existing_adapter
    original = driver.call_tool
    resume = asyncio.Event()

    async def pending(tool, encoded):
        if tool == "browser_prepare":
            driver.entered.set()
            await resume.wait()
        return await original(tool, encoded)

    driver.call_tool = pending
    preparing = asyncio.create_task(adapter.prepare_browser())
    await driver.entered.wait()
    await adapter.release_remote_sessions()
    assert not preparing.done()
    resume.set()
    assert (await preparing)["prepared"] is True
    await adapter.stop()


async def test_stop_browser_closes_owner_but_preserves_independent_desktop(existing_adapter):
    adapter, driver = existing_adapter
    await adapter.prepare_browser()
    await adapter.browser_open("browser", "https://example.com")
    observed = await adapter.computer_observe("desktop", 44, 99, screenshot=False)
    await adapter.stop_browser()
    assert driver.ended == [driver.started[0]]
    await adapter.computer_act("desktop", observed["observation_id"], {"type": "type", "text": "仍有效"})
    assert driver.calls[-1][0] == "type_text"
    await adapter.stop()


async def test_profile_change_closes_owner_and_preserves_independent_desktop(existing_adapter):
    adapter, driver = existing_adapter
    await adapter.prepare_browser()
    desktop = await adapter.computer_observe("desktop", 44, 99, screenshot=False)
    await adapter.configure_browser(BrowserProfile(mode="isolated"))
    assert adapter.browser_diagnostics()["prepared"] is False
    assert driver.handles[0].closed is True
    await adapter.computer_act("desktop", desktop["observation_id"], {"type": "type", "text": "仍有效"})
    await adapter.stop()


async def test_changed_process_fingerprint_ends_owner_without_remote_reconnection(
    existing_adapter, monkeypatch
):
    adapter, driver = existing_adapter
    await adapter.prepare_browser()

    async def changed(pid):
        return "b" * 64

    monkeypatch.setattr("abridge.cua_driver._process_fingerprint", changed)
    with pytest.raises(CuaError) as caught:
        await adapter.browser_open("remote", "https://example.com")
    assert caught.value.code == "browser_selection_expired"
    assert driver.handles[0].closed is True
    assert sum(tool == "browser_prepare" for tool, _ in driver.calls) == 1


async def test_diagnostics_releases_owner_immediately_when_selected_process_expires(
    existing_adapter, monkeypatch
):
    adapter, driver = existing_adapter
    await adapter.prepare_browser()

    async def changed(pid):
        return "b" * 64

    monkeypatch.setattr("abridge.cua_driver._process_fingerprint", changed)
    browser = (await adapter.diagnostics())["browser"]
    assert browser["status"] == "expired"
    assert browser["ready"] is False
    assert browser["owner_ready"] is False
    assert driver.handles[0].closed is True
    assert driver.ended == driver.started


async def test_owner_idle_expires_without_polling_or_heartbeat(existing_adapter, monkeypatch):
    monkeypatch.setattr("abridge.cua_driver.OWNER_BROWSER_IDLE_SECONDS", 0.01)
    adapter, driver = existing_adapter
    await adapter.prepare_browser()
    calls = len(driver.calls)
    await asyncio.wait_for(driver.ended_event.wait(), timeout=1)
    assert len(driver.calls) == calls
    assert adapter.browser_diagnostics()["prepared"] is False
    with pytest.raises(CuaError) as caught:
        await adapter.browser_open("remote", "https://example.com")
    assert caught.value.code == "browser_not_prepared"


async def test_owner_absolute_expiry_is_not_extended_by_browser_activity(existing_adapter, monkeypatch):
    monkeypatch.setattr("abridge.cua_driver.OWNER_BROWSER_TTL_SECONDS", 0.01)
    adapter, driver = existing_adapter
    await adapter.prepare_browser()
    await adapter.browser_open("one", "https://example.com")
    await asyncio.wait_for(driver.ended_event.wait(), timeout=1)
    assert adapter.browser_diagnostics()["prepared"] is False
    assert (await adapter.diagnostics())["browser"]["status"] == "expired"


async def test_local_browser_stop_cancels_foreground_preparation(existing_adapter):
    adapter, driver = existing_adapter
    original = driver.call_tool

    async def waiting(tool, encoded):
        if tool == "browser_prepare":
            driver.entered.set()
            await asyncio.Event().wait()
        return await original(tool, encoded)

    driver.call_tool = waiting
    task = asyncio.create_task(adapter.prepare_browser())
    await driver.entered.wait()
    await adapter.stop_browser()
    assert task.cancelled()
    assert driver.handles[0].closed is True
    assert driver.ended == driver.started


@pytest.mark.parametrize("change", ["application", "window_owner", "window_id"])
async def test_owner_prepare_proves_exact_chrome_before_any_mutation(existing_adapter, change):
    adapter, driver = existing_adapter
    if change == "application":
        driver.bundle_id = "com.microsoft.edgemac"
    elif change == "window_owner":
        driver.window_owner = 55
    else:
        driver.focus_window = 100
    with pytest.raises(CuaError) as caught:
        await adapter.prepare_browser()
    assert caught.value.code == "browser_selection_expired"
    assert driver.calls == []
    assert driver.started == []


@pytest.mark.parametrize(
    "tabs",
    [
        [],
        [{"tab_id": "unknown", "active": None}],
        [{"tab_id": "a", "active": True}, {"tab_id": "b", "active": True}],
    ],
)
async def test_owner_prepare_refuses_unproved_active_tab(existing_adapter, tabs):
    adapter, driver = existing_adapter
    driver.browser_tabs = tabs
    with pytest.raises(CuaError) as caught:
        await adapter.prepare_browser()
    assert caught.value.code == "browser_binding_ambiguous"
    assert driver.ended == driver.started
    assert driver.handles[0].closed is True


async def test_owner_prepare_start_failure_and_cancellation_close_bound_authority(existing_adapter):
    adapter, driver = existing_adapter

    async def uncertain(request):
        driver.started.append(request.session)
        raise RuntimeError("missing start reply")

    driver.start_session = uncertain
    with pytest.raises(CuaError) as caught:
        await adapter.prepare_browser()
    assert caught.value.code == "outcome_unknown"
    assert driver.ended == driver.started
    assert driver.handles[0].closed is True


@pytest.mark.parametrize(
    "change",
    [
        "pid",
        "window_id",
        "endpoint_owner_pid",
        "product",
        "session",
        "foreign_runtime",
        "operation",
        "expired",
        "digest",
    ],
)
async def test_owner_host_refuses_nonmatching_resource_or_request(existing_adapter, change):
    adapter, driver = existing_adapter
    checked = []

    async def probe(session):
        request = authorization_request(session)
        if change in {"pid", "window_id", "endpoint_owner_pid", "product"}:
            resource = json.loads(request.resource_json)
            if change == "product":
                resource["browser_product"] = "microsoft_edge"
            else:
                resource[change] += 1
            request.resource_json = json.dumps(resource)
        elif change == "session":
            request.public_session = "another"
        elif change == "foreign_runtime":
            request.public_session = request.public_session.replace("a" * 32, "b" * 32, 1)
        elif change == "operation":
            request.adapter_id = "other"
        elif change == "expired":
            request.expires_unix_ms = 0
        else:
            request.request_digest = ""
        checked.append(await adapter._authorize_existing_profile(request))

    driver.authorization_probe = probe
    await adapter.prepare_browser()
    assert checked == [False]
    await adapter.stop()


async def test_owner_host_accepts_only_current_local_approval(existing_adapter):
    adapter, driver = existing_adapter
    checked = []

    async def probe(session):
        checked.append(await adapter._authorize_existing_profile(authorization_request(session)))

    driver.authorization_probe = probe
    await adapter.prepare_browser()
    assert checked == [True]
    assert await adapter._authorize_existing_profile(authorization_request(driver.started[0])) is False
    await adapter.stop()


@pytest.mark.parametrize("stage", ["prepare", "bind", "navigate", "observe"])
async def test_vendor_refusal_records_owner_only_stage_and_safe_reason(existing_adapter, stage):
    adapter, driver = existing_adapter
    original = driver.call_tool
    if stage in {"navigate", "observe"}:
        await adapter.prepare_browser()

    async def refused(tool, encoded):
        args = json.loads(encoded)
        current = {
            "browser_prepare": "prepare",
            "browser_navigate": "navigate",
            "get_browser_state": "bind" if "pid" in args else "observe",
        }.get(tool)
        if current != stage:
            return await original(tool, encoded)
        return SimpleNamespace(
            is_error=False,
            error_code=None,
            text="refused",
            images=[],
            structured_json=json.dumps(
                {
                    "status": "refused",
                    "refusal": {
                        "code": "browser_wrong_target_refused",
                        "message": "no exact target endpoint=ws://127.0.0.1:9222/private profile_path=/Users/private/Profile Cookie=fixture_secret",
                    },
                }
            ),
        )

    driver.call_tool = refused
    with pytest.raises(CuaError) as caught:
        if stage in {"prepare", "bind"}:
            await adapter.prepare_browser()
        else:
            await adapter.browser_open("remote", "https://example.com")
    local = adapter.browser_diagnostics()["last_error"]
    assert local["stage"] == stage
    assert local["reason"].startswith("no exact target")
    for secret in ("fixture_secret", "/Users/private", "ws://", "127.0.0.1:9222"):
        assert secret not in json.dumps(local)
        assert secret not in str(caught.value)
    assert "last_error" not in (await adapter.diagnostics())["browser"]
    await adapter.stop()


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
        self.trusted_options = []
        self.handles = []
        self.authorization_probe = None
        self.ended_event = asyncio.Event()
        self.started = []
        self.ended = []
        self.calls = []
        self.block = False
        self.fail = False
        self.bad_binding = False
        self.browser_tabs = [{"tab_id": "owned-tab", "active": True}]
        self.prepare_refusal = None
        self.binding_authority = {"status": "ok", "binding_quality": "exact", "mutation_allowed": True}
        self.entered = asyncio.Event()
        self.cancelled = False
        self.shutdown_called = False
        self.focus_pid = 44
        self.focus_title = "文稿"
        self.focus_window = 99
        self.bundle_id = "com.google.Chrome"
        self.window_owner = None
        self.z_index = 3
        self.captures = 0
        self.change_during_capture = False

    def execution_mode(self):
        return Mode.EMBEDDED

    def runtime_scope_prefix(self):
        return "__cua_runtime_" + "a" * 32 + ":"

    def socket_path(self):
        return ""

    def is_available(self):
        return True

    async def start_session(self, request):
        self.started.append(request.session)

    async def end_session(self, request):
        self.ended.append(request.session)
        self.ended_event.set()

    async def shutdown(self):
        self.shutdown_called = True

    async def get_window_state(self, request):
        self.window_state_request = request
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
        return SimpleNamespace(
            apps=[
                SimpleNamespace(
                    pid=self.focus_pid,
                    running=True,
                    active=True,
                    bundle_id=self.bundle_id,
                    name="Google Chrome",
                )
            ]
        )

    async def list_windows(self, request):
        return SimpleNamespace(
            windows=[
                Window(
                    pid=self.window_owner or request.pid or 44,
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
            if self.prepare_refusal:
                return SimpleNamespace(
                    is_error=True,
                    error_code=self.prepare_refusal,
                    structured_json=None,
                    text="Refused",
                    images=[],
                )
            data = {"prepared": True, "prepared_pid": 44}
        elif tool == "get_browser_state":
            if "pid" in arguments:
                data = (
                    self.binding_authority.copy()
                    if self.bad_binding
                    else {
                        **self.binding_authority,
                        "target_id": "owned-target",
                        "tabs": self.browser_tabs,
                    }
                )
            else:
                data = {**self.binding_authority, "nodes": [{"ref": "p3:7", "name": "提交"}]}
        return SimpleNamespace(
            is_error=False, error_code=None, structured_json=json.dumps(data), text="", images=[]
        )


class FakeBoundHandle:
    def __init__(self, driver, options):
        self.driver = driver
        self.options = options
        self.closed = False

    async def start_session(self, request):
        return await self.driver.start_session(request)

    async def end_session(self, request):
        return await self.driver.end_session(request)

    async def call_tool(self, tool, encoded):
        if self.closed:
            raise RuntimeError("Bound context is closed")
        if tool == "browser_prepare" and self.driver.authorization_probe is not None:
            await self.driver.authorization_probe(
                self.driver.runtime_scope_prefix() + self.options.public_session
            )
        return await self.driver.call_tool(tool, encoded)

    def close(self):
        self.closed = True


def fake_sdk():
    def create(driver, options):
        driver.trusted_options.append(options)
        handle = FakeBoundHandle(driver, options)
        driver.handles.append(handle)
        return handle

    return SimpleNamespace(
        create_trusted_session=create,
        TrustedSessionOptions=SimpleNamespace,
        SessionPermissionMode=SimpleNamespace(STANDARD="standard"),
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
    return CuaDriverAdapter(
        sdk=fake_sdk(), driver=driver, browser_profile=BrowserProfile(mode="isolated")
    ), driver


@pytest.fixture
async def constructed_fake(monkeypatch):
    # The constructor still calls the documented public setter. This harness
    # supplies the generated module, so CI needs no native optional package.
    loops = []
    package = ModuleType("cua_driver")
    package.__path__ = []
    generated = ModuleType("cua_driver._native")
    generated.uniffi_set_event_loop = loops.append
    monkeypatch.setitem(sys.modules, "cua_driver", package)
    monkeypatch.setitem(sys.modules, "cua_driver._native", generated)
    driver = FakeDriver()
    sdk = fake_sdk()
    sdk.DriverAuthorizationHost = object
    sdk.DriverAuthorizationAction = SimpleNamespace(ALLOW="allow", DENY="deny")
    sdk.DriverAuthorizationDecision = SimpleNamespace
    sdk.ConfiguredDriverOptions = SimpleNamespace
    sdk.RuntimeAuthorizationOptions = SimpleNamespace
    sdk.CuaDriver = SimpleNamespace(create_configured_with_authorization_host=lambda options, host: driver)
    adapter = CuaDriverAdapter(sdk=sdk)
    try:
        yield adapter, driver, loops
    finally:
        await adapter.shutdown()


@pytest.fixture
def existing_adapter(monkeypatch):
    async def fingerprint(pid):
        return "a" * 64 if pid == 44 else None

    monkeypatch.setattr("abridge.cua_driver._process_fingerprint", fingerprint)
    profile = BrowserProfile(
        mode="existing_profile", pid=44, window_id=99, fingerprint="a" * 64, approved=True
    )
    driver = FakeDriver()
    return CuaDriverAdapter(sdk=fake_sdk(), driver=driver, browser_profile=profile), driver


def authorization_request(session):
    return SimpleNamespace(
        public_session=session,
        transport_session=session,
        adapter_id="browser_prepare.existing_profile",
        permission_mode="standard",
        request_digest="c" * 64,
        human_summary="Attach approved Chrome window",
        expires_unix_ms=int(time.time() * 1000) + 10_000,
        resource_json=json.dumps(
            {
                "pid": 44,
                "window_id": 99,
                "endpoint_owner_pid": 44,
                "process_fingerprint": {"native_attested": True},
                "browser_product": "google_chrome",
            }
        ),
    )
