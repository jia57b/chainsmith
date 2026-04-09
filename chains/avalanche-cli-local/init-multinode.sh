#!/bin/bash
# init-multinode.sh — Initialize an Avalanche Subnet-EVM local L1 definition
#
# This script wraps `avalanche blockchain create` for the first-time setup.
# The command is interactive by design. Follow the prompts and choose:
#   - VM: Subnet-EVM
#   - Validator manager: Proof Of Authority
#   - Defaults for a test environment
#
# Usage:
#   chmod +x init-multinode.sh
#   ./init-multinode.sh
#   ./init-multinode.sh --force
#
# Optional environment variables:
#   AVALANCHE_CHAIN_NAME   Blockchain name to create (default: chainsmithavalanche)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

CHAIN_NAME="${AVALANCHE_CHAIN_NAME:-chainsmithavalanche}"
FORCE_MODE="false"

if [ "${1:-}" = "--force" ]; then
    FORCE_MODE="true"
elif [ $# -gt 0 ]; then
    echo "Usage: $0 [--force]"
    exit 1
fi

CLI_BIN="$(resolve_avalanche_cli)"

echo "============================================"
echo "  Avalanche Local L1 Init"
echo "  CLI: ${CLI_BIN}"
echo "  Blockchain Name: ${CHAIN_NAME}"
echo "  Force Overwrite: ${FORCE_MODE}"
echo "============================================"
echo ""
echo "This step is interactive."
echo "Recommended prompt choices:"
echo "  1. VM: Subnet-EVM"
echo "  2. Validator manager: Proof Of Authority"
echo "  3. Defaults for a test environment"
echo ""

CREATE_ARGS=("${CHAIN_NAME}")
if [ "${FORCE_MODE}" = "true" ]; then
    CREATE_ARGS+=("--force")
fi

"${CLI_BIN}" blockchain create "${CREATE_ARGS[@]}"

echo ""
echo "✅ Blockchain definition created: ${CHAIN_NAME}"
echo "Next step:"
echo "   ./start-multinode.sh"
echo ""
