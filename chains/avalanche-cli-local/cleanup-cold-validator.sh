#!/bin/bash
# cleanup-cold-validator.sh — Stop the temporary AvalancheGo node used for cold-join onboarding tests.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MANIFEST_PATH="${SCRIPT_DIR}/runtime/cold-validator/cold-validator-manifest.json"

if [ ! -f "${MANIFEST_PATH}" ]; then
    echo "ℹ️ No cold validator manifest found at ${MANIFEST_PATH}."
    exit 0
fi

export MANIFEST_PATH

python3 <<'PY'
import json
import os
import pathlib
import shutil
import signal
import subprocess
import time

manifest_path = pathlib.Path(os.environ["MANIFEST_PATH"])
manifest = json.loads(manifest_path.read_text())
pid = manifest.get("pid")
runtime_dir = pathlib.Path(manifest.get("runtimeDir", manifest_path.parent))

if pid:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    else:
        for _ in range(20):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.5)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

if runtime_dir.exists():
    shutil.rmtree(runtime_dir, ignore_errors=True)
PY

echo "✅ Cold-join validator runtime cleaned."
