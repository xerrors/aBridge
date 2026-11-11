"""A restarting server or tunnel may close before sending the WebSocket handshake."""

import asyncio
import json
from pathlib import Path

import pytest
import websockets

from abridge.client import DeviceClient


@pytest.mark.parametrize("failure", ["eof", "invalid_http"])
async def test_handshake_failure_retries_and_connects_to_recovered_server(tmp_path: Path, failure: str):
    dropped = asyncio.Event()
    online = asyncio.Event()
    hellos = []

    async def unavailable(reader, writer):
        try:
            await reader.readuntil(b"\r\n\r\n")
            if failure == "invalid_http":
                writer.write(b"This is not an HTTP response\r\n\r\n")
                await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            dropped.set()

    async def recovered(websocket):
        hellos.append(json.loads(await websocket.recv()))
        await websocket.send(
            json.dumps(
                {
                    "type": "welcome",
                    "protocol": "abridge/1",
                    "device_id": "dev_recovered",
                    "connection_epoch": 1,
                    "capabilities": [],
                    "heartbeat_interval": 10,
                    "lease_seconds": 30,
                }
            )
        )
        online.set()
        await websocket.wait_closed()

    unavailable_server = await asyncio.start_server(unavailable, "127.0.0.1", 0)
    port = unavailable_server.sockets[0].getsockname()[1]
    client = DeviceClient(
        tmp_path,
        {"url": f"http://127.0.0.1:{port}", "capabilities": {}, "paused": False},
        "abr_device_reconnect_test",
    )
    running = asyncio.create_task(client.run())
    try:
        await asyncio.wait_for(dropped.wait(), timeout=5)
        unavailable_server.close()
        await unavailable_server.wait_closed()
        async with websockets.serve(recovered, "127.0.0.1", port):
            await asyncio.wait_for(online.wait(), timeout=5)
            async with asyncio.timeout(2):
                while client.status["connection"] != "online":
                    await asyncio.sleep(0.01)
            assert not running.done()
            assert hellos[0]["protocol"] == "abridge/1"
            assert client.status["connection"] == "online"
    finally:
        unavailable_server.close()
        await unavailable_server.wait_closed()
        client.shutdown.set()
        await asyncio.wait_for(running, timeout=5)
