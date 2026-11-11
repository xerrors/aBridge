"""Install the native Mac client with its own locked Python runtime."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=Path.home() / "Applications/aBridge.app")
    native_mode = parser.add_mutually_exclusive_group()
    native_mode.add_argument(
        "--runtime-only", action="store_true", help="Update Python without changing the installed app"
    )
    native_mode.add_argument("--rebuild-native", action="store_true", help="Force a native app rebuild")
    parser.add_argument(
        "--signing-identity", help="Use an installed code-signing identity instead of ad hoc signing"
    )
    arguments = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("The native client requires macOS")

    uv = shutil.which("uv")
    if uv is None:
        parser.error("Install uv before installing the client runtime")
    state = Path.home() / "Library/Application Support/aBridge"
    runtime = state / "runtime"
    source = runtime / "src"
    environment_path = runtime / ".venv"
    requirements = runtime / "requirements.txt"
    if arguments.runtime_only:
        settings_path = arguments.app / "Contents/Resources/runtime.json"
        if not settings_path.is_file():
            parser.error("Install the native app before using --runtime-only")
        settings = json.loads(settings_path.read_text())
        expected = {
            "python_path": str(environment_path / "bin/python"),
            "project_path": str(source.resolve()),
        }
        if settings != expected:
            parser.error("The installed app points to a different runtime; run a normal installation first")
    source.mkdir(parents=True, exist_ok=True)
    state.chmod(0o700)
    environment = dict(os.environ, UV_CACHE_DIR=str(Path.home() / "Library/Caches/aBridge/uv-cache"))

    # Export only locked runtime dependencies; the application itself is copied below.
    subprocess.run(
        [uv, "export", "--frozen", "--no-dev", "--no-emit-project", "--output-file", str(requirements)],
        cwd=PROJECT_ROOT,
        env=environment,
        capture_output=True,
        check=True,
    )
    if not (environment_path / "pyvenv.cfg").is_file():
        subprocess.run(
            [uv, "venv", "--python", sys.executable, str(environment_path)], env=environment, check=True
        )
    python = environment_path / "bin/python"
    subprocess.run(
        [
            uv,
            "pip",
            "sync",
            "--python",
            str(python),
            "--require-hashes",
            "--link-mode",
            "copy",
            str(requirements),
        ],
        env=environment,
        check=True,
    )
    subprocess.run(
        [
            "rsync",
            "-a",
            "--delete",
            "--exclude=._*",
            "--exclude=__pycache__/",
            str(PROJECT_ROOT / "abridge"),
            str(source) + "/",
        ],
        check=True,
    )
    if not arguments.runtime_only:
        build = [
            sys.executable,
            str(PROJECT_ROOT / "native/build.py"),
            "--output",
            str(arguments.app.absolute()),
            "--python",
            str(python),
            "--project",
            str(source),
        ]
        if arguments.rebuild_native:
            build.append("--force")
        if arguments.signing_identity:
            build.extend(["--signing-identity", arguments.signing_identity])
        subprocess.run(build, check=True)
    subprocess.run(
        [
            str(python),
            "-c",
            "import abridge.client, websockets; print('Installed client runtime imports successfully')",
        ],
        cwd=source,
        check=True,
    )
    print(
        json.dumps(
            {
                "app": str(arguments.app.absolute()),
                "python": str(python),
                "source": str(source),
                "helper": str(arguments.app.absolute() / "Contents/MacOS/aBridge"),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
