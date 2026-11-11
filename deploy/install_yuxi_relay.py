"""为同机 Docker Yuxi 安装仅监听容器网关的 aBridge TCP 转发。"""

from __future__ import annotations

import argparse
import ipaddress
import json
import shlex
import subprocess


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--docker-gateway", required=True)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    gateway = ipaddress.ip_address(args.docker_gateway)
    if not gateway.is_private or gateway.is_loopback or gateway.version != 4:
        parser.error("docker-gateway must be a private IPv4 bridge address")
    if not 1024 <= args.port <= 65535 or args.ssh_host.startswith("-"):
        parser.error("invalid port or SSH host")
    remote_script = r"""
import json
from pathlib import Path
import subprocess
import sys

settings = json.load(sys.stdin)
proxy = Path("/lib/systemd/systemd-socket-proxyd")
if not proxy.is_file():
    raise RuntimeError("systemd-socket-proxyd is not installed")
units = Path.home() / ".config/systemd/user"
units.mkdir(parents=True, exist_ok=True)
socket_unit = "\n".join([
    "[Unit]", "Description=aBridge relay for local Yuxi containers", "",
    "[Socket]", "ListenStream=" + settings["gateway"] + ":" + str(settings["port"]),
    "NoDelay=true", "", "[Install]", "WantedBy=sockets.target", "",
])
service_unit = "\n".join([
    "[Unit]", "Description=Forward local Yuxi containers to aBridge loopback",
    "Requires=abridge.service", "After=abridge.service", "", "[Service]",
    "ExecStart=" + str(proxy) + " 127.0.0.1:8765", "NoNewPrivileges=true", "",
])
for name, content in (("abridge-yuxi-relay.socket", socket_unit), ("abridge-yuxi-relay.service", service_unit)):
    path = units / name
    path.write_text(content)
    path.chmod(0o600)
subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
subprocess.run(["systemctl", "--user", "enable", "--now", "abridge-yuxi-relay.socket"], check=True)
print("Installed Docker-only aBridge relay at " + settings["gateway"] + ":" + str(settings["port"]))
"""
    subprocess.run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            args.ssh_host,
            shlex.join(["python3", "-c", remote_script]),
        ],
        input=json.dumps({"gateway": str(gateway), "port": args.port}),
        text=True,
        check=True,
    )


if __name__ == "__main__":
    main()
