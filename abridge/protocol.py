"""The capability and device-tool contract shared by the server and client."""

from typing import Literal, get_args

Capability = Literal["screen", "input", "shell", "files", "browser"]
CAPABILITIES = frozenset(get_args(Capability))
OBSERVATION_SECONDS = 10
TOOL_CAPABILITIES = {
    "computer_apps": "screen",
    "computer_windows": "screen",
    "computer_observe": "screen",
    "computer_act": "input",
    "browser_open": "browser",
    "browser_observe": "browser",
    "browser_act": "browser",
    "command_execute": "shell",
    "files_list": "files",
    "file_read": "files",
    "file_write": "files",
}
