"""Owner-only file credentials, exercised exclusively in temporary directories."""

import json
import os
import stat
import subprocess

import pytest

from abridge.credentials import (
    CredentialError,
    delete_device_credential,
    load_device_credential,
    save_device_credential,
)

SERVER_URL = "https://bridge.example.test"
DEVICE_KEY = "abr_device_temporary_test_secret"

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Owner/mode checks require POSIX permissions")


@pytest.fixture(autouse=True)
def forbid_external_credential_programs(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("File credentials must not invoke external programs or Keychain")

    monkeypatch.setattr(subprocess, "run", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)


@pytest.mark.parametrize("existing", [False, True])
def test_save_creates_or_tightens_owned_directory_and_replaces_private_file(tmp_path, existing):
    directory = tmp_path / "credentials"
    path = directory / "device.json"
    if existing:
        tmp_path.chmod(0o755)
        directory.mkdir()
        directory.chmod(0o755)
        path.write_text(json.dumps({"server_url": SERVER_URL, "device_key": "old-test-secret"}))
        path.chmod(0o644)

    save_device_credential(tmp_path, SERVER_URL, DEVICE_KEY)

    assert directory.stat().st_uid == os.getuid()
    assert path.stat().st_uid == os.getuid()
    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o700
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_ISREG(path.stat().st_mode)
    assert json.loads(path.read_text()) == {"server_url": SERVER_URL, "device_key": DEVICE_KEY}
    assert load_device_credential(tmp_path, SERVER_URL) == DEVICE_KEY


def test_missing_credential_requires_explicit_binding_without_keychain_fallback(tmp_path):
    with pytest.raises(CredentialError) as caught:
        load_device_credential(tmp_path, SERVER_URL)
    assert caught.value.code == "credential_missing"


def test_saved_credential_cannot_authenticate_another_server(tmp_path):
    save_device_credential(tmp_path, SERVER_URL, DEVICE_KEY)
    with pytest.raises(CredentialError) as caught:
        load_device_credential(tmp_path, "https://another.example.test")
    assert caught.value.code == "credential_mismatch"
    assert DEVICE_KEY not in str(caught.value)


@pytest.mark.parametrize("insecure", ["file", "directory"])
def test_read_rejects_group_accessible_file_or_directory(tmp_path, insecure):
    save_device_credential(tmp_path, SERVER_URL, DEVICE_KEY)
    directory = tmp_path / "credentials"
    if insecure == "file":
        (directory / "device.json").chmod(0o640)
    else:
        directory.chmod(0o750)

    with pytest.raises(CredentialError) as caught:
        load_device_credential(tmp_path, SERVER_URL)
    assert caught.value.code == "credential_permissions"
    assert DEVICE_KEY not in str(caught.value)


@pytest.mark.parametrize("linked", ["file", "directory"])
def test_read_refuses_symlinks_even_when_the_target_has_private_permissions(tmp_path, linked):
    save_device_credential(tmp_path, SERVER_URL, DEVICE_KEY)
    directory = tmp_path / "credentials"
    path = directory / "device.json"
    if linked == "file":
        target = tmp_path / "private-target.json"
        path.rename(target)
        path.symlink_to(target)
    else:
        target = tmp_path / "private-target-directory"
        directory.rename(target)
        directory.symlink_to(target, target_is_directory=True)

    with pytest.raises(CredentialError) as caught:
        load_device_credential(tmp_path, SERVER_URL)
    assert caught.value.code == "credential_permissions"


def test_read_rejects_credentials_owned_by_another_user(tmp_path, monkeypatch):
    save_device_credential(tmp_path, SERVER_URL, DEVICE_KEY)
    owner = os.getuid()
    monkeypatch.setattr(os, "getuid", lambda: owner + 1)

    with pytest.raises(CredentialError) as caught:
        load_device_credential(tmp_path, SERVER_URL)
    assert caught.value.code == "credential_permissions"
    assert DEVICE_KEY not in str(caught.value)


def test_failed_atomic_replace_preserves_old_complete_secret_and_removes_temporary_file(
    tmp_path, monkeypatch
):
    old_key = "abr_device_old_complete_test_secret"
    new_key = "abr_device_new_test_secret_never_published"
    save_device_credential(tmp_path, SERVER_URL, old_key)
    directory = tmp_path / "credentials"
    before = {path.name for path in directory.iterdir()}

    def failed_replace(source, destination, *args, **kwargs):
        raise OSError("injected atomic replace failure")

    monkeypatch.setattr(os, "replace", failed_replace)
    with pytest.raises((CredentialError, OSError)) as caught:
        save_device_credential(tmp_path, SERVER_URL, new_key)

    assert load_device_credential(tmp_path, SERVER_URL) == old_key
    assert json.loads((directory / "device.json").read_text()) == {
        "server_url": SERVER_URL,
        "device_key": old_key,
    }
    assert {path.name for path in directory.iterdir()} == before
    assert new_key not in str(caught.value)
    assert old_key not in str(caught.value)


def test_delete_is_idempotent_and_preserves_binding_configuration_and_pause(tmp_path):
    config = tmp_path / "config.json"
    original = json.dumps({"url": SERVER_URL, "paused": True, "capabilities": {"shell": True}})
    config.write_text(original)
    save_device_credential(tmp_path, SERVER_URL, DEVICE_KEY)

    delete_device_credential(tmp_path)
    delete_device_credential(tmp_path)

    assert not (tmp_path / "credentials" / "device.json").exists()
    assert config.read_text() == original
    assert json.loads(config.read_text())["paused"] is True
