"""Local tools run with the signed-in user's existing macOS permissions."""

from __future__ import annotations

import asyncio
import codecs
import json
import os
import signal
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

MAX_FILE_BYTES = 1_048_576
MAX_OUTPUT_BYTES = 131_072
MAX_COMMAND_SECONDS = 120
OBSERVATION_SECONDS = 10
TOOL_CAPABILITIES = {
    "computer_observe": "screen",
    "computer_act": "input",
    "command_execute": "shell",
    "files_list": "files",
    "file_read": "files",
    "file_write": "files",
}


class ExecutionError(Exception):
    """An expected refusal or local execution failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class LocalExecutor:
    """Execute tools, own their subprocesses, and retain short-lived observations."""

    def __init__(self, helper: str | None = None) -> None:
        self.helper = helper or os.environ.get("ABRIDGE_DESKTOP_HELPER")
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        self.observations: dict[str, dict[str, Any]] = {}
        self.on_output: Callable[[str, str, str], Awaitable[None]] | None = None

    async def execute(self, operation_id: str, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if tool == "command_execute":
            return await self.command_execute(operation_id, arguments)
        if tool == "computer_observe":
            return await self.computer_observe()
        if tool == "computer_act":
            return await self.computer_act(arguments)
        if tool == "files_list":
            return await asyncio.to_thread(self.files_list, arguments)
        if tool == "file_read":
            return await asyncio.to_thread(self.file_read, arguments)
        if tool == "file_write":
            return await asyncio.to_thread(self.file_write, arguments)
        raise ExecutionError("unknown_tool", "Unknown device tool")

    async def cancel(self, operation_ids: list[str] | None = None) -> None:
        selected = list(self.processes) if operation_ids is None else operation_ids
        for operation_id in selected:
            process = self.processes.get(operation_id)
            if process is not None:
                await _terminate_process_tree(process)

    async def permissions(self) -> dict[str, bool]:
        if self.helper is None:
            return {"screen": False, "input": False}
        try:
            result = await self._native({"action": "permissions"})
        except (ExecutionError, OSError):
            return {"screen": False, "input": False}
        return {"screen": result.get("screen") is True, "input": result.get("input") is True}

    async def command_execute(self, operation_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
        command = _required_string(arguments, "command")
        timeout = arguments.get("timeout", 30)
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not 1 <= timeout <= MAX_COMMAND_SECONDS
        ):
            raise ExecutionError("invalid_arguments", "timeout must be between 1 and 120 seconds")
        cwd = Path(arguments.get("cwd") or Path.home()).expanduser()
        if not cwd.is_dir():
            raise ExecutionError("invalid_cwd", "Working directory does not exist")
        supplied_env = arguments.get("env", {})
        if not isinstance(supplied_env, dict) or any(
            not isinstance(k, str) or not isinstance(v, str) or "=" in k or "\0" in k + v
            for k, v in supplied_env.items()
        ):
            raise ExecutionError("invalid_arguments", "env must contain string names and values")
        environment = {
            key: os.environ[key]
            for key in ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR")
            if key in os.environ
        }
        environment.update(supplied_env)
        process = await asyncio.create_subprocess_exec(
            "/bin/sh",
            "-c",
            command,
            cwd=str(cwd),
            env=environment,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        self.processes[operation_id] = process
        stdout_task = asyncio.create_task(self._read_output(operation_id, "stdout", process.stdout))
        stderr_task = asyncio.create_task(self._read_output(operation_id, "stderr", process.stderr))
        timed_out = False
        try:
            try:
                await asyncio.wait_for(process.wait(), timeout=float(timeout))
            except TimeoutError:
                timed_out = True
                await _terminate_process_tree(process)
            stdout, stdout_truncated = await stdout_task
            stderr, stderr_truncated = await stderr_task
            return {
                "exit_code": process.returncode,
                "stdout": stdout,
                "stderr": stderr,
                "truncated": stdout_truncated or stderr_truncated,
                "timed_out": timed_out,
            }
        finally:
            # Cancellation also reaches here; cleanup is not delegated to a caller.
            await _terminate_process_tree(process)
            stdout_task.cancel()
            stderr_task.cancel()
            self.processes.pop(operation_id, None)

    async def computer_observe(self) -> dict[str, Any]:
        result = await self._native({"action": "observe"})
        observation_id = "obs_" + uuid.uuid4().hex
        observed_at = time.time()
        self.observations = {
            key: value
            for key, value in self.observations.items()
            if observed_at - value["observed_at"] < OBSERVATION_SECONDS
        }
        observation = {key: value for key, value in result.items() if key != "image_base64"}
        observation.update(observation_id=observation_id, observed_at=observed_at)
        self.observations[observation_id] = observation
        return {
            **result,
            "observation_id": observation_id,
            "observed_at": observed_at,
            "expires_in": OBSERVATION_SECONDS,
        }

    async def computer_act(self, arguments: dict[str, Any]) -> dict[str, Any]:
        observation_id = _required_string(arguments, "observation_id")
        observation = self.observations.get(observation_id)
        if observation is None or time.time() - observation["observed_at"] > OBSERVATION_SECONDS:
            raise ExecutionError("stale_observation", "Observe the desktop again before acting")
        action = arguments.get("action")
        if not isinstance(action, dict):
            raise ExecutionError("invalid_arguments", "action must be an object")
        return await self._native({"action": "act", "observation": observation, "input": action})

    def files_list(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = Path(_required_string(arguments, "path")).expanduser()
        limit = arguments.get("limit", 200)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
            raise ExecutionError("invalid_arguments", "limit must be between 1 and 500")
        entries = []
        with os.scandir(path) as directory:
            for entry in directory:
                if len(entries) == limit:
                    return {"path": str(path), "entries": entries, "truncated": True}
                stat = entry.stat(follow_symlinks=False)
                entries.append(
                    {
                        "name": entry.name,
                        "is_directory": entry.is_dir(follow_symlinks=False),
                        "is_symlink": entry.is_symlink(),
                        "size": stat.st_size,
                        "modified_at": stat.st_mtime,
                    }
                )
        entries.sort(key=lambda entry: entry["name"].casefold())
        return {"path": str(path), "entries": entries, "truncated": False}

    def file_read(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = Path(_required_string(arguments, "path")).expanduser()
        max_bytes = arguments.get("max_bytes", MAX_FILE_BYTES)
        if (
            isinstance(max_bytes, bool)
            or not isinstance(max_bytes, int)
            or not 1 <= max_bytes <= MAX_FILE_BYTES
        ):
            raise ExecutionError("invalid_arguments", "max_bytes must be between 1 and 1048576")
        with path.open("rb") as stream:
            content = stream.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise ExecutionError("file_too_large", "File exceeds the requested size limit")
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ExecutionError("unsupported_encoding", "File must contain UTF-8 text") from error
        return {"path": str(path), "content": text, "size": len(content)}

    def file_write(self, arguments: dict[str, Any]) -> dict[str, Any]:
        path = Path(_required_string(arguments, "path")).expanduser()
        content = arguments.get("content")
        if not isinstance(content, str):
            raise ExecutionError("invalid_arguments", "content must be a string")
        data = content.encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            raise ExecutionError("file_too_large", "Content exceeds the 1048576 byte limit")
        overwrite = arguments.get("overwrite", False)
        if not isinstance(overwrite, bool):
            raise ExecutionError("invalid_arguments", "overwrite must be a boolean")
        # Exclusive create is atomic: the default never races into overwriting a file.
        with path.open("wb" if overwrite else "xb") as stream:
            stream.write(data)
        return {"path": str(path), "size": len(data), "overwritten": overwrite}

    async def _native(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.helper is None:
            raise ExecutionError("desktop_unavailable", "The native macOS helper is not installed")
        process = await asyncio.create_subprocess_exec(
            self.helper,
            "--helper",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(json.dumps(request).encode()), timeout=15)
        except (TimeoutError, asyncio.CancelledError):
            process.kill()
            await process.wait()
            if request.get("action") == "act":
                await self._release_inputs()
            raise
        if process.returncode != 0:
            raise ExecutionError("desktop_failed", "The native desktop helper failed")
        try:
            result = json.loads(output)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ExecutionError(
                "desktop_failed", "The native desktop helper returned an invalid response"
            ) from error
        if result.get("error"):
            raise ExecutionError(
                result["error"].get("code", "desktop_failed"),
                result["error"].get("message", "Desktop operation failed"),
            )
        return result

    async def _read_output(
        self, operation_id: str, stream_name: str, stream: asyncio.StreamReader | None
    ) -> tuple[str, bool]:
        if stream is None:
            return "", False
        data = bytearray()
        truncated = False
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while chunk := await stream.read(16_384):
            remaining = MAX_OUTPUT_BYTES - len(data)
            accepted = chunk[:remaining]
            data.extend(accepted)
            text = decoder.decode(accepted)
            if text and self.on_output is not None:
                await self.on_output(operation_id, stream_name, text)
            if len(chunk) > remaining:
                truncated = True
        tail = decoder.decode(b"", final=True)
        if tail and self.on_output is not None:
            await self.on_output(operation_id, stream_name, tail)
        return data.decode("utf-8", errors="replace"), truncated

    async def _release_inputs(self) -> None:
        process = await asyncio.create_subprocess_exec(
            self.helper,
            "--helper",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(process.communicate(b'{"action":"release_inputs"}'), timeout=3)
        except TimeoutError:
            process.kill()
            await process.wait()


async def native_request(helper: str, request: dict[str, Any]) -> dict[str, Any]:
    """Use the native helper for Keychain requests without exposing a key in argv."""
    return await LocalExecutor(helper)._native(request)


def _required_string(arguments: dict[str, Any], key: str) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or not value or "\0" in value:
        raise ExecutionError("invalid_arguments", f"{key} must be a non-empty string")
    return value


async def _terminate_process_tree(process: asyncio.subprocess.Process) -> None:
    # The process-group ID remains its original PID even when the shell exits first.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    await asyncio.sleep(0.15)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if process.returncode is None:
        await process.wait()
