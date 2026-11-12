"""A model may think between tools without reviving an actually expired lease."""

import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import abridge.runtime as runtime_module
from abridge.protocol import OBSERVATION_SECONDS, SESSION_IDLE_SECONDS
from abridge.runtime import BridgeError, Connection, Runtime
from abridge.storage import Store


async def test_admitted_read_renews_idle_lease_but_expired_session_stays_expired(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    now = [time.time()]
    monkeypatch.setattr(
        runtime_module, "time", SimpleNamespace(time=lambda: now[0], monotonic=time.monotonic)
    )
    store = Store(tmp_path / "server.db")
    try:
        owner = store.create_user("owner", "owner-password-123")
        device, _ = store.create_device(owner["id"], "Mac", ["screen"])
        grant, _ = store.create_grant(owner["id"], "Agent", [device["id"]], ["screen"], now[0] + 3600)
        runtime = Runtime(store)
        sent = []

        class ImmediateResult:
            async def send_json(self, message: dict[str, Any]) -> None:
                sent.append(message)
                if message["type"] == "dispatch":
                    runtime.finish(message["operation_id"], "executed", {"apps": []})

        epoch = store.next_epoch(device["id"])
        connection = Connection(ImmediateResult(), epoch, 1, {"screen": True}, False, "darwin", "test")
        runtime.connections[device["id"]] = connection
        session = runtime.open_session(grant, device["id"], ["screen"])
        assert SESSION_IDLE_SECONDS == 300
        assert OBSERVATION_SECONDS == 10
        assert session["lease_until"] == now[0] + SESSION_IDLE_SECONDS

        now[0] += 90
        result = await runtime.execute(grant, session["id"], "computer_apps", {}, "after-thinking")
        assert result["status"] == "executed"
        renewed_until = store.session(session["id"])["lease_until"]
        assert renewed_until == now[0] + SESSION_IDLE_SECONDS
        assert sent[0]["expires_at"] == now[0] + 30

        # Device pause and a forbidden capability must not renew this session.
        connection.paused = True
        now[0] += 10
        with pytest.raises(BridgeError) as paused:
            await runtime.execute(grant, session["id"], "computer_apps", {}, "while-paused")
        assert paused.value.code == "device_paused"
        connection.paused = False
        with pytest.raises(BridgeError) as forbidden:
            await runtime.execute(grant, session["id"], "file_read", {"path": "/tmp/x"}, "forbidden")
        assert forbidden.value.code == "forbidden"
        assert store.session(session["id"])["lease_until"] == renewed_until

        now[0] = renewed_until + 1
        with pytest.raises(BridgeError) as expired:
            await runtime.execute(grant, session["id"], "computer_apps", {}, "after-expiry")
        assert expired.value.code == "session_expired"
        assert store.session(session["id"])["lease_until"] == renewed_until
        assert len(sent) == 1
    finally:
        store.close()


def test_idle_lease_never_extends_beyond_agent_authorization(tmp_path: Path) -> None:
    store = Store(tmp_path / "server.db")
    try:
        owner = store.create_user("owner", "owner-password-123")
        device, _ = store.create_device(owner["id"], "Mac", ["screen"])
        grant, _ = store.create_grant(owner["id"], "Agent", [device["id"]], ["screen"], time.time() + 60)
        runtime = Runtime(store)
        epoch = store.next_epoch(device["id"])
        runtime.connections[device["id"]] = Connection(
            None, epoch, 1, {"screen": True}, False, "darwin", "test"
        )
        session = runtime.open_session(grant, device["id"], ["screen"])
        assert session["lease_until"] == grant["expires_at"]
    finally:
        store.close()


async def test_paused_and_closed_sessions_are_not_reported_as_lease_expiry(tmp_path: Path) -> None:
    store = Store(tmp_path / "server.db")
    try:
        owner = store.create_user("owner", "owner-password-123")
        device, _ = store.create_device(owner["id"], "Mac", ["screen"])
        grant, _ = store.create_grant(owner["id"], "Agent", [device["id"]], ["screen"], time.time() + 3600)
        runtime = Runtime(store)
        epoch = store.next_epoch(device["id"])

        class Socket:
            async def send_json(self, message: dict[str, Any]) -> None:
                pass

        connection = Connection(Socket(), epoch, 1, {"screen": True}, False, "darwin", "test")
        runtime.connections[device["id"]] = connection
        session = runtime.open_session(grant, device["id"], ["screen"])
        await runtime.receive(
            device["id"], connection, {"type": "heartbeat", "connection_epoch": epoch, "paused": True}
        )
        assert store.session(session["id"])["status"] == "stopped"
        assert store.session(session["id"])["lease_until"] > time.time()
        with pytest.raises(BridgeError) as paused:
            runtime.authorized_session(grant, session["id"])
        assert paused.value.code == "device_paused"

        connection.paused = False
        with pytest.raises(BridgeError) as stopped:
            runtime.authorized_session(grant, session["id"])
        assert stopped.value.code == "session_stopped"
        store.close_session(session["id"], "expired")
        with pytest.raises(BridgeError) as expired:
            runtime.authorized_session(grant, session["id"])
        assert expired.value.code == "session_expired"
    finally:
        store.close()
