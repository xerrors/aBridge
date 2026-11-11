"""The fixed wheel's real ctypes callback bridge; no browser or desktop is used.

Only this harness uses generated converters and the vtable entry. A Python
callback handle is not a Rust Arc and must never be made into HostImpl.
"""

import asyncio
import ctypes
import json
import sys
import threading
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


pytestmark = pytest.mark.skipif(not fixed_sdk_installed(), reason="The fixed macOS wheel is not installed")


async def test_actual_ctypes_authorization_callback_runs_on_bound_loop():
    result = await callback_probe()
    assert result["foreign_thread"] != result["callback_thread"]
    assert result["foreign_thread_has_loop"] is False
    assert result["callback_loop"] is asyncio.get_running_loop()
    assert result["denied"] is True
    assert result["digest"] == "a" * 64


def test_actual_callback_rebinds_on_sequential_new_event_loops():
    loops = [asyncio.new_event_loop(), asyncio.new_event_loop()]
    try:
        for loop in loops:
            result = loop.run_until_complete(callback_probe())
            assert result["callback_loop"] is loop
            assert result["denied"] is True
    finally:
        for loop in loops:
            loop.close()


async def callback_probe():
    import cua_driver as sdk
    import cua_driver._native as generated

    adapter = CuaDriverAdapter()
    adapter._ensure_driver()
    loop = asyncio.get_running_loop()
    observed = {}
    original = adapter._authorize_existing_profile

    async def checked(request):
        observed["callback_loop"] = asyncio.get_running_loop()
        observed["callback_thread"] = threading.get_ident()
        return await original(request)

    adapter._authorize_existing_profile = checked
    request = sdk.DriverAuthorizationRequest(
        schema="cua-driver-authorization-request-v1",
        nonce="synthetic",
        generation=1,
        daemon_instance="synthetic",
        permission_mode="standard",
        managed_policy_sha256=None,
        user_policy_sha256=None,
        adapter_id="browser_prepare.existing_profile",
        risk_class="r2",
        public_session="unregistered-test-session",
        transport_session="synthetic",
        resource_json=json.dumps({"pid": 44, "window_id": 99, "endpoint_owner_pid": 44}),
        human_summary="Synthetic callback; no browser access",
        expires_unix_ms=9_999_999_999_999,
        request_digest="a" * 64,
    )
    converter = generated._UniffiFfiConverterTypeDriverAuthorizationHost
    handle = converter.lower(adapter._authorization_host)
    buffer = generated._UniffiFfiConverterTypeDriverAuthorizationRequest.lower(request)
    dropped = generated._UniffiForeignFutureDroppedCallbackStruct()
    completed = loop.create_future()

    @generated._UNIFFI_FOREIGN_FUTURE_COMPLETERUST_BUFFER
    def on_complete(data, result):
        if result.call_status.code:
            message = generated._UniffiFfiConverterString.lift(result.call_status.error_buf)
            loop.call_soon_threadsafe(completed.set_exception, AssertionError(message))
        else:
            decision = generated._UniffiFfiConverterTypeDriverAuthorizationDecision.lift(result.return_value)
            loop.call_soon_threadsafe(completed.set_result, decision)

    def enter_callback():
        observed["foreign_thread"] = threading.get_ident()
        try:
            asyncio.get_running_loop()
            observed["foreign_thread_has_loop"] = True
        except RuntimeError:
            observed["foreign_thread_has_loop"] = False
        generated._UniffiTraitImplDriverAuthorizationHostImpl.authorize(
            handle, buffer, on_complete, 0, ctypes.byref(dropped)
        )

    try:
        await asyncio.to_thread(enter_callback)
        decision = await asyncio.wait_for(completed, timeout=2)
        observed["denied"] = decision.action == sdk.DriverAuthorizationAction.DENY
        observed["digest"] = decision.request_digest
        return observed
    finally:
        if dropped.handle:
            dropped.free(dropped.handle)
        generated._UniffiTraitImplDriverAuthorizationHostImpl._uniffi_free(handle)
        await adapter.shutdown()
