"""Black-box HTTP/MCP/WS tests against a separately started aBridge process."""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import socket
import subprocess
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
import pytest
import pytest_asyncio
import websockets
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from test_cua_boundary_acceptance import RecordingSDK
from websockets.exceptions import InvalidStatus

import abridge.cua_driver as cua_boundary
from abridge.client import DeviceClient, local_control, save_config
from abridge.cua_driver import BrowserProfile, CuaDriverAdapter
from abridge.executor import LocalExecutor
from abridge.storage import Store


async def test_http_identity_purposes_and_cross_owner_device_access(network: Network) -> None:
    own = await network.add_device(network.alice, "Alice Mac")
    foreign = await network.add_device(network.bob, "Bob Mac")
    agent = await network.add_grant(network.alice, "Alice Agent", [own["id"]])
    async with httpx.AsyncClient(base_url=network.url, trust_env=False) as anonymous:
        for key in (own["key"], agent["key"]):
            assert (
                await anonymous.get("/api/devices", headers={"Authorization": f"Bearer {key}"})
            ).status_code == 401
            assert (
                await anonymous.post(
                    "/api/devices",
                    headers={"Authorization": f"Bearer {key}"},
                    json={"name": "wrong", "capabilities": ["files"]},
                )
            ).status_code == 401
        assert (
            await anonymous.post(
                "/mcp",
                headers={"Authorization": f"Bearer {own['key']}"},
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
            )
        ).status_code == 401
    with pytest.raises(InvalidStatus) as refused:
        async with websockets.connect(
            network.ws_url, additional_headers={"Authorization": f"Bearer {agent['key']}"}
        ):
            pass
    assert refused.value.response.status_code in (401, 403)
    assert (await network.alice.post(f"/api/devices/{foreign['id']}/revoke")).status_code == 404
    forged_scope = await network.alice.post(
        "/api/client-grants", json={"name": "wrong", "device_ids": [foreign["id"]], "capabilities": ["files"]}
    )
    assert forged_scope.status_code == 404
    async with mcp_connection(network.url, agent["key"]) as mcp:
        tools = await mcp.list_tools()
        assert {"devices_list", "session_open", "file_write", "command_execute", "computer_observe"} <= {
            tool.name for tool in tools.tools
        }
        visible = decode(await mcp.call_tool("devices_list"))
        assert [device["id"] for device in visible["devices"]] == [own["id"]]
        denied = await mcp.call_tool("device_get", {"device_id": foreign["id"]})
        assert denied.isError is True


async def test_actual_mcp_files_commands_idempotency_and_result_scopes(
    network: Network, tmp_path: Path
) -> None:
    device = await network.add_device(network.alice, "Real device")
    first = await network.add_grant(network.alice, "First", [device["id"]])
    second = await network.add_grant(network.alice, "Second", [device["id"]])
    async with connected_device(network, device, tmp_path / "client"):
        async with (
            mcp_connection(network.url, first["key"]) as mcp,
            mcp_connection(network.url, second["key"]) as other,
        ):
            session = decode(
                await mcp.call_tool(
                    "session_open", {"device_id": device["id"], "capabilities": ["shell", "files"]}
                )
            )
            session_id = session["id"]
            target = tmp_path / "真实文件.txt"
            written = decode(
                await mcp.call_tool(
                    "file_write",
                    {
                        "session_id": session_id,
                        "path": str(target),
                        "content": "通过 aBridge\n",
                        "operation_id": "file-once",
                    },
                )
            )
            assert written["status"] == "executed"
            assert target.read_text() == "通过 aBridge\n"
            read = decode(await mcp.call_tool("file_read", {"session_id": session_id, "path": str(target)}))
            assert read["result"]["content"] == target.read_text()
            replay = decode(
                await mcp.call_tool(
                    "file_write",
                    {
                        "session_id": session_id,
                        "path": str(target),
                        "content": "通过 aBridge\n",
                        "operation_id": "file-once",
                    },
                )
            )
            assert replay["status"] == "executed"
            conflict = await mcp.call_tool(
                "file_write",
                {
                    "session_id": session_id,
                    "path": str(target),
                    "content": "wrong",
                    "operation_id": "file-once",
                },
            )
            assert conflict.isError is True
            assert target.read_text() == "通过 aBridge\n"
            leaked = await other.call_tool("command_status", {"operation_id": "file-once"})
            assert leaked.isError is True
            foreign_session = await other.call_tool(
                "file_read", {"session_id": session_id, "path": str(target)}
            )
            assert foreign_session.isError is True
            command = decode(
                await mcp.call_tool(
                    "command_execute",
                    {
                        "session_id": session_id,
                        "command": "printf shell-ok",
                        "cwd": str(tmp_path),
                        "operation_id": "shell-once",
                    },
                )
            )
            final = await poll_result(mcp, command["operation_id"])
            assert final["status"] == "executed"
            assert final["result"]["stdout"] == "shell-ok"
            assert final["result"]["exit_code"] == 0


