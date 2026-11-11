"""Persistence boundaries that must hold while administration runs beside execution."""

import time
from pathlib import Path
from typing import Any

import pytest

from abridge.runtime import BridgeError, Connection, Runtime
from abridge.storage import Store


def test_admin_connection_does_not_expire_live_sessions(tmp_path: Path) -> None:
    path = tmp_path / "server.db"
    store = Store(path)
    owner = store.create_user("owner", "owner-password-123")
    device, _ = store.create_device(owner["id"], "Mac", ["shell"])
    grant, _ = store.create_grant(owner["id"], "Agent", [device["id"]], ["shell"], time.time() + 600)
    session = store.create_session(grant["id"], device["id"], ["shell"], time.time() + 30)
    administrator = Store(path)
    administrator.create_user("second", "second-password-123")
    administrator.close()
    assert store.session(session["id"])["status"] == "active"
    store.close()


def test_account_login_survives_server_restart(tmp_path: Path) -> None:
    path = tmp_path / "server.db"
    store = Store(path)
    owner = store.create_user("owner", "owner-password-123")
    logged_in, token = store.login("owner", "owner-password-123")
    store.create_device(owner["id"], "Mac", ["screen"])
    store.close()

    restarted = Store(path)
    restarted.recover_after_restart()
    assert restarted.account(token) == logged_in
    restarted.close()


async def test_fast_result_is_not_overwritten_by_dispatch_state(tmp_path: Path) -> None:
    store, runtime, grant, device = make_runtime(tmp_path)

    class ImmediateResult:
        async def send_json(self, message: dict[str, Any]) -> None:
            if message["type"] == "dispatch":
                runtime.finish(message["operation_id"], "executed", {"exit_code": 0})

    epoch = store.next_epoch(device["id"])
    runtime.connections[device["id"]] = Connection(
        ImmediateResult(), epoch, 1, {"shell": True}, False, "darwin", "test"
    )
    session = runtime.open_session(grant, device["id"], ["shell"])
    result = await runtime.execute(
        grant, session["id"], "command_execute", {"command": "true"}, "fast-result", wait=False
    )
    assert result["status"] == "executed"
    assert store.operation("fast-result")["status"] == "executed"
    store.close()


def test_rotated_key_is_fenced_before_background_monitor(tmp_path: Path) -> None:
    store, runtime, grant, device = make_runtime(tmp_path)
    epoch = store.next_epoch(device["id"])
    runtime.connections[device["id"]] = Connection(None, epoch, 1, {"shell": True}, False, "darwin", "test")
    store.rotate_device(device["id"])
    with pytest.raises(BridgeError, match="凭据已失效"):
        runtime.open_session(grant, device["id"], ["shell"])
    store.close()


def make_runtime(tmp_path: Path) -> tuple[Store, Runtime, dict[str, Any], dict[str, Any]]:
    store = Store(tmp_path / "server.db")
    owner = store.create_user("owner", "owner-password-123")
    device, _ = store.create_device(owner["id"], "Mac", ["shell"])
    grant, _ = store.create_grant(owner["id"], "Agent", [device["id"]], ["shell"], time.time() + 600)
    return store, Runtime(store), grant, device
