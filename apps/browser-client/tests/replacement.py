"""在安装了发行物依赖的 Linux 上运行：python -I replacement.py <解包目录>。"""

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread


class DeviceFixture(BaseHTTPRequestHandler):
    """首次兑换得到可用 Key，第二次兑换后设备验证被拒绝。"""

    def reply(self, data):
        """返回本地设备响应。"""
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        """按票据生成测试凭据。"""
        if self.path != "/api/managed-browsers/redeem":
            return self.send_error(404)
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.reply({
            "kind": "browser",
            "capabilities": ["browser"],
            "device_id": "fixture",
            "key": "abr_device_" + request["bootstrap_token"],
        })

    def do_GET(self):
        """仅为首次绑定返回匹配的设备，扩展通过真实 HTTP 验证。"""
        if self.path == "/api/device" and self.headers.get("Authorization") == "Bearer abr_device_first":
            return self.reply({"id": "fixture", "name": "Fixture", "kind": "browser", "capabilities": ["browser"]})
        self.send_error(401 if self.path == "/api/device" else 404)

    def log_message(self, *args):
        """省略本地 HTTP 访问记录。"""


def verify(bundle):
    """从公开 CLI 提交两次绑定，在替换被拒绝后恢复原绑定。"""
    with TemporaryDirectory() as state, ThreadingHTTPServer(("127.0.0.1", 0), DeviceFixture) as server:
        Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{server.server_port}"
        original = {"browser_origin": origin, "device_id": "fixture", "revision": 1}

        def cli(action, handoff=None, *, check=True):
            """通过 stdin 调用候选包里的客户端。"""
            return subprocess.run(
                [sys.executable, "-I", bundle / "abridge-client-browser", action],
                env={**os.environ, "ABRIDGE_BROWSER_HOME": state},
                input=json.dumps(handoff) if handoff else None,
                text=True, capture_output=True, check=check, timeout=50,
            )

        try:
            assert json.loads(cli("start", {**original, "bootstrap_token": "first"}).stdout)["status"] == "running"
            replacement = {**original, "revision": 2, "bootstrap_token": "rejected"}
            rejected = cli("start", replacement, check=False)
            assert rejected.returncode == 1 and json.loads(rejected.stdout) == {"status": "failed"}
            assert json.loads(cli("status").stdout) == {**original, "status": "bound"}
            restored = json.loads(cli("start", original).stdout)
            assert restored["revision"] == 1 and restored["status"] == "running"
        finally:
            try:
                cli("stop", check=False)
            finally:
                server.shutdown()


if __name__ == "__main__":
    verify(Path(sys.argv[1]).resolve())