async def test_running_output_is_visible_through_mcp_status(network: Network, tmp_path: Path) -> None:
    device = await network.add_device(network.alice, "Streaming device")
    agent = await network.add_grant(network.alice, "Streaming", [device["id"]])
    async with connected_device(network, device, tmp_path / "client"):
        async with mcp_connection(network.url, agent["key"]) as mcp:
            session = decode(
                await mcp.call_tool("session_open", {"device_id": device["id"], "capabilities": ["shell"]})
            )
            started = decode(
                await mcp.call_tool(
                    "command_execute",
                    {
                        "session_id": session["id"],
                        "command": "printf early; sleep 2; printf late",
                        "operation_id": "stream-live",
                    },
                )
            )
            async with asyncio.timeout(1.5):
                while True:
                    status = decode(
                        await mcp.call_tool("command_status", {"operation_id": started["operation_id"]})
                    )
                    assert status["status"] in {"accepted", "dispatched"}, (
                        "Output was only returned after command exit"
                    )
                    if "early" in status.get("output", {}).get("stdout", ""):
                        break
                    await asyncio.sleep(0.03)
            final = await poll_result(mcp, started["operation_id"])
            assert final["result"]["stdout"] == "earlylate"


async def test_revoking_one_agent_preserves_other_agent_and_device(network: Network, tmp_path: Path) -> None:
    device = await network.add_device(network.alice, "Shared owned device")
    first = await network.add_grant(network.alice, "Revoked Agent", [device["id"]])
    second = await network.add_grant(network.alice, "Preserved Agent", [device["id"]])
    async with connected_device(network, device, tmp_path / "client"):
        async with (
            mcp_connection(network.url, first["key"]) as revoked,
            mcp_connection(network.url, second["key"]) as preserved,
        ):
            first_session = decode(
                await revoked.call_tool(
                    "session_open", {"device_id": device["id"], "capabilities": ["shell"]}
                )
            )
            second_session = decode(
                await preserved.call_tool(
                    "session_open", {"device_id": device["id"], "capabilities": ["shell"]}
                )
            )
            pid_file = tmp_path / "revoked-child.pid"
            command = f"sleep 60 & child=$!; printf '%s' \"$child\" > {shlex.quote(str(pid_file))}; wait"
            decode(
                await revoked.call_tool(
                    "command_execute",
                    {
                        "session_id": first_session["id"],
                        "command": command,
                        "timeout": 20,
                        "operation_id": "revoked-live",
                    },
                )
            )
            await wait_for_file(pid_file)
            pid = int(pid_file.read_text())
            assert (await network.alice.post(f"/api/client-grants/{first['id']}/revoke")).status_code == 200
            await wait_for_exit(pid)
            started = decode(
                await preserved.call_tool(
                    "command_execute",
                    {
                        "session_id": second_session["id"],
                        "command": "printf still-ok",
                        "operation_id": "preserved-live",
                    },
                )
            )
            final = await poll_result(preserved, started["operation_id"])
            assert final["result"]["stdout"] == "still-ok"
            visible = decode(await preserved.call_tool("devices_list"))
            assert visible["devices"][0]["status"] == "online"
            async with httpx.AsyncClient(base_url=network.url, trust_env=False) as anonymous:
                response = await anonymous.post(
                    "/mcp",
                    headers={"Authorization": f"Bearer {first['key']}"},
                    json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                )
                assert response.status_code == 401


async def test_local_unbind_invalidates_old_device_key_at_server(network: Network, tmp_path: Path) -> None:
    device = await network.add_device(network.alice, "Unbind device")
    state_dir = tmp_path / "client"
    async with connected_device(network, device, state_dir):
        response = await local_control(state_dir, {"command": "unbind"})
        assert response["ok"] is True
        async with asyncio.timeout(4):
            while True:
                listing = (await network.alice.get("/api/devices")).json()["devices"]
                if listing[0]["status"] == "revoked":
                    break
                await asyncio.sleep(0.02)
        with pytest.raises(InvalidStatus) as refused:
            async with websockets.connect(
                network.ws_url, additional_headers={"Authorization": f"Bearer {device['key']}"}
            ):
                pass
        assert refused.value.response.status_code in (401, 403)


