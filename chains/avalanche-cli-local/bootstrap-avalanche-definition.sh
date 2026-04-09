#!/bin/bash
# bootstrap-avalanche-definition.sh — Create the ChainSmith Avalanche definition
# non-interactively by driving `avalanche blockchain create`.
#
# Usage:
#   ./bootstrap-avalanche-definition.sh
#   ./bootstrap-avalanche-definition.sh --force
#
# Optional environment variables:
#   AVALANCHE_CHAIN_NAME           Chain definition name (default: chainsmithavalanche)
#   AVALANCHE_BOOTSTRAP_CHAIN_ID   EVM Chain ID to enter in the wizard (default: 9003)
#   AVALANCHE_BOOTSTRAP_TOKEN      Token symbol to enter in the wizard (default: ABC)
#   AVALANCHE_BOOTSTRAP_OWNER_KEY  Stored key name for PoA owner (default: ewoq)
#
# Notes:
#   - This bootstraps only the saved chain definition under ~/.avalanche-cli/subnets/.
#   - `start-multinode.sh` remains responsible for the actual local deployment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

CHAIN_NAME="${AVALANCHE_CHAIN_NAME:-chainsmithavalanche}"
CHAIN_ID="${AVALANCHE_BOOTSTRAP_CHAIN_ID:-9003}"
TOKEN_SYMBOL="${AVALANCHE_BOOTSTRAP_TOKEN:-ABC}"
OWNER_KEY="${AVALANCHE_BOOTSTRAP_OWNER_KEY:-ewoq}"
FORCE_MODE="false"

if [ "${1:-}" = "--force" ]; then
    FORCE_MODE="true"
elif [ $# -gt 0 ]; then
    echo "Usage: $0 [--force]" >&2
    exit 1
fi

CLI_BIN="$(resolve_avalanche_cli)"
SUBNET_DIR="${HOME}/.avalanche-cli/subnets/${CHAIN_NAME}"

if [ -d "${SUBNET_DIR}" ] && [ "${FORCE_MODE}" != "true" ]; then
    echo "ℹ️ Avalanche definition already exists at ${SUBNET_DIR}"
    echo "   Use --force to recreate it non-interactively."
    exit 0
fi

echo "============================================"
echo "  Avalanche Definition Bootstrap"
echo "  CLI: ${CLI_BIN}"
echo "  Chain Name: ${CHAIN_NAME}"
echo "  Chain ID: ${CHAIN_ID}"
echo "  Token Symbol: ${TOKEN_SYMBOL}"
echo "  Owner Key: ${OWNER_KEY}"
echo "  Force Overwrite: ${FORCE_MODE}"
echo "============================================"
echo ""

PY_ARGS=(
    --cli-bin "${CLI_BIN}"
    --chain-name "${CHAIN_NAME}"
    --chain-id "${CHAIN_ID}"
    --token-symbol "${TOKEN_SYMBOL}"
    --owner-key "${OWNER_KEY}"
)

if [ "${FORCE_MODE}" = "true" ]; then
    PY_ARGS+=(--force)
fi

python3 "${SCRIPT_DIR}/bootstrap-avalanche-definition.py" "${PY_ARGS[@]}"

echo ""
echo "✅ Avalanche definition bootstrapped"
echo "   Dir: ${SUBNET_DIR}"
echo ""
echo "Next step:"
echo "   ./chains/avalanche-cli-local/start-multinode.sh"
