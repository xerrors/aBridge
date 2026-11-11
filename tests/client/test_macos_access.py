"""Browser bookmark lifetime checks using temporary files and a mock CF boundary."""

import ctypes
import json
import os
import sys

import pytest

from abridge import macos_access
from abridge.macos_access import BOOKMARK_FILE, MAX_BOOKMARK_BYTES, acquire_browser_access


@pytest.mark.parametrize("platform", ["linux", "win32"])
def test_unsupported_platform_does_not_load_core_foundation(tmp_path, monkeypatch, platform):
    monkeypatch.setattr(macos_access.sys, "platform", platform)
    monkeypatch.setattr(macos_access, "_load_core_foundation", forbidden_cf)
    access = acquire_browser_access(tmp_path)
    assert access.status == {"status": "unsupported", "ready": False, "error": None}
    access.close()
    access.close()


def test_missing_bookmark_does_not_load_core_foundation(tmp_path, monkeypatch):
    monkeypatch.setattr(macos_access.sys, "platform", "darwin")
    monkeypatch.setattr(macos_access, "_load_core_foundation", forbidden_cf)
    assert acquire_browser_access(tmp_path).status == {
        "status": "not_configured",
        "ready": False,
        "error": None,
    }


def test_success_holds_url_and_pairs_one_explicit_start_with_one_stop(bookmark):
    state, cf = bookmark
    access = acquire_browser_access(state)
    assert access.status == {"status": "ready", "ready": True, "error": None}
    assert cf.resolve_options == (1 << 8) | (1 << 15)
    assert cf.started == [22]
    assert cf.stopped == []
    assert cf.released == [33, 11]
    access.close()
    access.close()
    assert cf.stopped == [22]
    assert cf.released.count(22) == 1
    assert access.status == {"status": "closed", "ready": False, "error": None}


@pytest.mark.parametrize("problem", ["directory_mode", "file_mode", "owner"])
def test_bad_local_permissions_fail_before_cf(bookmark, monkeypatch, problem):
    state, cf = bookmark
    if problem == "directory_mode":
        state.chmod(0o750)
    elif problem == "file_mode":
        (state / BOOKMARK_FILE).chmod(0o640)
    else:
        uid = os.getuid()
        monkeypatch.setattr(macos_access.os, "getuid", lambda: uid + 1)
    result = acquire_browser_access(state).status
    assert result["status"] == "invalid"
    assert result["error"]["code"] == "browser_access_permissions"
    assert cf.created == []


@pytest.mark.parametrize("linked", ["file", "directory"])
def test_symlink_is_not_followed(bookmark, linked):
    state, cf = bookmark
    if linked == "file":
        target = state.parent / "target.bookmark"
        (state / BOOKMARK_FILE).rename(target)
        (state / BOOKMARK_FILE).symlink_to(target)
    else:
        target = state.parent / "target-directory"
        state.rename(target)
        state.symlink_to(target, target_is_directory=True)
    assert acquire_browser_access(state).status["error"]["code"] == "browser_access_permissions"
    assert cf.created == []


@pytest.mark.parametrize("size", [0, MAX_BOOKMARK_BYTES + 1])
def test_empty_or_oversized_bookmark_is_rejected_before_cf(bookmark, size):
    state, cf = bookmark
    (state / BOOKMARK_FILE).write_bytes(b"x" * size)
    assert acquire_browser_access(state).status["error"]["code"] == "browser_access_invalid"
    assert cf.created == []


@pytest.mark.parametrize(
    ("failure", "state", "code", "released"),
    [
        ("data", "unavailable", "browser_access_unavailable", []),
        ("resolve", "invalid", "browser_access_invalid", [44, 11]),
        ("stale", "stale", "browser_access_stale", [22, 11]),
        ("leaf", "invalid", "browser_access_target_mismatch", [33, 22, 11]),
        ("start", "denied", "browser_access_denied", [33, 22, 11]),
        ("exception", "unavailable", "browser_access_unavailable", [11]),
    ],
)
def test_failure_releases_owned_refs_without_stopping_unstarted_access(
    bookmark, failure, state, code, released
):
    directory, cf = bookmark
    cf.failure = failure
    access = acquire_browser_access(directory)
    assert access.status["status"] == state
    assert access.status["ready"] is False
    assert access.status["error"]["code"] == code
    assert cf.released == released
    assert cf.stopped == []
    assert "private-token" not in json.dumps(access.status)
    access.close()
    assert cf.released == released


def test_cleanup_failure_still_releases_url_and_is_idempotent(bookmark):
    state, cf = bookmark
    access = acquire_browser_access(state)
    cf.failure = "stop"
    access.close()
    access.close()
    assert cf.stopped == [22]
    assert cf.released.count(22) == 1
    assert access.status["error"]["code"] == "browser_access_cleanup_failed"
    assert "private-token" not in json.dumps(access.status)