async def test_parallel_management_polling_keeps_authenticated_session(network: Network) -> None:
    for wave in range(40):
        requests = [
            network.alice.get("/api/devices"),
            network.alice.get("/api/client-grants"),
            network.alice.get("/api/activity"),
            network.alice.post("/api/devices", json={"name": f"poll-{wave}", "capabilities": ["files"]}),
        ]
        responses = await asyncio.gather(*requests)
        assert [response.status_code for response in responses] == [200, 200, 200, 201]
    assert (await network.alice.get("/api/me")).json()["username"] == "alice"


async def test_mcp_observation_has_native_image_without_base64_text_duplication(network: Network) -> None:
    response = await network.alice.post(
        "/api/devices", json={"name": "Image protocol fixture", "capabilities": ["screen"]}
    )
    assert response.status_code == 201
    device = response.json()
    response = await network.alice.post(
        "/api/client-grants",
        json={"name": "Image grant", "device_ids": [device["id"]], "capabilities": ["screen"]},
    )
    assert response.status_code == 201
    agent = response.json()
    encoded_png = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="
    )
    async with websockets.connect(
        network.ws_url, additional_headers={"Authorization": f"Bearer {device['key']}"}
    ) as device_socket:
        await device_socket.send(
            json.dumps(
                {"type": "hello", "protocol": "abridge/1", "capabilities": {"screen": True}, "paused": False}
            )
        )
        welcome = json.loads(await device_socket.recv())

        async def answer_observation() -> None:
            dispatch = json.loads(await device_socket.recv())
            assert dispatch["tool"] == "computer_observe"
            await device_socket.send(
                json.dumps(
                    {
                        "type": "result",
                        "operation_id": dispatch["operation_id"],
                        "connection_epoch": welcome["connection_epoch"],
                        "status": "executed",
                        "result": {
                            "image_base64": encoded_png,
                            "mime_type": "image/png",
                            "width": 1,
                            "height": 1,
                            "observation_id": "wire-fixture",
                        },
                    }
                )
            )

        async with mcp_connection(network.url, agent["key"]) as mcp:
            session = decode(
                await mcp.call_tool("session_open", {"device_id": device["id"], "capabilities": ["screen"]})
            )
            answering = asyncio.create_task(answer_observation())
            observed = await mcp.call_tool("computer_observe", {"session_id": session["id"]})
            await answering
            assert not observed.isError
            assert observed.structuredContent is None
            assert [block.type for block in observed.content] == ["text", "image"]
            assert "image_base64" not in observed.content[0].text
            assert encoded_png not in observed.content[0].text
            assert observed.content[1].data == encoded_png


async def test_screen_input_grant_cannot_expand_to_shell_files_or_another_device(network: Network) -> None:
    created = await network.alice.post(
        "/api/devices",
        json={
            "name": "Yuxi scope fixture",
            "capabilities": ["screen", "input", "shell", "files"],
        },
    )
    assert created.status_code == 201
    device = created.json()
    hidden = await network.add_device(network.alice, "Not granted to Yuxi")
    created = await network.alice.post(
        "/api/client-grants",
        json={
            "name": "Yuxi personal",
            "device_ids": [device["id"]],
            "capabilities": ["screen", "input"],
        },
    )
    assert created.status_code == 201
    yuxi = created.json()
    opencode = await network.add_grant(network.alice, "Independent OpenCode", [device["id"]])
    async with websockets.connect(
        network.ws_url, additional_headers={"Authorization": f"Bearer {device['key']}"}
    ) as device_socket:
        await device_socket.send(
            json.dumps(
                {
                    "type": "hello",
                    "protocol": "abridge/1",
                    "paused": False,
                    "capabilities": {"screen": True, "input": True, "shell": True, "files": True},
                }
            )
        )
        await device_socket.recv()
        async with mcp_connection(network.url, yuxi["key"]) as client:
            visible = decode(await client.call_tool("devices_list"))["devices"]
            assert [item["id"] for item in visible] == [device["id"]]
            assert set(visible[0]["capabilities"]) == {"screen", "input"}
            for capability in ("shell", "files"):
                refused = await client.call_tool(
                    "session_open", {"device_id": device["id"], "capabilities": [capability]}
                )
                assert refused.isError is True
            refused = await client.call_tool("device_get", {"device_id": hidden["id"]})
            assert refused.isError is True
            session = decode(
                await client.call_tool(
                    "session_open", {"device_id": device["id"], "capabilities": ["screen", "input"]}
                )
            )
            refused = await client.call_tool(
                "command_execute", {"session_id": session["id"], "command": "printf should-not-run"}
            )
            assert refused.isError is True
            refused = await client.call_tool(
                "file_read", {"session_id": session["id"], "path": "/tmp/not-a-real-file"}
            )
            assert refused.isError is True
            async with mcp_connection(network.url, opencode["key"]) as other:
                other_session = decode(
                    await other.call_tool(
                        "session_open", {"device_id": device["id"], "capabilities": ["shell"]}
                    )
                )
                await other.call_tool("session_close", {"session_id": other_session["id"]})
            await client.call_tool("session_close", {"session_id": session["id"]})
    assert (await network.alice.get("/api/activity")).json()["operations"] == []


