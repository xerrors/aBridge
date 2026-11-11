"""Owner-only device credentials for unattended operation on the local Mac."""

from __future__ import annotations

import json
import os
import secrets
import stat
from pathlib import Path

MAX_CREDENTIAL_BYTES = 8192
CREDENTIAL_FILE = "device.json"


class CredentialError(ValueError):
    """An actionable storage failure that never includes the stored secret."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def save_device_credential(state_dir: Path, server_url: str, device_key: str) -> None:
    """Atomically replace one device binding, with directory 0700 and file 0600."""
    _validate_credential(server_url, device_key)
    payload = json.dumps({"server_url": server_url, "device_key": device_key}).encode()
    if len(payload) > MAX_CREDENTIAL_BYTES:
        raise CredentialError("credential_invalid", "The device credential is too large")
    directory = _open_directory(state_dir, create=True, writable=True)
    temporary = f".device-{secrets.token_hex(8)}.tmp"
    try:
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory
        )
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, CREDENTIAL_FILE, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    except OSError:
        raise CredentialError(
            "credential_write_failed", "Could not save the device credential; check local storage and retry"
        ) from None
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def load_device_credential(state_dir: Path, server_url: str) -> str:
    """Read a binding only from its owner-only regular file and matching server."""
    directory = _open_directory(state_dir, create=False, writable=False)
    try:
        try:
            descriptor = os.open(
                CREDENTIAL_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
            )
        except FileNotFoundError:
            raise _missing_credential() from None
        except OSError:
            raise _permission_error() from None
        with os.fdopen(descriptor, "rb") as stream:
            information = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(information.st_mode)
                or information.st_uid != os.getuid()
                or stat.S_IMODE(information.st_mode) != 0o600
            ):
                raise _permission_error()
            data = stream.read(MAX_CREDENTIAL_BYTES + 1)
    finally:
        os.close(directory)
    if len(data) > MAX_CREDENTIAL_BYTES:
        raise CredentialError("credential_invalid", "Stored device credential is invalid; rebind this device")
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise CredentialError(
            "credential_invalid", "Stored device credential is invalid; rebind this device"
        ) from None
    if not isinstance(value, dict):
        raise CredentialError("credential_invalid", "Stored device credential is invalid; rebind this device")
    _validate_credential(value.get("server_url"), value.get("device_key"))
    if value["server_url"] != server_url:
        raise CredentialError(
            "credential_mismatch", "The credential belongs to another server; rebind this device"
        )
    return value["device_key"]


def delete_device_credential(state_dir: Path) -> None:
    """Remove only this local credential, including an unexpected leaf symlink."""
    try:
        directory = _open_directory(state_dir, create=False, writable=True)
    except CredentialError as error:
        if error.code == "credential_missing":
            return
        raise
    try:
        try:
            os.unlink(CREDENTIAL_FILE, dir_fd=directory)
            os.fsync(directory)
        except FileNotFoundError:
            pass
        except OSError:
            raise CredentialError(
                "credential_delete_failed", "Could not remove the device credential; check local storage"
            ) from None
    finally:
        os.close(directory)


def _open_directory(state_dir: Path, *, create: bool, writable: bool) -> int:
    if create:
        try:
            state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError:
            raise _permission_error() from None
    try:
        state = os.open(state_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        raise _missing_credential() from None
    except OSError:
        raise _permission_error() from None
    try:
        information = os.fstat(state)
        if information.st_uid != os.getuid():
            raise _permission_error()
        if writable:
            os.fchmod(state, 0o700)
        elif stat.S_IMODE(information.st_mode) != 0o700:
            raise _permission_error()
        if create:
            try:
                os.mkdir("credentials", mode=0o700, dir_fd=state)
            except FileExistsError:
                pass
        descriptor = os.open("credentials", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=state)
    except FileNotFoundError:
        raise _missing_credential() from None
    except OSError:
        raise _permission_error() from None
    finally:
        os.close(state)
    try:
        information = os.fstat(descriptor)
        if information.st_uid != os.getuid() or not stat.S_ISDIR(information.st_mode):
            raise _permission_error()
        if writable:
            os.fchmod(descriptor, 0o700)
        elif stat.S_IMODE(information.st_mode) != 0o700:
            raise _permission_error()
    except (OSError, CredentialError):
        os.close(descriptor)
        raise _permission_error() from None
    return descriptor


def _validate_credential(server_url: str, device_key: str) -> None:
    if not isinstance(server_url, str) or not server_url:
        raise CredentialError("credential_invalid", "A server address is required for the device binding")
    if not isinstance(device_key, str) or not device_key.startswith("abr_device_"):
        raise CredentialError("credential_invalid", "Use a Device Key when binding this Mac")


def _missing_credential() -> CredentialError:
    return CredentialError(
        "credential_missing",
        "No local device credential. Rebind this device or migrate it locally; legacy Keychain credentials are not read automatically.",
    )


def _permission_error() -> CredentialError:
    return CredentialError(
        "credential_permissions",
        "Device credentials require an owner-only 0700 directory and 0600 regular file; check local permissions.",
    )
