"""Persistent identities, grants and operation metadata for a single server."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

CAPABILITIES = frozenset({"screen", "input", "shell", "files"})


class Store:
    """A connection owned by one ASGI event loop, or by one administration command."""

    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.path.chmod(0o600)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        self._migrate()

    def recover_after_restart(self) -> None:
        """Fence abandoned work once, at server startup, never on a CLI connection."""
        self.db.execute(
            "UPDATE operations SET status='outcome_unknown', finished_at=? WHERE status IN ('accepted','dispatched')",
            (time.time(),),
        )
        self.db.execute("UPDATE control_sessions SET status='expired' WHERE status='active'")
        self.db.commit()

    def create_user(self, username: str, password: str) -> dict[str, Any]:
        username = username.strip().casefold()
        if not username or len(username) > 80 or len(password) < 12:
            raise ValueError("用户名不能为空，密码至少 12 位")
        user_id = identifier("usr")
        salt = secrets.token_hex(16)
        password_hash = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 390_000).hex()
        self.db.execute(
            "INSERT INTO users VALUES (?,?,?,?,?)", (user_id, username, salt, password_hash, time.time())
        )
        self.db.commit()
        return {"id": user_id, "username": username}

    def login(self, username: str, password: str) -> tuple[dict[str, Any], str] | None:
        user = self._one("SELECT * FROM users WHERE username=?", (username.strip().casefold(),))
        # A dummy hash gives unknown users the same expensive password check.
        salt = user["salt"] if user else "00" * 16
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 390_000).hex()
        if not user or not hmac.compare_digest(candidate, user["password_hash"]):
            return None
        token = secrets.token_urlsafe(36)
        self.db.execute(
            "INSERT INTO logins VALUES (?,?,?)", (digest(token), user["id"], time.time() + 12 * 3600)
        )
        self.db.commit()
        return {"id": user["id"], "username": user["username"]}, token

    def account(self, token: str) -> dict[str, Any] | None:
        return self._one(
            "SELECT u.id,u.username FROM logins l JOIN users u ON u.id=l.user_id WHERE l.digest=? AND l.expires_at>?",
            (digest(token), time.time()),
        )

    def logout(self, token: str) -> None:
        self.db.execute("DELETE FROM logins WHERE digest=?", (digest(token),))
        self.db.commit()

    def user(self, user_id: str) -> dict[str, Any] | None:
        return self._one("SELECT id,username FROM users WHERE id=?", (user_id,))

    def devices(self, owner_id: str) -> list[dict[str, Any]]:
        return self._all("SELECT * FROM devices WHERE owner_id=? ORDER BY created_at DESC", (owner_id,))

    def device(self, device_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM devices WHERE id=?", (device_id,))

    def create_device(self, owner_id: str, name: str, capabilities: list[str]) -> tuple[dict[str, Any], str]:
        device_id, key = identifier("dev"), secret_key("device")
        self.db.execute(
            "INSERT INTO devices VALUES (?,?,?,?,?,1,0,NULL,?,NULL)",
            (device_id, owner_id, name, json.dumps(capabilities), digest(key), time.time()),
        )
        self.db.commit()
        self.audit(owner_id, device_id, None, None, "device_create", "changed")
        return self.device(device_id), key  # type: ignore[return-value]

    def update_device(self, device_id: str, name: str, capabilities: list[str]) -> None:
        self.db.execute(
            "UPDATE devices SET name=?,capabilities=? WHERE id=?", (name, json.dumps(capabilities), device_id)
        )
        self.db.commit()

    def rotate_device(self, device_id: str) -> str:
        key = secret_key("device")
        self.db.execute(
            "UPDATE devices SET token_digest=?,credential_version=credential_version+1 WHERE id=?",
            (digest(key), device_id),
        )
        self.db.commit()
        return key

    def revoke_device(self, device_id: str) -> None:
        self.db.execute(
            "UPDATE devices SET revoked_at=?,credential_version=credential_version+1 WHERE id=?",
            (time.time(), device_id),
        )
        self.db.commit()

    def authenticate_device(self, key: str) -> dict[str, Any] | None:
        if not key.startswith("abr_device_"):
            return None
        return self._one("SELECT * FROM devices WHERE token_digest=? AND revoked_at IS NULL", (digest(key),))

    def next_epoch(self, device_id: str) -> int:
        self.db.execute("UPDATE devices SET epoch=epoch+1,last_seen=? WHERE id=?", (time.time(), device_id))
        self.db.commit()
        return self.device(device_id)["epoch"]  # type: ignore[index]

    def touch_device(self, device_id: str) -> None:
        self.db.execute("UPDATE devices SET last_seen=? WHERE id=?", (time.time(), device_id))
        self.db.commit()

    def grants(self, owner_id: str) -> list[dict[str, Any]]:
        return self._all("SELECT * FROM client_grants WHERE owner_id=? ORDER BY created_at DESC", (owner_id,))

    def grant(self, grant_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM client_grants WHERE id=?", (grant_id,))

    def create_grant(
        self, owner_id: str, name: str, device_ids: list[str], capabilities: list[str], expires_at: float
    ) -> tuple[dict[str, Any], str]:
        grant_id, key = identifier("agt"), secret_key("agent")
        self.db.execute(
            "INSERT INTO client_grants VALUES (?,?,?,?,?,?,?,NULL,?,NULL)",
            (
                grant_id,
                owner_id,
                name,
                json.dumps(device_ids),
                json.dumps(capabilities),
                expires_at,
                digest(key),
                time.time(),
            ),
        )
        self.db.commit()
        self.audit(owner_id, None, grant_id, None, "client_grant_create", "changed")
        return self.grant(grant_id), key  # type: ignore[return-value]

    def revoke_grant(self, grant_id: str) -> None:
        self.db.execute("UPDATE client_grants SET revoked_at=? WHERE id=?", (time.time(), grant_id))
        self.db.commit()

    def authenticate_agent(self, key: str) -> dict[str, Any] | None:
        if not key.startswith("abr_agent_"):
            return None
        grant = self._one(
            "SELECT * FROM client_grants WHERE token_digest=? AND revoked_at IS NULL AND expires_at>?",
            (digest(key), time.time()),
        )
        if grant:
            self.db.execute("UPDATE client_grants SET last_used=? WHERE id=?", (time.time(), grant["id"]))
            self.db.commit()
        return grant

    def create_session(
        self, grant_id: str, device_id: str, capabilities: list[str], lease_until: float
    ) -> dict[str, Any]:
        session_id = identifier("ses")
        self.db.execute(
            "INSERT INTO control_sessions VALUES (?,?,?,?,?,'active',?)",
            (session_id, grant_id, device_id, json.dumps(capabilities), lease_until, time.time()),
        )
        self.db.commit()
        return self.session(session_id)  # type: ignore[return-value]

    def session(self, session_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM control_sessions WHERE id=?", (session_id,))

    def sessions(self, device_id: str) -> list[dict[str, Any]]:
        return self._all("SELECT * FROM control_sessions WHERE device_id=? AND status='active'", (device_id,))

    def close_session(self, session_id: str, status: str = "stopped") -> None:
        self.db.execute("UPDATE control_sessions SET status=? WHERE id=?", (status, session_id))
        self.db.commit()

    def renew_session(self, session_id: str, lease_until: float) -> None:
        self.db.execute(
            "UPDATE control_sessions SET lease_until=? WHERE id=? AND status='active'",
            (lease_until, session_id),
        )
        self.db.commit()

    def operation(self, operation_id: str) -> dict[str, Any] | None:
        return self._one("SELECT * FROM operations WHERE id=?", (operation_id,))

    def create_operation(
        self,
        operation_id: str,
        owner_id: str,
        grant_id: str,
        device_id: str,
        session_id: str,
        tool: str,
        request_hash: str,
        epoch: int,
    ) -> dict[str, Any]:
        self.db.execute(
            "INSERT INTO operations VALUES (?,?,?,?,?,?,?,'accepted',?,?,NULL)",
            (operation_id, owner_id, grant_id, device_id, session_id, tool, request_hash, epoch, time.time()),
        )
        self.db.commit()
        return self.operation(operation_id)  # type: ignore[return-value]

    def set_operation(self, operation_id: str, status: str) -> None:
        finished = None if status in {"accepted", "dispatched"} else time.time()
        self.db.execute(
            "UPDATE operations SET status=?,finished_at=? WHERE id=?", (status, finished, operation_id)
        )
        self.db.commit()

    def operations(self, owner_id: str, limit: int = 100) -> list[dict[str, Any]]:
        return self._all(
            "SELECT * FROM operations WHERE owner_id=? ORDER BY created_at DESC LIMIT ?", (owner_id, limit)
        )

    def audit(
        self,
        owner_id: str,
        device_id: str | None,
        grant_id: str | None,
        operation_id: str | None,
        action: str,
        outcome: str,
    ) -> None:
        self.db.execute(
            "INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)",
            (identifier("evt"), owner_id, device_id, grant_id, operation_id, action, outcome, time.time()),
        )
        self.db.commit()

    def audit_events(self, owner_id: str) -> list[dict[str, Any]]:
        return self._all(
            "SELECT * FROM audit WHERE owner_id=? ORDER BY created_at DESC LIMIT 200", (owner_id,)
        )

    def close(self) -> None:
        self.db.close()

    def _one(self, sql: str, values: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        row = self.db.execute(sql, values).fetchone()
        return self._decode(row) if row else None

    def _all(self, sql: str, values: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        return [self._decode(row) for row in self.db.execute(sql, values).fetchall()]

    @staticmethod
    def _decode(row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        for field in ("capabilities", "device_ids"):
            if field in data:
                data[field] = json.loads(data[field])
        return data

    def _migrate(self) -> None:
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > 1:
            raise RuntimeError("数据库版本高于当前应用版本")
        if version == 1:
            return
        self.db.executescript("""
            CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at REAL NOT NULL);
            CREATE TABLE logins (digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at REAL NOT NULL);
            CREATE TABLE devices (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, capabilities TEXT NOT NULL, token_digest TEXT UNIQUE NOT NULL, credential_version INTEGER NOT NULL, epoch INTEGER NOT NULL, revoked_at REAL, created_at REAL NOT NULL, last_seen REAL);
            CREATE TABLE client_grants (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, device_ids TEXT NOT NULL, capabilities TEXT NOT NULL, expires_at REAL NOT NULL, token_digest TEXT UNIQUE NOT NULL, revoked_at REAL, created_at REAL NOT NULL, last_used REAL);
            CREATE TABLE control_sessions (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES client_grants(id), device_id TEXT NOT NULL REFERENCES devices(id), capabilities TEXT NOT NULL, lease_until REAL NOT NULL, status TEXT NOT NULL, created_at REAL NOT NULL);
            CREATE TABLE operations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), grant_id TEXT NOT NULL REFERENCES client_grants(id), device_id TEXT NOT NULL REFERENCES devices(id), session_id TEXT NOT NULL REFERENCES control_sessions(id), tool TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, epoch INTEGER NOT NULL, created_at REAL NOT NULL, finished_at REAL);
            CREATE TABLE audit (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), device_id TEXT, grant_id TEXT, operation_id TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, created_at REAL NOT NULL);
            CREATE INDEX operation_owner ON operations(owner_id, created_at);
            CREATE INDEX audit_owner ON audit(owner_id, created_at);
            PRAGMA user_version = 1;
        """)
        self.db.commit()


def identifier(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"


def secret_key(kind: str) -> str:
    return f"abr_{kind}_{secrets.token_urlsafe(32)}"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
