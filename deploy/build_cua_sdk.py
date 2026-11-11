"""Build the pinned internal embedded Cua SDK wheel on Apple Silicon."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import platform
import re
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path
from urllib.request import urlopen

PROJECT_ROOT = Path(__file__).resolve().parents[1]
VENDOR = PROJECT_ROOT / "vendor/cua-driver"
VERSION = "0.46.1+abridge.1"
UPSTREAM_VERSION = "0.46.1"
SOURCE_COMMIT = "93c9b500a0d4f9daa56063d3d3e3fb3c9e6070ee"
RUST_VERSION = "1.97.1"
WHEEL_TAG = "py3-none-macosx_14_0_arm64"
PATCH = "0001-exclude-localized-consent-surface.patch"
PATCH_SHA256 = "ad65e8cb5967477b793a095dcc7e3332dba9afbc0abd0d6315702a962ad318c2"
CONSENT_TEST = (
    "browser::consent_ui::tests::consent_surfaces_keep_approved_window_then_frontmost_normal_windows"
)
INPUTS = {
    "source": {
        "name": "cua-source-93c9b500.tar.gz",
        "url": f"https://codeload.github.com/trycua/cua/tar.gz/{SOURCE_COMMIT}",
        "sha256": "6a6e82ad0e2d2e1ea15c665f27a24ed86f35e6021ab00766114793f327d87f0c",
    },
    "rust": {
        "name": "rust-1.97.1.tar.xz",
        "url": "https://static.rust-lang.org/dist/2026-07-16/rust-1.97.1-aarch64-apple-darwin.tar.xz",
        "sha256": "c9748cc86107734a2a024069908a895de7caa2d37062fb641eef9f756938ace2",
    },
    "bindings": {
        "name": "cua_driver-0.46.1-py3-none-macosx_13_0_universal2.whl",
        "url": (
            "https://files.pythonhosted.org/packages/38/e3/"
            "f0b0a880a12cad7859fea6e878b098de65826c066baef8cc606a8c633b12/"
            "cua_driver-0.46.1-py3-none-macosx_13_0_universal2.whl"
        ),
        "sha256": "f2b8678e01b77a698cf0a21ee9f7652af70556484d4c127787cc35731d3f6feb",
    },
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache", type=Path, default=Path.home() / "Library/Caches/aBridge/cua-sdk-0.46.1-abridge.1"
    )
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        parser.error("This internal SDK build supports Apple Silicon macOS only")
    cache = args.cache.expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)
    inputs = {name: download(cache / "downloads", specification) for name, specification in INPUTS.items()}
    verify_hash(VENDOR / PATCH, PATCH_SHA256)
    prepare_toolchain(cache, inputs["rust"])
    source = prepare_source(cache, inputs["source"])
    environment = build_environment(cache)
    run_logged(
        cache,
        "consent-test",
        [
            "cargo",
            "test",
            "--release",
            "--locked",
            "-p",
            "platform-macos",
            "--lib",
            CONSENT_TEST,
            "--",
            "--exact",
        ],
        cwd=source / "libs/cua-driver/rust",
        env=environment,
    )
    run_logged(
        cache,
        "sdk-build",
        ["cargo", "build", "--release", "--locked", "-p", "cua-driver-sdk"],
        cwd=source / "libs/cua-driver/rust",
        env=environment,
    )
    library = cache / "target/release/libcua_driver_sdk.dylib"
    build_info = subprocess.check_output(["xcrun", "vtool", "-show-build", str(library)], text=True)
    minimums = re.findall(r"^\s*minos\s+([0-9.]+)\s*$", build_info, re.MULTILINE)
    if minimums != ["14.0"]:
        raise RuntimeError(f"The SDK minimum macOS must be 14.0, found {minimums}")
    architecture = subprocess.check_output(["lipo", "-archs", str(library)], text=True).strip()
    if architecture != "arm64":
        raise RuntimeError("The internal SDK must contain only arm64")
    subprocess.run(["codesign", "--verify", "--strict", str(library)], check=True)
    manifest = {
        "package": "cua-driver",
        "version": VERSION,
        "upstream_version": UPSTREAM_VERSION,
        "source_commit": SOURCE_COMMIT,
        "inputs": INPUTS,
        "patch": {"file": PATCH, "sha256": PATCH_SHA256},
        "rust_version": RUST_VERSION,
        "target": "aarch64-apple-darwin",
        "minimum_macos": "14.0",
        "rustflags": environment["RUSTFLAGS"],
        "cargo_build_jobs": 2,
        "consent_test": CONSENT_TEST,
        "embedded_only": True,
        "omitted": ["upstream CLI executable", "console entry point", "Rust toolchain"],
        "library_sha256": sha256(library),
    }
    wheel = package_wheel(
        inputs["bindings"],
        library,
        manifest,
        notices=[
            PROJECT_ROOT / "THIRD_PARTY_NOTICES.md",
            source / "libs/cua-driver/rust/THIRD_PARTY_NOTICES.md",
        ],
    )
    manifest["wheel"] = {"file": wheel.name, "sha256": sha256(wheel), "size": wheel.stat().st_size}
    (VENDOR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest["wheel"], indent=2))


def download(directory: Path, specification: dict[str, str]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / specification["name"]
    if not path.exists():
        print("Downloading " + path.name, flush=True)
        temporary = path.with_suffix(path.suffix + ".download")
        with urlopen(specification["url"], timeout=60) as response, temporary.open("wb") as output:
            while block := response.read(1024 * 1024):
                output.write(block)
        temporary.replace(path)
    verify_hash(path, specification["sha256"])
    return path


def prepare_toolchain(cache: Path, archive: Path) -> None:
    cargo = cache / "toolchain/bin/cargo"
    if cargo.exists():
        actual = subprocess.check_output([str(cargo), "--version"], text=True)
        if not actual.startswith("cargo " + RUST_VERSION + " "):
            raise RuntimeError("The cached Cargo does not match the pinned toolchain")
        return
    unpacked = cache / "rust-distribution"
    with tarfile.open(archive) as incoming:
        incoming.extractall(unpacked, filter="data")
    installer = unpacked / "rust-1.97.1-aarch64-apple-darwin/install.sh"
    subprocess.run(
        [
            "sh",
            str(installer),
            "--prefix=" + str(cache / "toolchain"),
            "--components=rustc,cargo,rust-std-aarch64-apple-darwin",
            "--disable-ldconfig",
        ],
        check=True,
    )


def prepare_source(cache: Path, archive: Path) -> Path:
    source = cache / "source"
    if not source.exists():
        unpacked = cache / "source-distribution"
        with tarfile.open(archive) as incoming:
            incoming.extractall(unpacked, filter="data")
        (unpacked / ("cua-" + SOURCE_COMMIT)).rename(source)
    patch = VENDOR / PATCH
    forward = subprocess.run(["git", "apply", "--check", str(patch)], cwd=source, capture_output=True)
    if forward.returncode == 0:
        subprocess.run(["git", "apply", str(patch)], cwd=source, check=True)
    else:
        subprocess.run(["git", "apply", "--reverse", "--check", str(patch)], cwd=source, check=True)
    workspace = source / "libs/cua-driver/rust"
    cargo_manifest = workspace / "Cargo.toml"
    content = cargo_manifest.read_text()
    cargo_manifest.write_text(content.replace(f'version = "{UPSTREAM_VERSION}"', f'version = "{VERSION}"', 1))
    lock = workspace / "Cargo.lock"
    blocks = lock.read_text().split("[[package]]")
    for index, block in enumerate(blocks):
        if f'version = "{UPSTREAM_VERSION}"' in block and "\nsource = " not in block:
            blocks[index] = block.replace(f'version = "{UPSTREAM_VERSION}"', f'version = "{VERSION}"', 1)
    lock.write_text("[[package]]".join(blocks))
    return source


def build_environment(cache: Path) -> dict[str, str]:
    return {
        **os.environ,
        "PATH": str(cache / "toolchain/bin") + os.pathsep + os.environ.get("PATH", ""),
        "CARGO_HOME": str(cache / "cargo-cache"),
        "CARGO_TARGET_DIR": str(cache / "target"),
        "CARGO_BUILD_JOBS": "2",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        # Rust 1.97.1's strip pass can produce an unaligned LINKEDIT string pool
        # rejected by macOS 27. Keep the pinned compiler and disable that pass.
        # https://github.com/rust-lang/rust/issues/157750
        "RUSTFLAGS": "-C strip=none",
    }


def run_logged(cache: Path, label: str, command: list[str], *, cwd: Path, env: dict[str, str]) -> None:
    log = cache / (label + ".log")
    print(f"Running {label}; log: {log}", flush=True)
    with log.open("w") as output:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        print("\n".join(log.read_text(errors="replace").splitlines()[-30:]), file=sys.stderr)
        raise subprocess.CalledProcessError(result.returncode, command)
    print(label + " passed", flush=True)


def package_wheel(base: Path, library: Path, manifest: dict, *, notices: list[Path]) -> Path:
    directory = VENDOR / "wheels"
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / f"cua_driver-{VERSION}-{WHEEL_TAG}.whl"
    old_info = f"cua_driver-{UPSTREAM_VERSION}.dist-info/"
    new_info = f"cua_driver-{VERSION}.dist-info/"
    members = {}
    with zipfile.ZipFile(base) as incoming:
        for name in incoming.namelist():
            if name.endswith("/") or name.startswith("cua_driver/bin/"):
                continue
            if name in {old_info + "RECORD", old_info + "entry_points.txt"}:
                continue
            content = incoming.read(name)
            if name == "cua_driver/libcua_driver_sdk.dylib":
                content = library.read_bytes()
            elif name == "cua_driver/__init__.py":
                content = content.replace(
                    f'__version__ = "{UPSTREAM_VERSION}"'.encode(), f'__version__ = "{VERSION}"'.encode()
                )
            elif name == old_info + "METADATA":
                content = content.replace(
                    f"Version: {UPSTREAM_VERSION}\n".encode(), f"Version: {VERSION}\n".encode(), 1
                )
                note = b"Internal aBridge embedded-only build; upstream CLI is omitted.\n\n"
                header, body = content.split(b"\n\n", 1)
                content = header + b"\n\n" + note + body
            elif name == old_info + "WHEEL":
                content = f"Wheel-Version: 1.0\nGenerator: abridge-internal\nRoot-Is-Purelib: false\nTag: {WHEEL_TAG}\n".encode()
            members[name.replace(old_info, new_info, 1)] = content
    members["cua_driver/abridge-build.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    for index, notice in enumerate(notices):
        members[new_info + f"licenses/NOTICE-{index}.md"] = notice.read_bytes()
    record = io.StringIO(newline="")
    rows = csv.writer(record)
    for name, content in sorted(members.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
        rows.writerow((name, "sha256=" + digest, len(content)))
    rows.writerow((new_info + "RECORD", "", ""))
    members[new_info + "RECORD"] = record.getvalue().encode()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(members.items()):
            item = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            item.external_attr = 0o100644 << 16
            item.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(item, content, compresslevel=9)
    return output


def verify_hash(path: Path, expected: str) -> None:
    if sha256(path) != expected:
        raise RuntimeError("Checksum mismatch: " + path.name)


def sha256(path: Path) -> str:
    with path.open("rb") as incoming:
        return hashlib.file_digest(incoming, "sha256").hexdigest()


if __name__ == "__main__":
    main()
