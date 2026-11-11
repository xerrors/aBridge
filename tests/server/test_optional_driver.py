"""The Linux/server distribution must not load a native device dependency."""

import os
import subprocess
import sys
from pathlib import Path


def test_server_import_does_not_load_the_optional_device_driver(tmp_path: Path) -> None:
    environment = {**os.environ, "ABRIDGE_DB": str(tmp_path / "server.db")}
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import abridge.server; "
            "assert 'cua_driver' not in sys.modules; "
            "assert 'abridge.cua_driver' not in sys.modules; "
            "abridge.server.app.state.store.close()",
        ],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