async def test_browser_scope_does_not_inherit_desktop_or_command_access(network: Network) -> None:
    created = await network.alice.post(
        "/api/devices",
        json={
            "name": "Scoped browser fixture",
            "capabilities": ["screen", "input", "shell", "files", "browser"],
        },
    )
    assert created.status_code == 201
    device = created.json()
    grants = {}
    for name, capabilities in (("Desktop only", ["screen", "input"]), ("Browser only", ["browser"])):
        created = await network.alice.post(
            "/api/client-grants",
            json={"name": name, "device_ids": [device["id"]], "capabilities": capabilities},
        )
        assert created.status_code == 201
        grants[name] = created.json()

    async with websockets.connect(
        network.ws_url, additional_headers={"Authorization": f"Bearer {device['key']}"}
    ) as device_socket:
        await device_socket.send(
            json.dumps(
                {
                    "type": "hello",
                    "protocol": "abridge/1",
                    "paused": False,
                    "capabilities": {name: True for name in ("screen", "input", "shell", "files", "browser")},
                }
            )
        )
        await device_socket.recv()
        async with (
            mcp_connection(network.url, grants["Desktop only"]["key"]) as desktop,
            mcp_connection(network.url, grants["Browser only"]["key"]) as browser,
        ):
            tool_names = {tool.name for tool in (await browser.list_tools()).tools}
            assert {"browser_open", "browser_observe", "browser_act"} <= tool_names
            assert set(decode(await desktop.call_tool("devices_list"))["devices"][0]["capabilities"]) == {
                "screen",
                "input",
            }
            assert decode(await browser.call_tool("devices_list"))["devices"][0]["capabilities"] == [
                "browser"
            ]
            refused = await desktop.call_tool(
                "session_open", {"device_id": device["id"], "capabilities": ["browser"]}
            )
            assert refused.isError is True
            for capability in ("screen", "input", "shell", "files"):
                refused = await browser.call_tool(
                    "session_open", {"device_id": device["id"], "capabilities": [capability]}
                )
                assert refused.isError is True
            browser_session = decode(
                await browser.call_tool(
                    "session_open", {"device_id": device["id"], "capabilities": ["browser"]}
                )
            )
            desktop_session = decode(
                await desktop.call_tool(
                    "session_open", {"device_id": device["id"], "capabilities": ["screen", "input"]}
                )
            )
            refused = await browser.call_tool("computer_observe", {"session_id": browser_session["id"]})
            assert refused.isError is True
            refused = await desktop.call_tool("browser_observe", {"session_id": desktop_session["id"]})
            assert refused.isError is True
            refused = await desktop.call_tool("browser_observe", {"session_id": browser_session["id"]})
            assert refused.isError is True
            await desktop.call_tool("session_close", {"session_id": desktop_session["id"]})
            await browser.call_tool("session_close", {"session_id": browser_session["id"]})
    assert (await network.alice.get("/api/activity")).json()["operations"] == []


