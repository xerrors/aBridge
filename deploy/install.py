"""Install aBridge's private service or its local SSH tunnel.

The service listens on the server's loopback interface. The Mac uses a
launchd-managed SSH tunnel, so device and MCP traffic crosses the network
inside SSH without exposing another public port.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shlex
import subprocess
import sys
from pathlib import Path

TUNNEL_LABEL = "app.abridge.tunnel"
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    server = commands.add_parser("server", help="Install the single-process server over SSH")
    server.add_argument("--ssh-host", required=True)
    server.add_argument("--remote-root", required=True)
    server.add_argument("--port", default=8765, type=int)

    tunnel = commands.add_parser("tunnel", help="Install this Mac's SSH tunnel LaunchAgent")
    tunnel.add_argument("--ssh-host", required=True)
    tunnel.add_argument("--port", default=8765, type=int)

    arguments = parser.parse_args()
    if not 1024 <= arguments.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    if arguments.ssh_host.startswith("-"):
        parser.error("ssh-host must be an SSH host name")

    if arguments.command == "server":
        install_server(arguments.ssh_host, arguments.remote_root, arguments.port)
    else:
        install_tunnel(arguments.ssh_host, arguments.port)


def install_server(ssh_host: str, remote_root: str, port: int) -> None:
    root = Path(remote_root)
    if not root.is_absolute() or any(character in remote_root for character in "\n\r\0"):
        raise ValueError("remote-root must be an absolute path without control characters")

    source = str(root / "source")
    state = str(root / "state")
    ssh(ssh_host, ["mkdir", "-p", source, state])
    subprocess.run(
        [
            "rsync",
            "-az",
            "--delete",
            "--exclude=._*",
            "--exclude=__pycache__/",
            str(PROJECT_ROOT / "abridge"),
            str(PROJECT_ROOT / "pyproject.toml"),
            str(PROJECT_ROOT / "uv.lock"),
            str(PROJECT_ROOT / "README.md"),
            f"{ssh_host}:{shlex.quote(source)}/",
        ],
        check=True,
    )
    remote_setup = r"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

settings = json.load(sys.stdin)
root = Path(settings["root"])
source = root / "source"
state = root / "state"
state.chmod(0o700)
uv = Path.home() / ".local/bin/uv"
environment = dict(os.environ, UV_CACHE_DIR=str(root / "uv-cache"))
subprocess.run([str(uv), "sync", "--frozen", "--no-dev", "--python", "/usr/bin/python3"],
               cwd=source, env=environment, check=True)

def systemd_quote(value):
    return '"' + value.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"') + '"'

unit = "\n".join([
    "[Unit]", "Description=aBridge private device gateway", "After=network.target", "",
    "[Service]", "Type=simple",
    "WorkingDirectory=" + str(source).replace("%", "%%"),
    "ExecStart=" + systemd_quote(str(source / ".venv/bin/abridge")) + " serve",
    "Environment=" + systemd_quote("ABRIDGE_DB=" + str(state / "server.db")),
    "Environment=ABRIDGE_HOST=127.0.0.1", "Environment=ABRIDGE_PORT=" + str(settings["port"]),
    "Environment=PYTHONUNBUFFERED=1", "UMask=0077", "Restart=on-failure", "RestartSec=3",
    "TimeoutStopSec=15", "KillMode=control-group", "NoNewPrivileges=true", "",
    "[Install]", "WantedBy=default.target", "",
])
unit_path = Path.home() / ".config/systemd/user/abridge.service"
unit_path.parent.mkdir(parents=True, exist_ok=True)
unit_path.write_text(unit)
unit_path.chmod(0o600)
subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
subprocess.run(["systemctl", "--user", "enable", "abridge.service"], check=True)
subprocess.run(["systemctl", "--user", "restart", "abridge.service"], check=True)
print("Installed aBridge at", root)
"""
    ssh(ssh_host, ["python3", "-c", remote_setup], json.dumps({"root": remote_root, "port": port}))


def install_tunnel(ssh_host: str, port: int) -> None:
    if sys.platform != "darwin":
        raise RuntimeError("The tunnel installer requires macOS launchd")

    home = Path.home()
    log_directory = home / "Library/Logs/aBridge"
    log_directory.mkdir(parents=True, exist_ok=True)
    log_directory.chmod(0o700)
    launch_agents = home / "Library/LaunchAgents"
    launch_agents.mkdir(parents=True, exist_ok=True)
    plist_path = launch_agents / f"{TUNNEL_LABEL}.plist"
    configuration = {
        "Label": TUNNEL_LABEL,
        "ProgramArguments": [
            "/usr/bin/ssh",
            "-N",
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            "-o",
            "ConnectTimeout=10",
            "-L",
            f"127.0.0.1:{port}:127.0.0.1:{port}",
            ssh_host,
        ],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 15,
        "StandardOutPath": str(log_directory / "tunnel.log"),
        "StandardErrorPath": str(log_directory / "tunnel.log"),
        "LimitLoadToSessionType": "Aqua",
    }
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{domain}/{TUNNEL_LABEL}"], capture_output=True)
    with plist_path.open("wb") as destination:
        plistlib.dump(configuration, destination)
    plist_path.chmod(0o600)
    subprocess.run(["launchctl", "bootstrap", domain, str(plist_path)], check=True)
    print(f"Installed SSH tunnel: http://127.0.0.1:{port}")


def ssh(ssh_host: str, command: list[str], input_text: str | None = None) -> None:
    subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ssh_host, shlex.join(command)],
        input=input_text,
        text=True,
        check=True,
    )


if __name__ == "__main__":
    main()
