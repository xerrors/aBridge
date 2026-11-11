"""Hold one explicitly transferred macOS browser-file access scope."""

from __future__ import annotations

import ctypes
import os
import stat
import sys
from pathlib import Path
from typing import Any

BOOKMARK_FILE = "browser-access-transfer.bookmark"
MAX_BOOKMARK_BYTES = 1024 * 1024
_RESOLVE_WITHOUT_UI = 1 << 8
_RESOLVE_WITHOUT_IMPLICIT_ACCESS = 1 << 15
_UTF8 = 0x08000100


class BrowserFileAccess:
    """A single acquired CFURL, released once at the client's lifecycle boundary."""

    def __init__(self, status: dict[str, Any], *, cf: Any = None, url: int | None = None) -> None:
        self._status = status
        self._cf = cf
        self._url = url

    @property
    def status(self) -> dict[str, Any]:
        result = dict(self._status)
        if result["error"] is not None:
            result["error"] = dict(result["error"])
        return result

    def close(self) -> None:
        cf, url = self._cf, self._url
        self._cf = None
        self._url = None
        if cf is None or url is None:
            return
        try:
            try:
                cf.CFURLStopAccessingSecurityScopedResource(url)
            finally:
                cf.CFRelease(url)
        except (OSError, RuntimeError, ctypes.ArgumentError):
            self._status = _status(
                "unavailable",
                "browser_access_cleanup_failed",
                "Browser file access cleanup could not be confirmed",
            )
            return
        self._status = _status("closed")


def acquire_browser_access(state_dir: Path) -> BrowserFileAccess:
    """Resolve only the owner's selected endpoint bookmark, without UI or target reads."""
    if sys.platform != "darwin":
        return BrowserFileAccess(_status("unsupported"))
    try:
        bookmark = _read_bookmark(state_dir)
    except _AccessFailure as error:
        return BrowserFileAccess(_status(error.state, error.code, str(error)))
    if bookmark is None:
        return BrowserFileAccess(_status("not_configured"))
    try:
        cf = _load_core_foundation()
    except (OSError, AttributeError):
        return BrowserFileAccess(
            _status("unavailable", "browser_access_unavailable", "macOS browser file access is unavailable")
        )
    return _resolve_bookmark(cf, bookmark)


