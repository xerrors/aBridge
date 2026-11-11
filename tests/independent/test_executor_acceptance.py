"""Independent checks of observable local file and process behavior."""

from __future__ import annotations

import asyncio
import os
import shlex
from pathlib import Path

import pytest

from abridge.executor import ExecutionError, LocalExecutor


async def test_cancel_stops_shell_and_background_child(tmp_path: Path) -> None:
    executor = LocalExecutor()
    child_pid_file = tmp_path / "child.pid"
    command = f"sleep 60 & child=$!; printf '%s' \"$child\" > {shlex.quote(str(child_pid_file))}; wait"
    running = asyncio.create_task(
        executor.execute(
            "cancel-check",
            "command_execute",
            {
                "command": command,
                "cwd": str(tmp_path),
                "timeout": 10,
            },
        )
    )
    try:
        await wait_for_file(child_pid_file)
        child_pid = int(child_pid_file.read_text())
        os.kill(child_pid, 0)
        await executor.cancel(["cancel-check"])
        result = await asyncio.wait_for(running, timeout=3)
        assert result["exit_code"] != 0
        await wait_for_exit(child_pid)
        assert executor.processes == {}
    finally:
        await executor.cancel()
        if not running.done():
            running.cancel()


async def test_timeout_stops_background_child(tmp_path: Path) -> None:
    executor = LocalExecutor()
    child_pid_file = tmp_path / "timeout-child.pid"
    command = f"sleep 60 & child=$!; printf '%s' \"$child\" > {shlex.quote(str(child_pid_file))}; wait"
    result = await asyncio.wait_for(
        executor.execute(
            "timeout-check",
            "command_execute",
            {
                "command": command,
                "cwd": str(tmp_path),
                "timeout": 1,
            },
        ),
        timeout=4,
    )
    child_pid = int(child_pid_file.read_text())
    assert result["timed_out"] is True
    assert result["exit_code"] != 0
    await wait_for_exit(child_pid)


async def test_files_match_real_utf8_content_and_refuse_implicit_overwrite(tmp_path: Path) -> None:
    executor = LocalExecutor()
    target = tmp_path / "中文验证.txt"
    await executor.execute("write-check", "file_write", {"path": str(target), "content": "你好，aBridge\n"})
    assert target.read_text(encoding="utf-8") == "你好，aBridge\n"
    observed = await executor.execute("read-check", "file_read", {"path": str(target)})
    assert observed["content"] == target.read_text(encoding="utf-8")
    with pytest.raises(FileExistsError):
        await executor.execute("overwrite-check", "file_write", {"path": str(target), "content": "lost"})
    assert target.read_text(encoding="utf-8") == "你好，aBridge\n"
    listed = await executor.execute("list-check", "files_list", {"path": str(tmp_path)})
    assert "中文验证.txt" in [entry["name"] for entry in listed["entries"]]


async def test_command_output_is_bounded_without_stalling_child(tmp_path: Path) -> None:
    executor = LocalExecutor()
    command = "dd if=/dev/zero bs=1024 count=256 2>/dev/null | tr '\\000' x"
    result = await asyncio.wait_for(
        executor.execute(
            "output-check",
            "command_execute",
            {
                "command": command,
                "cwd": str(tmp_path),
                "timeout": 3,
            },
        ),
        timeout=5,
    )
    assert result["exit_code"] == 0
    assert result["truncated"] is True
    assert len(result["stdout"].encode()) == 131_072
    assert result["timed_out"] is False


async def test_desktop_action_requires_current_observation() -> None:
    executor = LocalExecutor()
    with pytest.raises(ExecutionError, match="Observe the desktop again") as refused:
        await executor.execute(
            "stale-check",
            "computer_act",
            {
                "observation_id": "not-observed",
                "action": {"type": "click", "x": 1, "y": 1},
            },
        )
    assert refused.value.code == "stale_observation"


async def test_streaming_preserves_utf8_split_across_read_chunks(tmp_path: Path) -> None:
    executor = LocalExecutor()
    chunks: list[str] = []

    async def capture(_operation_id: str, _stream: str, content: str) -> None:
        chunks.append(content)

    executor.on_output = capture
    text = "你" * 6_000
    result = await executor.execute(
        "unicode-stream",
        "command_execute",
        {
            "command": "printf %s " + shlex.quote(text),
            "cwd": str(tmp_path),
            "timeout": 3,
        },
    )
    assert result["stdout"] == text
    streamed = "".join(chunks)
    assert streamed.count("\ufffd") == 0
    assert streamed == text


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
