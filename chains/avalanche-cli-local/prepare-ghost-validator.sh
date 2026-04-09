#!/bin/bash
# prepare-ghost-validator.sh — Start a temporary AvalancheGo node, extract its identity,
# stop it, and persist a manifest for ghost validator tests.
#
# Usage:
#   ./prepare-ghost-validator.sh
#
# Output:
#   chains/avalanche-cli-local/runtime/ghost-validator-manifest.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

RUNTIME_DIR="${SCRIPT_DIR}/runtime/ghost-validator"
MANIFEST_PATH="${RUNTIME_DIR}/ghost-validator-manifest.json"
PROCESS_PATH="${RUNTIME_DIR}/process.json"
MAIN_LOG_PATH="${RUNTIME_DIR}/logs/main.log"
SANITIZED_FLAGS_PATH="${RUNTIME_DIR}/ghost-flags.json"

mkdir -p "${RUNTIME_DIR}"

AVALANCHEGO_BIN="$(resolve_avalanchego_bin)"
METADATA_JSON="$("${SCRIPT_DIR}/extract-metadata.sh")"

export RUNTIME_DIR
export MANIFEST_PATH
export PROCESS_PATH
export MAIN_LOG_PATH
export SANITIZED_FLAGS_PATH
export METADATA_JSON
export AVALANCHEGO_BIN

python3 <<'PY'
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import time
from urllib.request import urlopen


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_process_context(process_path: pathlib.Path, timeout_s: int = 30) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if process_path.exists():
            try:
                return json.loads(process_path.read_text())
            except json.JSONDecodeError:
                pass
        time.sleep(0.5)
    raise TimeoutError(f"Timed out waiting for process context at {process_path}")


def wait_for_health(health_url: str, timeout_s: int = 60) -> None:
    deadline = time.time() + timeout_s
    last_error = None
    while time.time() < deadline:
        try:
            with urlopen(health_url, timeout=5) as response:
                payload = json.loads(response.read().decode())
                if payload.get("healthy") is True:
                    return
                last_error = f"healthy={payload.get('healthy')}"
        except Exception as exc:
            last_error = str(exc)
        time.sleep(1)
    raise TimeoutError(f"Timed out waiting for health on {health_url}: {last_error}")


def wait_for_identity(main_log_path: pathlib.Path, timeout_s: int = 60) -> tuple[str, str, str]:
    deadline = time.time() + timeout_s
    pattern = re.compile(r'"nodeID":\s*"([^"]+)".*"nodePOP":\s*\{"publicKey":"([^"]+)","proofOfPossession":"([^"]+)"\}')
    while time.time() < deadline:
        if main_log_path.exists():
            text = main_log_path.read_text(errors="replace")
            match = pattern.search(text)
            if match:
                return match.group(1), match.group(2), match.group(3)
        time.sleep(1)
    raise TimeoutError(f"Timed out waiting for node identity in {main_log_path}")


runtime_dir = pathlib.Path(os.environ["RUNTIME_DIR"])
manifest_path = pathlib.Path(os.environ["MANIFEST_PATH"])
process_path = pathlib.Path(os.environ["PROCESS_PATH"])
main_log_path = pathlib.Path(os.environ["MAIN_LOG_PATH"])
sanitized_flags_path = pathlib.Path(os.environ["SANITIZED_FLAGS_PATH"])
metadata = json.loads(os.environ["METADATA_JSON"])
avalanchego_bin = pathlib.Path(os.environ["AVALANCHEGO_BIN"])

if runtime_dir.exists():
    shutil.rmtree(runtime_dir)
runtime_dir.mkdir(parents=True, exist_ok=True)
(runtime_dir / "logs").mkdir(parents=True, exist_ok=True)

primary_nodes = metadata.get("primaryNodes", [])
if not primary_nodes:
    raise SystemExit("No primary nodes discovered; cannot prepare ghost validator candidate")

bootstrap_ids = ",".join(node["nodeId"] for node in primary_nodes if node.get("nodeId"))
bootstrap_ips = ",".join(node["stakingAddress"] for node in primary_nodes if node.get("stakingAddress"))
template_flags = pathlib.Path(primary_nodes[0]["nodeDir"]) / "flags.json"
if not template_flags.exists():
    raise SystemExit(f"Template flags.json not found: {template_flags}")

template_config = json.loads(template_flags.read_text())

http_port = reserve_port()
staking_port = reserve_port()

for removable_key in [
    "config-file",
    "data-dir",
    "db-dir",
    "log-dir",
    "chain-data-dir",
    "profile-dir",
    "process-context-file",
    "http-port",
    "staking-port",
    "bootstrap-ids",
    "bootstrap-ips",
    "public-ip",
    "staking-tls-cert-file",
    "staking-tls-cert-file-content",
    "staking-tls-key-file",
    "staking-tls-key-file-content",
    "staking-signer-key-file",
    "staking-signer-key-file-content",
    "staking-rpc-signer-endpoint",
    "staking-ephemeral-cert-enabled",
    "staking-ephemeral-signer-enabled",
]:
    template_config.pop(removable_key, None)

template_config.update(
    {
        "data-dir": str(runtime_dir / "data"),
        "db-dir": str(runtime_dir / "db"),
        "log-dir": str(runtime_dir / "logs"),
        "chain-data-dir": str(runtime_dir / "chainData"),
        "profile-dir": str(runtime_dir / "profiles"),
        "process-context-file": str(process_path),
        "http-host": "127.0.0.1",
        "staking-host": "127.0.0.1",
        "http-port": http_port,
        "staking-port": staking_port,
        "public-ip": "127.0.0.1",
        "bootstrap-ids": bootstrap_ids,
        "bootstrap-ips": bootstrap_ips,
        "staking-ephemeral-cert-enabled": True,
        "staking-ephemeral-signer-enabled": True,
    }
)

sanitized_flags_path.write_text(json.dumps(template_config, indent=2))

command = [
    str(avalanchego_bin),
    "--config-file",
    str(sanitized_flags_path),
]

with (runtime_dir / "avalanchego.stdout.log").open("ab") as stdout_handle, open("/dev/null", "rb") as devnull:
    process = subprocess.Popen(
        command,
        stdin=devnull,
        stdout=stdout_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )

try:
    process_context = wait_for_process_context(process_path)
    health_url = f"{process_context['uri']}/ext/health"
    wait_for_health(health_url)
    node_id, bls_public_key, bls_proof_of_possession = wait_for_identity(main_log_path)
finally:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)

manifest = {
    "preparedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "source": "prepare-ghost-validator.sh",
    "nodeId": node_id,
    "uri": process_context["uri"],
    "healthApiUrl": health_url,
    "blsPublicKey": bls_public_key,
    "blsProofOfPossession": bls_proof_of_possession,
    "runtimeDir": str(runtime_dir),
}

manifest_path.write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest, indent=2))
PY

echo ""
echo "✅ Ghost validator manifest written:"
echo "   ${MANIFEST_PATH}"
echo ""