def _read_bookmark(state_dir: Path) -> bytes | None:
    try:
        (state_dir / BOOKMARK_FILE).lstat()
    except FileNotFoundError:
        return None
    except OSError:
        raise _AccessFailure(
            "unavailable", "browser_access_unavailable", "Could not inspect the local browser access bookmark"
        ) from None
    directory = None
    try:
        directory = os.open(state_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        information = os.fstat(directory)
        if information.st_uid != os.getuid() or stat.S_IMODE(information.st_mode) != 0o700:
            raise _permission_failure()
        descriptor = os.open(BOOKMARK_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as stream:
            information = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(information.st_mode)
                or information.st_uid != os.getuid()
                or stat.S_IMODE(information.st_mode) != 0o600
            ):
                raise _permission_failure()
            if information.st_size > MAX_BOOKMARK_BYTES:
                raise _invalid_bookmark()
            data = stream.read(MAX_BOOKMARK_BYTES + 1)
    except FileNotFoundError:
        return None
    except OSError:
        raise _permission_failure() from None
    finally:
        if directory is not None:
            os.close(directory)
    if not data or len(data) > MAX_BOOKMARK_BYTES:
        raise _invalid_bookmark()
    return data


def _resolve_bookmark(cf: Any, bookmark: bytes) -> BrowserFileAccess:
    data = None
    url = None
    error = ctypes.c_void_p()
    retained = False
    try:
        raw = (ctypes.c_uint8 * len(bookmark)).from_buffer_copy(bookmark)
        data = cf.CFDataCreate(None, raw, len(bookmark))
        if not data:
            raise _AccessFailure(
                "unavailable", "browser_access_unavailable", "Could not load the browser access bookmark"
            )
        stale = ctypes.c_ubyte()
        url = cf.CFURLCreateByResolvingBookmarkData(
            None,
            data,
            _RESOLVE_WITHOUT_UI | _RESOLVE_WITHOUT_IMPLICIT_ACCESS,
            None,
            None,
            ctypes.byref(stale),
            ctypes.byref(error),
        )
        if not url:
            raise _invalid_bookmark()
        if stale.value:
            raise _AccessFailure(
                "stale",
                "browser_access_stale",
                "The browser access bookmark is stale; select the endpoint file again",
            )
        component = cf.CFURLCopyLastPathComponent(url)
        if not component:
            raise _invalid_bookmark()
        try:
            name = ctypes.create_string_buffer(128)
            if (
                not cf.CFStringGetCString(component, name, len(name), _UTF8)
                or name.value != b"DevToolsActivePort"
            ):
                raise _AccessFailure(
                    "invalid",
                    "browser_access_target_mismatch",
                    "Select the exact DevToolsActivePort endpoint file",
                )
        finally:
            cf.CFRelease(component)
        if not cf.CFURLStartAccessingSecurityScopedResource(url):
            raise _AccessFailure(
                "denied",
                "browser_access_denied",
                "macOS did not grant access to the selected browser endpoint file",
            )
        retained = True
        return BrowserFileAccess(_status("ready"), cf=cf, url=url)
    except _AccessFailure as failure:
        return BrowserFileAccess(_status(failure.state, failure.code, str(failure)))
    except (OSError, RuntimeError, ctypes.ArgumentError):
        return BrowserFileAccess(
            _status(
                "unavailable", "browser_access_unavailable", "Could not acquire macOS browser file access"
            )
        )
    finally:
        if url and not retained:
            cf.CFRelease(url)
        if error.value:
            cf.CFRelease(error.value)
        if data:
            cf.CFRelease(data)


def _load_core_foundation() -> Any:
    cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    pointer = ctypes.c_void_p
    cf.CFDataCreate.argtypes = [pointer, ctypes.POINTER(ctypes.c_uint8), ctypes.c_long]
    cf.CFDataCreate.restype = pointer
    cf.CFURLCreateByResolvingBookmarkData.argtypes = [
        pointer,
        pointer,
        ctypes.c_ulong,
        pointer,
        pointer,
        ctypes.POINTER(ctypes.c_ubyte),
        ctypes.POINTER(pointer),
    ]
    cf.CFURLCreateByResolvingBookmarkData.restype = pointer
    cf.CFURLCopyLastPathComponent.argtypes = [pointer]
    cf.CFURLCopyLastPathComponent.restype = pointer
    cf.CFStringGetCString.argtypes = [pointer, ctypes.POINTER(ctypes.c_char), ctypes.c_long, ctypes.c_uint32]
    cf.CFStringGetCString.restype = ctypes.c_ubyte
    cf.CFURLStartAccessingSecurityScopedResource.argtypes = [pointer]
    cf.CFURLStartAccessingSecurityScopedResource.restype = ctypes.c_ubyte
    cf.CFURLStopAccessingSecurityScopedResource.argtypes = [pointer]
    cf.CFURLStopAccessingSecurityScopedResource.restype = None
    cf.CFRelease.argtypes = [pointer]
    cf.CFRelease.restype = None
    return cf


class _AccessFailure(ValueError):
    def __init__(self, state: str, code: str, message: str) -> None:
        super().__init__(message)
        self.state = state
        self.code = code


def _status(state: str, code: str | None = None, message: str | None = None) -> dict[str, Any]:
    return {
        "status": state,
        "ready": state == "ready",
        "error": {"code": code, "message": message} if code else None,
    }


def _permission_failure() -> _AccessFailure:
    return _AccessFailure(
        "invalid",
        "browser_access_permissions",
        "Browser access requires an owner-only 0700 state directory and 0600 regular bookmark file",
    )


def _invalid_bookmark() -> _AccessFailure:
    return _AccessFailure(
        "invalid",
        "browser_access_invalid",
        "The browser access bookmark is invalid; select the endpoint file again",
    )
