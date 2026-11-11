"""Browser polling must keep the account session valid and serialize SQLite access."""

import asyncio
import threading
from pathlib import Path

import httpx

from abridge.server import create_app


async def test_concurrent_polling_uses_asgi_thread_and_keeps_session(tmp_path: Path) -> None:
    app = create_app(tmp_path / "polling.db")
    store = app.state.store
    store.create_user("owner", "owner-password-123")
    asgi_thread = threading.get_ident()
    account_threads: set[int] = set()
    original_account = store.account

    def record_account_thread(token: str):
        account_threads.add(threading.get_ident())
        return original_account(token)

    store.account = record_account_thread
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://localhost"
        ) as client:
            logged_in = await client.post(
                "/api/login", json={"username": "owner", "password": "owner-password-123"}
            )
            assert logged_in.status_code == 200
            responses = await asyncio.gather(
                *[
                    client.get(path)
                    for _ in range(20)
                    for path in ("/api/devices", "/api/client-grants", "/api/activity")
                ]
            )
            assert all(response.status_code == 200 for response in responses)
            assert account_threads == {asgi_thread}
            assert (await client.get("/api/me")).json()["username"] == "owner"
    finally:
        store.close()
