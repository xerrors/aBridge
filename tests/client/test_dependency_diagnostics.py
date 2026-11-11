"""A broken client environment must still produce an actionable dependency report."""

import json
import os
import subprocess
import sys
from pathlib import Path


def test_dependency_report_runs_without_site_packages() -> None:
    environment = dict(os.environ)
    environment.pop("PYTHONPATH", None)
    result = subprocess.run(
        [sys.executable, "-S", "-m", "abridge.diagnostics", "--json"],
        cwd=Path(__file__).parents[2],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["runtime"]["ready"] is False
    assert "websockets" in report["runtime"]["missing_packages"]
    assert report["driver"]["installed"] is False
    assert report["driver"]["ready"] is False