async def test_unattended_file_credential_cli_restart_pause_and_unbind(
    network: Network, tmp_path: Path
) -> None:
    device = await network.add_device(network.alice, "Unattended credential fixture")
    agent = await network.add_grant(network.alice, "Credential acceptance", [device["id"]])
    state = tmp_path / "client"
    save_config(
        state,
        {
            "url": network.url,
            "capabilities": {"screen": False, "input": False, "shell": True, "files": True},
            "paused": True,
            "revoked": False,
        },
    )
    helper_marker = tmp_path / "keychain-was-called"
    helper = tmp_path / "forbidden-keychain-helper"
    helper.write_text(f"#!/bin/sh\nprintf called > {shlex.quote(str(helper_marker))}\nexit 23\n")
    helper.chmod(0o700)
    command = [sys.executable, "-m", "abridge.client", "--state-dir", str(state), "--helper", str(helper)]
    output: list[bytes] = []
    processes: list[asyncio.subprocess.Process] = []

    configured = await asyncio.create_subprocess_exec(
        *command,
        "configure",
        "--stdin",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await configured.communicate(
        json.dumps(
            {
                "url": network.url,
                "device_key": device["key"],
                "capabilities": {"shell": True, "files": False},
            }
        ).encode()
    )
    output.extend((stdout, stderr))
    assert configured.returncode == 0
    assert json.loads(stdout)["ok"] is True
    credential_file = state / "credentials/device.json"
    assert credential_file.is_file()
    assert not helper_marker.exists()

    async def launch() -> asyncio.subprocess.Process:
        process = await asyncio.create_subprocess_exec(
            *command,
            "run",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        processes.append(process)
        async with asyncio.timeout(8):
            while True:
                assert process.returncode is None, "The unattended client exited before connecting"
                status_file = state / "status.json"
                if status_file.exists() and json.loads(status_file.read_text())["connection"] == "online":
                    return process
                await asyncio.sleep(0.02)

    try:
        first = await launch()
        status = await local_control(state, {"command": "status"})
        assert status["paused"] is True
        assert status["requested_capabilities"]["shell"] is True
        assert status["requested_capabilities"]["files"] is False
        assert status["requested_capabilities"]["browser"] is False
        async with mcp_connection(network.url, agent["key"]) as mcp:
            refused = await mcp.call_tool(
                "session_open", {"device_id": device["id"], "capabilities": ["shell"]}
            )
            assert refused.isError is True
            await local_control(state, {"command": "resume"})
            async with asyncio.timeout(3):
                while decode(await mcp.call_tool("devices_list"))["devices"][0]["paused"]:
                    await asyncio.sleep(0.02)
            refused = await mcp.call_tool(
                "session_open", {"device_id": device["id"], "capabilities": ["files"]}
            )
            assert refused.isError is True
            session = decode(
                await mcp.call_tool(
                    "session_open",
                    {
                        "device_id": device["id"],
                        "capabilities": ["shell"],
                    },
                )
            )
            operation = decode(
                await mcp.call_tool(
                    "command_execute",
                    {
                        "session_id": session["id"],
                        "command": "printf file-credential-ok",
                    },
                )
            )
            result = await poll_result(mcp, operation["operation_id"])
            assert result["result"]["stdout"] == "file-credential-ok"
            await mcp.call_tool("session_close", {"session_id": session["id"]})
        await local_control(state, {"command": "pause"})
        first.terminate()
        output.extend(await asyncio.wait_for(first.communicate(), timeout=5))

        restarted = await launch()
        assert (await local_control(state, {"command": "status"}))["paused"] is True
        unbound = await local_control(state, {"command": "unbind"})
        assert unbound["ok"] is True
        assert unbound["cloud_revoked"] is True
        output.extend(await asyncio.wait_for(restarted.communicate(), timeout=5))
        assert not credential_file.exists()
        assert json.loads((state / "config.json").read_text())["revoked"] is True
        with pytest.raises(InvalidStatus) as refused_key:
            async with websockets.connect(
                network.ws_url, additional_headers={"Authorization": "Bearer " + device["key"]}
            ):
                pass
        assert refused_key.value.response.status_code in (401, 403)

        missing = await asyncio.create_subprocess_exec(
            *command,
            "run",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        processes.append(missing)
        stdout, stderr = await asyncio.wait_for(missing.communicate(), timeout=5)
        output.extend((stdout, stderr))
        assert missing.returncode == 1
        assert json.loads(stdout)["error"]
        assert not helper_marker.exists()
        assert device["key"].encode() not in b"".join(output)
    finally:
        for process in processes:
            if process.returncode is None:
                process.terminate()
                await asyncio.wait_for(process.communicate(), timeout=5)


async def test_owner_browser_reuse_keeps_foreground_local_and_remote_refs_isolated(
    network: Network, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def process_identity(_pid: int | None) -> str:
        return "a" * 64

    monkeypatch.setattr(cua_boundary, "_process_fingerprint", process_identity)
    monkeypatch.setattr(cua_boundary, "_chrome_dependency", lambda: {"installed": True, "version": "fixture"})
    peer = RecordingSDK()
    adapter = CuaDriverAdapter(
        sdk=peer.sdk,
        driver=peer,
        browser_profile=BrowserProfile(
            mode="existing_profile", pid=123, window_id=42, fingerprint="a" * 64, approved=True
        ),
    )
    response = await network.alice.post(
        "/api/devices", json={"name": "Foreground boundary", "capabilities": ["browser"]}
    )
    assert response.status_code == 201
    device = response.json()
    response = await network.alice.post(
        "/api/client-grants",
        json={"name": "Browser Agent", "device_ids": [device["id"]], "capabilities": ["browser"]},
    )
    assert response.status_code == 201
    grant = response.json()
    state = tmp_path / "device"
    async with (
        connected_device(
            network,
            device,
            state,
            executor=LocalExecutor(driver=adapter),
            capabilities={"browser": True},
        ),
        mcp_connection(network.url, grant["key"]) as mcp,
    ):
        tools = await mcp.list_tools()
        assert not {"browser_prepare", "browser-prepare"} & {tool.name for tool in tools.tools}
        before_prepare = await mcp.call_tool(
            "session_open", {"device_id": device["id"], "capabilities": ["browser"]}
        )
        assert before_prepare.isError is True
        denied = await mcp.call_tool(
            "browser_prepare", {"session_id": "not-an-owner", "delivery_mode": "foreground"}
        )
        assert denied.isError is True
        assert peer.calls == []
        prepared = await local_control(state, {"command": "browser-prepare"})
        assert prepared["ok"] is True
        assert len(peer.sessions) == 1
        owner_session = next(iter(peer.sessions))
        assert peer.trusted_options[0].ttl_seconds == 8 * 60 * 60
        assert peer.trusted_options[0].idle_ttl_seconds == 30 * 60
        session = decode(
            await mcp.call_tool("session_open", {"device_id": device["id"], "capabilities": ["browser"]})
        )
        opened = await mcp.call_tool(
            "browser_open",
            {"session_id": session["id"], "url": "https://example.invalid", "delivery_mode": "foreground"},
        )
        if opened.isError:
            opened = await mcp.call_tool(
                "browser_open", {"session_id": session["id"], "url": "https://example.invalid"}
            )
        opened = decode(opened)
        assert opened["status"] == "executed"
        old_observation = opened["result"]["observation_id"]
        prepares = [arguments for tool, arguments in peer.calls if tool == "browser_prepare"]
        assert len(prepares) == 1
        assert prepares[0]["delivery_mode"] == "foreground"
        await mcp.call_tool("session_close", {"session_id": session["id"]})
        async with asyncio.timeout(2):
            while peer.sessions != {owner_session}:
                await asyncio.sleep(0.01)
        assert peer.closed_handles == []
        second = decode(
            await mcp.call_tool("session_open", {"device_id": device["id"], "capabilities": ["browser"]})
        )
        current = decode(
            await mcp.call_tool(
                "browser_open", {"session_id": second["id"], "url": "https://example.invalid"}
            )
        )
        assert current["status"] == "executed"
        assert current["result"]["observation_id"] != old_observation
        stale = decode(
            await mcp.call_tool(
                "browser_act",
                {
                    "session_id": second["id"],
                    "observation_id": old_observation,
                    "action": {"type": "click", "element_ref": "p1:1"},
                },
            )
        )
        assert stale["status"] == "refused"
        assert stale["error"]["code"] == "stale_observation"
        assert peer.actions == []
        observed = decode(await mcp.call_tool("browser_observe", {"session_id": second["id"]}))
        assert observed["status"] == "executed"
        assert observed["result"]["target_id"] == opened["result"]["target_id"]
        await mcp.call_tool("session_close", {"session_id": second["id"]})
        paused = await local_control(state, {"command": "pause"})
        assert paused["ok"] and paused["paused"]
        assert paused["requested_capabilities"]["browser"] is True
        assert peer.sessions == set()
        assert peer.closed_handles == [owner_session]
        assert sum(tool == "browser_prepare" for tool, _ in peer.calls) == 1


async def test_local_browser_target_change_closes_browser_only_and_rejects_stale_identity(
    network: Network, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current_fingerprint = ["a" * 64]

    async def process_identity(_pid: int | None) -> str:
        return current_fingerprint[0]

    monkeypatch.setattr(cua_boundary, "_process_fingerprint", process_identity)
    monkeypatch.setattr(cua_boundary, "_chrome_dependency", lambda: {"installed": True, "version": "fixture"})
    peer = RecordingSDK()
    adapter = CuaDriverAdapter(sdk=peer.sdk, driver=peer, browser_profile=BrowserProfile(mode="isolated"))
    created = await network.alice.post(
        "/api/devices", json={"name": "Local browser selection", "capabilities": ["browser", "shell"]}
    )
    assert created.status_code == 201
    device = created.json()
    created = await network.alice.post(
        "/api/client-grants",
        json={
            "name": "Profile acceptance",
            "device_ids": [device["id"]],
            "capabilities": ["browser", "shell"],
        },
    )
    assert created.status_code == 201
    grant = created.json()
    state = tmp_path / "device"
    async with (
        connected_device(
            network, device, state, executor=LocalExecutor(driver=adapter), capabilities={"browser": True}
        ),
        mcp_connection(network.url, grant["key"]) as mcp,
    ):
        browser = decode(
            await mcp.call_tool(
                "session_open",
                {
                    "device_id": device["id"],
                    "capabilities": ["browser"],
                },
            )
        )
        assert (
            decode(
                await mcp.call_tool(
                    "browser_open",
                    {
                        "session_id": browser["id"],
                        "url": "https://example.invalid",
                    },
                )
            )["status"]
            == "executed"
        )
        shell = decode(
            await mcp.call_tool(
                "session_open",
                {
                    "device_id": device["id"],
                    "capabilities": ["shell"],
                },
            )
        )
        marker, gate = tmp_path / "shell-started", tmp_path / "shell-gate"
        command = f"printf ready > {shlex.quote(str(marker))}; while [ ! -f {shlex.quote(str(gate))} ]; do sleep 0.05; done; printf target-change-preserved-shell"
        operation = decode(
            await mcp.call_tool("command_execute", {"session_id": shell["id"], "command": command})
        )
        await wait_for_file(marker)
        selected = await local_control(
            state,
            {
                "command": "browser-target",
                "profile": {
                    "mode": "existing_profile",
                    "pid": 123,
                    "window_id": 42,
                    "fingerprint": current_fingerprint[0],
                    "approved": True,
                },
            },
        )
        assert selected["ok"] is True
        assert selected["paused"] is False
        assert selected["requested_capabilities"]["shell"] is True
        async with asyncio.timeout(3):
            while True:
                closed = await mcp.call_tool("browser_observe", {"session_id": browser["id"]})
                if closed.isError:
                    break
                assert decode(closed)["status"] == "refused"
                await asyncio.sleep(0.02)
        assert decode(await mcp.call_tool("command_status", {"operation_id": operation["operation_id"]}))[
            "status"
        ] in {"accepted", "dispatched"}
        gate.write_text("continue")
        assert (await poll_result(mcp, operation["operation_id"]))["result"][
            "stdout"
        ] == "target-change-preserved-shell"
        await mcp.call_tool("session_close", {"session_id": shell["id"]})

        assert (await local_control(state, {"command": "browser-prepare"}))["ok"] is True
        owner_session = next(iter(peer.sessions))
        fresh = decode(
            await mcp.call_tool(
                "session_open",
                {
                    "device_id": device["id"],
                    "capabilities": ["browser"],
                },
            )
        )
        prepared_count = sum(tool == "browser_prepare" for tool, _ in peer.calls)
        current_fingerprint[0] = "b" * 64
        expired = await local_control(state, {"command": "status"})
        assert expired["dependencies"]["browser"]["status"] == "expired"
        assert owner_session in peer.closed_handles
        refused = await mcp.call_tool(
            "browser_open", {"session_id": fresh["id"], "url": "https://example.invalid"}
        )
        assert refused.isError or decode(refused)["status"] == "refused"
        assert sum(tool == "browser_prepare" for tool, _ in peer.calls) == prepared_count
        await mcp.call_tool("session_close", {"session_id": fresh["id"]})


@dataclass
class Network:
    url: str
    alice: httpx.AsyncClient
    bob: httpx.AsyncClient

    @property
    def ws_url(self) -> str:
        return self.url.replace("http://", "ws://") + "/ws/device"

    async def add_device(self, account: httpx.AsyncClient, name: str) -> dict[str, Any]:
        response = await account.post("/api/devices", json={"name": name, "capabilities": ["shell", "files"]})
        assert response.status_code == 201, response.text
        return response.json()

    async def add_grant(self, account: httpx.AsyncClient, name: str, devices: list[str]) -> dict[str, Any]:
        response = await account.post(
            "/api/client-grants",
            json={"name": name, "device_ids": devices, "capabilities": ["shell", "files"]},
        )
        assert response.status_code == 201, response.text
        return response.json()


@pytest_asyncio.fixture
async def network(tmp_path: Path) -> AsyncIterator[Network]:
    database = tmp_path / "server.db"
    store = Store(database)
    store.create_user("alice", "alice-independent-password")
    store.create_user("bob", "bob-independent-password")
    store.close()
    with socket.socket() as available:
        available.bind(("127.0.0.1", 0))
        port = available.getsockname()[1]
    environment = dict(os.environ, ABRIDGE_DB=str(database), ABRIDGE_PORT=str(port), ABRIDGE_HOST="127.0.0.1")
    log = (tmp_path / "server.log").open("w")
    process = subprocess.Popen(
        [sys.executable, "-m", "abridge", "serve"], env=environment, stdout=log, stderr=log
    )
    url = f"http://127.0.0.1:{port}"
    try:
        async with (
            httpx.AsyncClient(base_url=url, trust_env=False) as alice,
            httpx.AsyncClient(base_url=url, trust_env=False) as bob,
        ):
            async with asyncio.timeout(10):
                while True:
                    if process.poll() is not None:
                        pytest.fail((tmp_path / "server.log").read_text())
                    try:
                        if (await alice.get("/health")).status_code == 200:
                            break
                    except httpx.ConnectError:
                        pass
                    await asyncio.sleep(0.03)
            assert (
                await alice.post(
                    "/api/login", json={"username": "alice", "password": "alice-independent-password"}
                )
            ).status_code == 200
            assert (
                await bob.post("/api/login", json={"username": "bob", "password": "bob-independent-password"})
            ).status_code == 200
            yield Network(url, alice, bob)
    finally:
        process.terminate()
        try:
            await asyncio.to_thread(process.wait, 5)
        except subprocess.TimeoutExpired:
            process.kill()
            await asyncio.to_thread(process.wait)
        log.close()


@asynccontextmanager
async def connected_device(
    network: Network,
    device: dict[str, Any],
    state_dir: Path,
    *,
    executor: LocalExecutor | None = None,
    capabilities: dict[str, bool] | None = None,
) -> AsyncIterator[DeviceClient]:
    config = {
        "url": network.url,
        "capabilities": {"shell": True, "files": True, "screen": False, "input": False},
        "paused": False,
        "revoked": False,
    }
    if capabilities is not None:
        config["capabilities"].update(capabilities)
    client = DeviceClient(state_dir, config, device["key"], executor=executor)
    running = asyncio.create_task(client.run())
    try:
        async with asyncio.timeout(5):
            while True:
                devices = (await network.alice.get("/api/devices")).json()["devices"]
                if any(item["id"] == device["id"] and item["status"] == "online" for item in devices):
                    break
                if running.done():
                    running.result()
                await asyncio.sleep(0.02)
        yield client
    finally:
        client.shutdown.set()
        await asyncio.wait_for(running, timeout=5)


@asynccontextmanager
async def mcp_connection(url: str, key: str) -> AsyncIterator[ClientSession]:
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {key}"}, trust_env=False) as http:
        async with streamable_http_client(url + "/mcp", http_client=http) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session


def decode(response: Any) -> dict[str, Any]:
    assert not response.isError, response.content
    if isinstance(response.structuredContent, dict):
        return response.structuredContent
    for content in response.content:
        if content.type == "text":
            value = json.loads(content.text)
            if isinstance(value, dict):
                return value
    raise AssertionError("MCP response has no JSON object")


async def poll_result(mcp: ClientSession, operation_id: str) -> dict[str, Any]:
    async with asyncio.timeout(5):
        while True:
            result = decode(await mcp.call_tool("command_status", {"operation_id": operation_id}))
            if result["status"] not in {"accepted", "dispatched"}:
                return result
            await asyncio.sleep(0.02)


async def wait_for_file(path: Path) -> None:
    async with asyncio.timeout(3):
        while not path.exists() or not path.read_text():
            await asyncio.sleep(0.02)


async def wait_for_exit(pid: int) -> None:
    async with asyncio.timeout(3):
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            await asyncio.sleep(0.02)
