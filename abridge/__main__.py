"""Command-line entry points for server administration and the device agent."""

from __future__ import annotations

import argparse
import getpass
import os
import sqlite3
import sys


def main() -> None:
    parser = argparse.ArgumentParser(prog="abridge")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve", help="Run the single-worker server")
    user_parser = commands.add_parser("user", help="Manage independent server accounts")
    users = user_parser.add_subparsers(dest="action", required=True)
    create = users.add_parser("create")
    create.add_argument("username")
    create.add_argument("--password-stdin", action="store_true")
    commands.add_parser("client", help="Device client; use `abridge client --help`")
    if len(sys.argv) > 1 and sys.argv[1] == "client":
        from abridge.client import main as client_main

        sys.argv = [sys.argv[0], *sys.argv[2:]]
        client_main()
        return
    arguments = parser.parse_args()
    if arguments.command == "serve":
        import uvicorn

        uvicorn.run(
            "abridge.server:app",
            host=os.environ.get("ABRIDGE_HOST", "127.0.0.1"),
            port=int(os.environ.get("ABRIDGE_PORT", "8765")),
            workers=1,
            ws_max_size=8 * 1024 * 1024,
            access_log=False,
        )
    elif arguments.command == "user":
        from abridge.storage import Store

        password = (
            sys.stdin.readline().rstrip("\r\n")
            if arguments.password_stdin
            else getpass.getpass("Password (12+ characters): ")
        )
        store = Store(os.environ.get("ABRIDGE_DB", "~/.local/share/abridge/server.db"))
        try:
            user = store.create_user(arguments.username, password)
            print(f"Created account {user['username']} ({user['id']})")
        except (ValueError, sqlite3.IntegrityError) as error:
            parser.exit(1, f"Cannot create account: {error}\n")
        finally:
            store.close()


if __name__ == "__main__":
    main()
