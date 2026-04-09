#!/bin/bash
# remove-validator.sh — Remove a validator from a local Avalanche L1 (PoA-focused helper)
#
# Usage:
#   ./remove-validator.sh --chain-name <name> --node-endpoint <http://127.0.0.1:9650> \
#     --validator-manager-owner <0x-address> [--fee-payer-mode stored-key|ledger] [--fee-payer-stored-key ewoq] [--force]
#   ./remove-validator.sh --chain-name <name> --node-id <NodeID-...> \
#     --validator-manager-owner <0x-address> [--fee-payer-mode stored-key|ledger] [--fee-payer-stored-key ewoq] [--force]
#
# Notes:
#   - This script is intended for PoA validator lifecycle testing.
#   - It does not run tests; it only executes the CLI operation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

CHAIN_NAME=""
NODE_ENDPOINT=""
NODE_ID=""
RPC_ENDPOINT=""
VALIDATOR_MANAGER_OWNER=""
FEE_PAYER_MODE="stored-key"
FEE_PAYER_STORED_KEY="ewoq"
REMOVE_FORCE="false"

while [ $# -gt 0 ]; do
    case "$1" in
        --chain-name)
            CHAIN_NAME="$2"
            shift 2
            ;;
        --node-endpoint)
            NODE_ENDPOINT="$2"
            shift 2
            ;;
        --node-id)
            NODE_ID="$2"
            shift 2
            ;;
        --rpc)
            RPC_ENDPOINT="$2"
            shift 2
            ;;
        --validator-manager-owner)
            VALIDATOR_MANAGER_OWNER="$2"
            shift 2
            ;;
        --fee-payer-mode)
            FEE_PAYER_MODE="$2"
            shift 2
            ;;
        --fee-payer-stored-key)
            FEE_PAYER_STORED_KEY="$2"
            shift 2
            ;;
        --force)
            REMOVE_FORCE="true"
            shift
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [ -z "${CHAIN_NAME}" ] || [ -z "${VALIDATOR_MANAGER_OWNER}" ] || { [ -z "${NODE_ENDPOINT}" ] && [ -z "${NODE_ID}" ]; }; then
    echo "Usage: $0 --chain-name <name> (--node-endpoint <uri> | --node-id <NodeID>) --validator-manager-owner <0x-address> [--fee-payer-mode stored-key|ledger] [--fee-payer-stored-key ewoq] [--force]" >&2
    exit 1
fi

CLI_BIN="$(resolve_avalanche_cli)"
OUTPUT_DIR="${SCRIPT_DIR}/output"
mkdir -p "${OUTPUT_DIR}"
LOG_FILE="${OUTPUT_DIR}/remove-validator-${CHAIN_NAME}-$(date +%Y%m%d-%H%M%S).log"

CMD=(
    python3
    "${SCRIPT_DIR}/remove-validator.py"
    --cli-bin "${CLI_BIN}"
    --chain-name "${CHAIN_NAME}"
    --validator-manager-owner "${VALIDATOR_MANAGER_OWNER}"
    --fee-payer-mode "${FEE_PAYER_MODE}"
)

if [ -n "${NODE_ENDPOINT}" ]; then
    CMD+=(--node-endpoint "${NODE_ENDPOINT}")
else
    CMD+=(--node-id "${NODE_ID}")
fi

if [ "${FEE_PAYER_MODE}" = "stored-key" ] && [ -n "${FEE_PAYER_STORED_KEY}" ]; then
    CMD+=(--fee-payer-stored-key "${FEE_PAYER_STORED_KEY}")
fi

if [ "${REMOVE_FORCE}" = "true" ]; then
    CMD+=(--force)
fi

echo "🚀 Removing validator from ${CHAIN_NAME}..."
echo "📝 Log file: ${LOG_FILE}"
printf 'Command: %q ' "${CMD[@]}" | tee "${LOG_FILE}"
echo "" | tee -a "${LOG_FILE}"

"${CMD[@]}" 2>&1 | tee -a "${LOG_FILE}"

echo ""
echo "✅ Remove validator command completed."
echo "📝 Log file: ${LOG_FILE}"
