"""Read-only dependency checks that run even when client packages are missing."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import platform
import sys
from typing import Any

from abridge import __version__


async def check_dependencies() -> dict[str, Any]:
    """Check the Python runtime and embedded driver without installing or granting access."""
    from abridge.cua_driver import CuaDriverAdapter

    driver = CuaDriverAdapter()
    try:
        dependencies = await driver.diagnostics()
    finally:
        await driver.shutdown()
    return {
        "version": __version__,
        "runtime": runtime_status(),
        **dependencies,
    }


def runtime_status() -> dict[str, Any]:
    missing = [name for name in ("websockets",) if importlib.util.find_spec(name) is None]
    return {
        "python": platform.python_version(),
        "supported_python": ">=3.12,<3.15",
        "ready": not missing and (3, 12) <= sys.version_info[:2] < (3, 15),
        "missing_packages": missing,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Return a machine-readable report")
    parser.parse_args()
    print(json.dumps(asyncio.run(check_dependencies()), ensure_ascii=False))


if __name__ == "__main__":
    main()
