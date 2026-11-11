"""Regression: turning off one capability must preserve unrelated sessions."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from abridge.runtime import Connection, Runtime
from abridge.storage import Store


async def test_screen_disable_preserves_separate_shell_session(tmp_path: Path) -> None:
    store = Store(tmp_path / "isolation.db")
    try:
        owner = store.create_user("acceptance", "independent-password")
        device, _ = store.create_device(owner["id"], "test-device", ["screen", "shell"])
        grant, _ = store.create_grant(
            owner["id"], "test-agent", [device["id"]], ["screen", "shell"], time.time() + 600
        )
        runtime = Runtime(store)
        websocket = RecordingSocket()
        epoch = store.next_epoch(device["id"])
        connection = Connection(
            websocket, epoch, 1, {"screen": True, "shell": True}, False, "darwin", "acceptance"
        )
        runtime.connections[device["id"]] = connection
        shell_session = runtime.open_session(grant, device["id"], ["shell"])
        screen_session = runtime.open_session(grant, device["id"], ["screen"])
        await runtime.execute(
            grant, shell_session["id"], "command_execute", {"command": "sleep 10"}, "shell-live", wait=False
        )

        await runtime.receive(
            device["id"],
            connection,
            {
                "type": "heartbeat",
                "connection_epoch": 1,
                "capabilities": {"screen": False, "shell": True},
                "paused": False,
            },
        )

        assert store.session(shell_session["id"])["status"] == "active"
        assert store.session(screen_session["id"])["status"] != "active"
        assert "shell-live" in runtime.pending
        assert all(message["type"] != "stop" for message in websocket.messages)
        cancelled = [
            operation_id
            for message in websocket.messages
            if message["type"] == "cancel"
            for operation_id in message["operation_ids"]
        ]
        assert "shell-live" not in cancelled
    finally:
        store.close()


class RecordingSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.messages.append(payload)
