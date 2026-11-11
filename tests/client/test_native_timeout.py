"""A locked or blocked Keychain helper must return an actionable error."""

import asyncio
from pathlib import Path

import pytest

from abridge.executor import ExecutionError, native_request


async def test_native_helper_timeout_reports_unlock_and_retry(tmp_path: Path, monkeypatch) -> None:
    helper = tmp_path / "waiting-helper"
    helper.write_text("#!/bin/sh\nexec sleep 30\n")
    helper.chmod(0o700)
    original_wait_for = asyncio.wait_for

    async def short_wait(awaitable, timeout):
        return await original_wait_for(awaitable, timeout=0.02)

    monkeypatch.setattr(asyncio, "wait_for", short_wait)
    with pytest.raises(ExecutionError) as failed:
        await native_request(str(helper), {"action": "keychain_get", "service": "test", "account": "test"})
    assert failed.value.code == "native_timeout"
    assert "Unlock this Mac" in str(failed.value)
    assert "Keychain prompt" in str(failed.value)
    assert "retry" in str(failed.value)
