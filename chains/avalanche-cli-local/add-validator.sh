#!/bin/bash
# add-validator.sh — Add a validator to a local Avalanche L1 (PoA-focused helper)
#
# Usage:
#   ./add-validator.sh --chain-name <name> --node-endpoint <http://127.0.0.1:9650> \
#     --rpc <l1-rpc> --remaining-balance-owner <P-address> --disable-owner <P-address> \
#     --validator-manager-owner <0x-address> [--balance 100000000] [--weight 20] \
#     [--fee-payer-mode stored-key|ledger] [--fee-payer-stored-key ewoq]
#   ./add-validator.sh --chain-name <name> --node-id <NodeID-...> \
#     --bls-public-key <0x...> --bls-proof-of-possession <0x...> \
#     --rpc <l1-rpc> --remaining-balance-owner <P-address> --disable-owner <P-address> \
#     --validator-manager-owner <0x-address> [--balance 0.1] [--weight 20]
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
BLS_PUBLIC_KEY=""
BLS_PROOF_OF_POSSESSION=""
RPC_ENDPOINT=""
REMAINING_BALANCE_OWNER=""
DISABLE_OWNER=""
BALANCE="100000000"
WEIGHT=""
VALIDATOR_MANAGER_OWNER=""
FEE_PAYER_MODE="stored-key"
FEE_PAYER_STORED_KEY="ewoq"

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
        --bls-public-key)
            BLS_PUBLIC_KEY="$2"
            shift 2
            ;;
        --bls-proof-of-possession)
            BLS_PROOF_OF_POSSESSION="$2"
            shift 2
            ;;
        --rpc)
            RPC_ENDPOINT="$2"
            shift 2
            ;;
        --remaining-balance-owner)
            REMAINING_BALANCE_OWNER="$2"
            shift 2
            ;;
        --disable-owner)
            DISABLE_OWNER="$2"
            shift 2
            ;;
        --balance)
            BALANCE="$2"
            shift 2
            ;;
        --weight)
            WEIGHT="$2"
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
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

USING_ENDPOINT="false"
if [ -n "${NODE_ENDPOINT}" ]; then
    USING_ENDPOINT="true"
fi

USING_IDENTITY="false"
if [ -n "${NODE_ID}" ] && [ -n "${BLS_PUBLIC_KEY}" ] && [ -n "${BLS_PROOF_OF_POSSESSION}" ]; then
    USING_IDENTITY="true"
fi

if [ -z "${CHAIN_NAME}" ] || [ -z "${RPC_ENDPOINT}" ] || [ -z "${REMAINING_BALANCE_OWNER}" ] || [ -z "${DISABLE_OWNER}" ] || [ -z "${VALIDATOR_MANAGER_OWNER}" ]; then
    echo "Usage: $0 --chain-name <name> (--node-endpoint <uri> | --node-id <NodeID> --bls-public-key <0x...> --bls-proof-of-possession <0x...>) --rpc <uri> --remaining-balance-owner <P-address> --disable-owner <P-address> --validator-manager-owner <0x-address> [--balance 0.1] [--weight 20] [--fee-payer-mode stored-key|ledger] [--fee-payer-stored-key ewoq]" >&2
    exit 1
fi

if [ "${USING_ENDPOINT}" = "${USING_IDENTITY}" ]; then
    echo "Provide either --node-endpoint or the full ghost validator identity tuple." >&2
    exit 1
fi

CLI_BIN="$(resolve_avalanche_cli)"
OUTPUT_DIR="${SCRIPT_DIR}/output"
mkdir -p "${OUTPUT_DIR}"
LOG_FILE="${OUTPUT_DIR}/add-validator-${CHAIN_NAME}-$(date +%Y%m%d-%H%M%S).log"

CMD=(
    python3
    "${SCRIPT_DIR}/add-validator.py"
    --cli-bin "${CLI_BIN}"
    --chain-name "${CHAIN_NAME}"
    --rpc "${RPC_ENDPOINT}"
    --remaining-balance-owner "${REMAINING_BALANCE_OWNER}"
    --disable-owner "${DISABLE_OWNER}"
    --validator-manager-owner "${VALIDATOR_MANAGER_OWNER}"
    --balance "${BALANCE}"
    --weight "${WEIGHT}"
    --fee-payer-mode "${FEE_PAYER_MODE}"
)

if [ "${USING_ENDPOINT}" = "true" ]; then
    CMD+=(--node-endpoint "${NODE_ENDPOINT}")
else
    CMD+=(--node-id "${NODE_ID}" --bls-public-key "${BLS_PUBLIC_KEY}" --bls-proof-of-possession "${BLS_PROOF_OF_POSSESSION}")
fi

if [ "${FEE_PAYER_MODE}" = "stored-key" ] && [ -n "${FEE_PAYER_STORED_KEY}" ]; then
    CMD+=(--fee-payer-stored-key "${FEE_PAYER_STORED_KEY}")
fi

echo "🚀 Adding validator to ${CHAIN_NAME}..."
echo "📝 Log file: ${LOG_FILE}"
printf 'Command: %q ' "${CMD[@]}" | tee "${LOG_FILE}"
echo "" | tee -a "${LOG_FILE}"

"${CMD[@]}" 2>&1 | tee -a "${LOG_FILE}"

echo ""
echo "✅ Add validator command completed."
echo "📝 Log file: ${LOG_FILE}"
