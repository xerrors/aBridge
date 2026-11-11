"""Serve an owned local form for Yuxi browser acceptance; no personal browser data."""

from __future__ import annotations

import argparse
import html
import json
import secrets
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--port", type=int, default=0)
    arguments = parser.parse_args()
    state = {
        "code": secrets.token_hex(3).upper(),
        "text": "",
        "submit_count": 0,
        "port": None,
        "cookie_verified": False,
    }
    session_cookie = secrets.token_urlsafe(24)
    arguments.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def persist() -> None:
        temporary = arguments.state.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        temporary.chmod(0o600)
        temporary.replace(arguments.state)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/seed":
                self.send_response(303)
                self.send_header(
                    "Set-Cookie",
                    f"abridge_fixture={session_cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600",
                )
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if self.path != "/":
                self.send_error(404)
                return
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            entry = cookies.get("abridge_fixture")
            state["cookie_verified"] = entry is not None and secrets.compare_digest(
                entry.value, session_cookie
            )
            persist()
            page = render(state).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(page)

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            if self.path != "/submit" or not 0 < length <= 4096:
                self.send_error(400)
                return
            data = parse_qs(self.rfile.read(length).decode(), keep_blank_values=True)
            text = data.get("message", [""])[0]
            if len(text) > 500:
                self.send_error(400)
                return
            state["text"] = text
            state["submit_count"] += 1
            persist()
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            return

    server = HTTPServer(("127.0.0.1", arguments.port), Handler)
    state["port"] = server.server_port
    persist()
    print(
        json.dumps({"url": f"http://127.0.0.1:{server.server_port}/", "state": str(arguments.state)}),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def render(state: dict) -> str:
    return f'''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>aBridge 浏览器验收</title>
<style>body{{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:24px auto;padding:20px;color:#172336;background:#f4f6fa}}main{{padding:20px;background:white;border:1px solid #dce4ee}}h1{{font-size:24px}}strong{{font-size:28px}}input{{display:block;box-sizing:border-box;width:100%;padding:10px;font:inherit;margin:10px 0}}button{{background:#0064e1;color:white;border:0;padding:10px 18px;font:inherit;cursor:pointer}}output{{display:block;margin-top:12px}}</style>
<main><h1>aBridge 浏览器验收</h1><p>页面验证码：<strong>{state["code"]}</strong></p>
<p>当前会话：{"已登录" if state["cookie_verified"] else "未登录"}</p>
<form action="/submit" method="post"><label for="message">验收输入</label>
<input id="message" name="message" maxlength="500" value="{html.escape(state["text"], quote=True)}" autocomplete="off">
<button type="submit">提交验证</button></form>
<output>提交次数：{state["submit_count"]}</output><p>已保存内容：{html.escape(state["text"])}</p></main></html>'''


if __name__ == "__main__":
    main()
