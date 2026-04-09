#!/bin/bash

SIGNATURE_AGGREGATOR_RUNTIME_DIR="${HOME}/.avalanche-cli/runs/LocalNetwork/signature-aggregator"

resolve_avalanche_cli() {
    if [ -n "${AVALANCHE_CLI_BIN:-}" ] && [ -x "${AVALANCHE_CLI_BIN}" ]; then
        echo "${AVALANCHE_CLI_BIN}"
        return 0
    fi

    if command -v avalanche >/dev/null 2>&1; then
        command -v avalanche
        return 0
    fi

    if command -v avalanche-cli >/dev/null 2>&1; then
        command -v avalanche-cli
        return 0
    fi

    for candidate in \
        "$HOME/bin/avalanche" \
        "$HOME/.avalanche-cli/bin/avalanche" \
        "/opt/homebrew/bin/avalanche" \
        "/usr/local/bin/avalanche"
    do
        if [ -x "${candidate}" ]; then
            echo "${candidate}"
            return 0
        fi
    done

    echo ""
    echo "❌ Avalanche CLI not found."
    echo ""
    echo "Set AVALANCHE_CLI_BIN explicitly or ensure one of these is available:"
    echo "   avalanche"
    echo "   avalanche-cli"
    echo "   \$HOME/bin/avalanche"
    echo "   /opt/homebrew/bin/avalanche"
    echo ""
    return 1
}

resolve_avalanchego_bin() {
    local candidate

    if [ -n "${AVALANCHEGO_BIN:-}" ] && [ -x "${AVALANCHEGO_BIN}" ]; then
        echo "${AVALANCHEGO_BIN}"
        return 0
    fi

    for candidate in \
        "${HOME}/.avalanche-cli/bin/avalanchego/avalanchego-v1.14.0/avalanchego" \
        "${HOME}/.avalanche-cli/bin/avalanchego/avalanchego" \
        "${HOME}/bin/avalanchego" \
        "/opt/homebrew/bin/avalanchego" \
        "/usr/local/bin/avalanchego"
    do
        if [ -x "${candidate}" ]; then
            echo "${candidate}"
            return 0
        fi
    done

    echo ""
    echo "❌ AvalancheGo binary not found."
    echo ""
    echo "Set AVALANCHEGO_BIN explicitly or ensure one of these is available:"
    echo "   ${HOME}/.avalanche-cli/bin/avalanchego/avalanchego-v1.14.0/avalanchego"
    echo "   ${HOME}/bin/avalanchego"
    echo "   /opt/homebrew/bin/avalanchego"
    echo ""
    return 1
}

resolve_signature_aggregator_bin() {
    local candidate

    for candidate in \
        "${HOME}/.avalanche-cli/bin/signature-aggregator/signature-aggregator-v0.5.3/signature-aggregator" \
        "${HOME}/.avalanche-cli/bin/signature-aggregator/signature-aggregator" \
        "${HOME}/bin/signature-aggregator" \
        "/opt/homebrew/bin/signature-aggregator" \
        "/usr/local/bin/signature-aggregator"
    do
        if [ -x "${candidate}" ]; then
            echo "${candidate}"
            return 0
        fi
    done

    echo ""
    echo "❌ Signature Aggregator binary not found."
    echo ""
    echo "Expected one of:"
    echo "   ${HOME}/.avalanche-cli/bin/signature-aggregator/signature-aggregator-v0.5.3/signature-aggregator"
    echo "   ${HOME}/bin/signature-aggregator"
    echo "   /opt/homebrew/bin/signature-aggregator"
    echo ""
    return 1
}

signature_aggregator_config_file() {
    echo "${SIGNATURE_AGGREGATOR_RUNTIME_DIR}/config.json"
}

signature_aggregator_process_file() {
    echo "${SIGNATURE_AGGREGATOR_RUNTIME_DIR}/process.json"
}

signature_aggregator_log_file() {
    echo "${SIGNATURE_AGGREGATOR_RUNTIME_DIR}/signature-aggregator.log"
}

read_json_field() {
    local file_path="$1"
    local field_name="$2"

    if [ ! -f "${file_path}" ]; then
        return 1
    fi

    python3 - "${file_path}" "${field_name}" <<'PY'
import json
import pathlib
import sys

file_path = pathlib.Path(sys.argv[1])
field_name = sys.argv[2]

try:
    payload = json.loads(file_path.read_text())
except Exception:
    sys.exit(1)

value = payload.get(field_name)
if value is None:
    sys.exit(1)

print(value)
PY
}

signature_aggregator_api_port() {
    read_json_field "$(signature_aggregator_config_file)" "api-port"
}

signature_aggregator_metrics_port() {
    read_json_field "$(signature_aggregator_config_file)" "metrics-port"
}