def test_cf_load_failure_is_reported_without_raw_paths(bookmark, monkeypatch):
    state, _ = bookmark

    def unavailable():
        raise OSError("private-token /private/path")

    monkeypatch.setattr(macos_access, "_load_core_foundation", unavailable)
    result = acquire_browser_access(state).status
    assert result["status"] == "unavailable"
    assert "private-token" not in json.dumps(result)


@pytest.mark.skipif(sys.platform != "darwin", reason="CoreFoundation is a macOS-only integration")
def test_actual_cf_resolves_only_a_synthetic_temporary_endpoint_bookmark(tmp_path):
    cf = macos_access._load_core_foundation()
    pointer = ctypes.c_void_p
    cf.CFURLCreateFromFileSystemRepresentation.argtypes = [
        pointer,
        ctypes.POINTER(ctypes.c_uint8),
        ctypes.c_long,
        ctypes.c_ubyte,
    ]
    cf.CFURLCreateFromFileSystemRepresentation.restype = pointer
    cf.CFURLCreateBookmarkData.argtypes = [
        pointer,
        pointer,
        ctypes.c_ulong,
        pointer,
        pointer,
        ctypes.POINTER(pointer),
    ]
    cf.CFURLCreateBookmarkData.restype = pointer
    cf.CFDataGetLength.argtypes = [pointer]
    cf.CFDataGetLength.restype = ctypes.c_long
    cf.CFDataGetBytePtr.argtypes = [pointer]
    cf.CFDataGetBytePtr.restype = pointer
    target = tmp_path / "DevToolsActivePort"
    target.write_bytes(b"temporary synthetic fixture")
    encoded = os.fsencode(target)
    raw = (ctypes.c_uint8 * len(encoded)).from_buffer_copy(encoded)
    url = cf.CFURLCreateFromFileSystemRepresentation(None, raw, len(raw), False)
    error = ctypes.c_void_p()
    data = None
    try:
        data = cf.CFURLCreateBookmarkData(None, url, 0, None, None, ctypes.byref(error))
        assert data
        value = ctypes.string_at(cf.CFDataGetBytePtr(data), cf.CFDataGetLength(data))
    finally:
        if data:
            cf.CFRelease(data)
        if error.value:
            cf.CFRelease(error.value)
        cf.CFRelease(url)
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    path = state / BOOKMARK_FILE
    path.write_bytes(value)
    path.chmod(0o600)
    access = acquire_browser_access(state)
    try:
        # A plain temporary URL may need no scope. That is not evidence of
        # access to Chrome's protected app data.
        assert access.status["status"] in {"ready", "denied"}, access.status
        assert str(target) not in json.dumps(access.status)
    finally:
        access.close()


@pytest.fixture
def bookmark(tmp_path, monkeypatch):
    monkeypatch.setattr(macos_access.sys, "platform", "darwin")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    path = state / BOOKMARK_FILE
    path.write_bytes(b"private-token synthetic bookmark bytes")
    path.chmod(0o600)
    cf = FakeCF()
    monkeypatch.setattr(macos_access, "_load_core_foundation", lambda: cf)
    return state, cf


def forbidden_cf():
    raise AssertionError("CoreFoundation must not load for an absent or unsupported transfer")


class FakeCF:
    def __init__(self):
        self.failure = None
        self.created = []
        self.released = []
        self.started = []
        self.stopped = []
        self.resolve_options = None

    def CFDataCreate(self, allocator, raw, length):
        self.created.append(bytes(raw[:length]))
        return 0 if self.failure == "data" else 11

    def CFURLCreateByResolvingBookmarkData(
        self, allocator, data, options, relative, properties, stale, error
    ):
        self.resolve_options = options
        if self.failure == "exception":
            raise RuntimeError("private-token CF error /private/path")
        if self.failure == "resolve":
            error._obj.value = 44
            return 0
        stale._obj.value = self.failure == "stale"
        return 22

    def CFURLCopyLastPathComponent(self, url):
        return 33

    def CFStringGetCString(self, component, buffer, size, encoding):
        buffer.value = b"other-file" if self.failure == "leaf" else b"DevToolsActivePort"
        return True

    def CFURLStartAccessingSecurityScopedResource(self, url):
        self.started.append(url)
        return self.failure != "start"

    def CFURLStopAccessingSecurityScopedResource(self, url):
        self.stopped.append(url)
        if self.failure == "stop":
            raise RuntimeError("private-token stop error")

    def CFRelease(self, reference):
        self.released.append(reference)
