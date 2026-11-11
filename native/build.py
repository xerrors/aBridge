"""Build the Mac app only when its native source or bundle settings change."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import plistlib
import runpy
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--signing-identity", default=os.environ.get("ABRIDGE_SIGNING_IDENTITY", "-"))
    parser.add_argument(
        "--force", action="store_true", help="Rebuild even when the native inputs are unchanged"
    )
    arguments = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("Native builds require macOS")
    bundle = arguments.output.resolve()
    macos = bundle / "Contents" / "MacOS"
    resources = bundle / "Contents" / "Resources"
    executable = macos / "aBridge"
    source = Path(__file__).with_name("aBridge.swift")
    setup_guide = Path(__file__).with_name("setup.html")
    notices = Path(__file__).resolve().parents[1] / "THIRD_PARTY_NOTICES.md"
    version = runpy.run_path(Path(__file__).resolve().parents[1] / "abridge/__init__.py")["__version__"]
    info = {
        "CFBundleName": "aBridge",
        "CFBundleDisplayName": "aBridge",
        "CFBundleIdentifier": "dev.abridge.client",
        "CFBundleExecutable": "aBridge",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "14.0",
        "LSUIElement": True,
        "NSHighResolutionCapable": True,
        "NSScreenCaptureUsageDescription": "aBridge 仅在你启用截图后向已授权的 Agent 提供屏幕画面。",
        "NSAccessibilityUsageDescription": "aBridge 仅在你启用桌面输入后执行已授权 Agent 的鼠标和键盘操作。",
    }
    # Keep a venv's interpreter symlink: resolving it would select the base Python
    # and silently lose the installed runtime dependencies.
    runtime = {
        "python_path": str(arguments.python.absolute()),
        "project_path": str(arguments.project.resolve()),
    }
    target = f"{platform.machine()}-apple-macosx{info['LSMinimumSystemVersion']}"
    native_inputs = {
        "source": source.read_text(),
        "setup_guide": setup_guide.read_text(),
        "notices": notices.read_text(),
        "info": info,
        "runtime": runtime,
        "signing_identity": arguments.signing_identity,
        "optimization": "-O",
        "builder_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "target": target,
    }
    fingerprint = hashlib.sha256(json.dumps(native_inputs, sort_keys=True).encode()).hexdigest()
    manifest = resources / "native-build.json"
    if not arguments.force and manifest.is_file() and executable.is_file():
        if json.loads(manifest.read_text())["fingerprint"] == fingerprint:
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(bundle)], check=True)
            print(f"Native app unchanged: {bundle}")
            return

    macos.mkdir(parents=True, exist_ok=True)
    resources.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ, MACOSX_DEPLOYMENT_TARGET=info["LSMinimumSystemVersion"])
    subprocess.run(
        [
            "swiftc",
            "-O",
            "-target",
            target,
            str(source),
            "-o",
            str(executable),
            "-framework",
            "AppKit",
            "-framework",
            "ApplicationServices",
            "-framework",
            "Security",
        ],
        env=environment,
        check=True,
    )
    with (bundle / "Contents" / "Info.plist").open("wb") as stream:
        plistlib.dump(info, stream)
    (resources / "runtime.json").write_text(json.dumps(runtime, indent=2) + "\n")
    (resources / "setup.html").write_text(setup_guide.read_text())
    (resources / "third-party-notices.txt").write_text(notices.read_text())
    manifest.write_text(json.dumps({"fingerprint": fingerprint}, indent=2) + "\n")
    subprocess.run(
        [
            "codesign",
            "--force",
            "--sign",
            arguments.signing_identity,
            "--identifier",
            "dev.abridge.client",
            str(bundle),
        ],
        check=True,
    )
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(bundle)], check=True)
    print(bundle)


if __name__ == "__main__":
    main()