signature_aggregator_pid() {
    read_json_field "$(signature_aggregator_process_file)" "pid"
}

is_process_alive() {
    local pid="$1"
    if [ -z "${pid}" ]; then
        return 1
    fi
    kill -0 "${pid}" >/dev/null 2>&1
}

is_port_listening() {
    local port="$1"
    if [ -z "${port}" ]; then
        return 1
    fi

    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
        return $?
    fi

    return 1
}

write_signature_aggregator_process_file() {
    local pid="$1"
    local api_port="$2"
    local metrics_port="$3"
    local process_file

    process_file="$(signature_aggregator_process_file)"
    mkdir -p "$(dirname "${process_file}")"

    python3 - "${process_file}" "${pid}" "${api_port}" "${metrics_port}" <<'PY'
import json
import pathlib
import sys

process_file = pathlib.Path(sys.argv[1])
pid = int(sys.argv[2])
api_port = int(sys.argv[3])
metrics_port = int(sys.argv[4]) if sys.argv[4] else 0

process_file.write_text(
    json.dumps(
        {
            "pid": pid,
            "api_port": api_port,
            "metrics_port": metrics_port,
            "version": "chainsmith-managed",
        }
    )
)
PY
}

ensure_signature_aggregator_running() {
    local config_file
    local process_file
    local log_file
    local api_port
    local metrics_port
    local existing_pid
    local aggregator_bin
    local new_pid
    local attempt

    config_file="$(signature_aggregator_config_file)"
    process_file="$(signature_aggregator_process_file)"
    log_file="$(signature_aggregator_log_file)"

    if [ ! -f "${config_file}" ]; then
        echo "❌ Signature Aggregator config file not found: ${config_file}"
        return 1
    fi

    api_port="$(signature_aggregator_api_port)" || {
        echo "❌ Failed to read Signature Aggregator API port from ${config_file}"
        return 1
    }
    metrics_port="$(signature_aggregator_metrics_port || true)"

    if is_port_listening "${api_port}"; then
        echo "✅ Signature Aggregator is already listening on port ${api_port}."
        return 0
    fi

    existing_pid="$(signature_aggregator_pid || true)"
    if is_process_alive "${existing_pid}"; then
        echo "⚠️ Signature Aggregator process ${existing_pid} is alive but port ${api_port} is not listening."
        echo "   Restarting it..."
        kill "${existing_pid}" >/dev/null 2>&1 || true
        sleep 1
    fi

    aggregator_bin="$(resolve_signature_aggregator_bin)" || return 1

    mkdir -p "$(dirname "${log_file}")"
    echo "🚀 Starting Signature Aggregator on port ${api_port}..."
    new_pid="$(
        python3 - "${aggregator_bin}" "${config_file}" "${log_file}" <<'PY'
import pathlib
import subprocess
import sys

binary = pathlib.Path(sys.argv[1])
config = pathlib.Path(sys.argv[2])
log_file = pathlib.Path(sys.argv[3])
log_file.parent.mkdir(parents=True, exist_ok=True)

with log_file.open("ab") as log_handle, open("/dev/null", "rb") as devnull:
    process = subprocess.Popen(
        [str(binary), "--config-file", str(config)],
        stdin=devnull,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )

print(process.pid)
PY
    )"

    write_signature_aggregator_process_file "${new_pid}" "${api_port}" "${metrics_port:-0}"

    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if is_port_listening "${api_port}"; then
            echo "✅ Signature Aggregator is listening on port ${api_port}."
            return 0
        fi

        if ! is_process_alive "${new_pid}"; then
            break
        fi

        sleep 1
    done

    echo "❌ Signature Aggregator failed to start on port ${api_port}."
    echo "📝 Recent log output:"
    tail -20 "${log_file}" 2>/dev/null || true
    return 1
}

stop_signature_aggregator() {
    local process_file
    local existing_pid
    local api_port
    local listening_pids

    process_file="$(signature_aggregator_process_file)"
    existing_pid="$(signature_aggregator_pid || true)"
    api_port="$(signature_aggregator_api_port || true)"

    if is_process_alive "${existing_pid}"; then
        echo "🛑 Stopping Signature Aggregator process ${existing_pid}..."
        kill "${existing_pid}" >/dev/null 2>&1 || true
        sleep 1
    fi

    if [ -n "${api_port}" ] && is_port_listening "${api_port}"; then
        echo "🛑 Releasing Signature Aggregator port ${api_port}..."
        listening_pids="$(lsof -tiTCP:"${api_port}" -sTCP:LISTEN 2>/dev/null || true)"
        if [ -n "${listening_pids}" ]; then
            # shellcheck disable=SC2086
            kill ${listening_pids} >/dev/null 2>&1 || true
        fi
        sleep 1
    fi

    if [ -f "${process_file}" ]; then
        rm -f "${process_file}"
    fi
}
