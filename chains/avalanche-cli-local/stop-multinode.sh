#!/bin/bash
# stop-multinode.sh — Stop or clean the local Avalanche network used for Subnet-EVM testing
#
# Usage:
#   chmod +x stop-multinode.sh
#   ./stop-multinode.sh          # stop network, preserve state
#   ./stop-multinode.sh clean    # clean network state
#   ./stop-multinode.sh status   # show local network status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

ACTION="${1:-stop}"
CLI_BIN="$(resolve_avalanche_cli)"

case "${ACTION}" in
    stop)
        echo "🛑 Stopping local Avalanche network..."
        stop_signature_aggregator
        "${CLI_BIN}" network stop
        echo "✅ Network stopped. State is preserved."
        ;;
    clean)
        echo "🧹 Cleaning local Avalanche network state..."
        stop_signature_aggregator
        "${CLI_BIN}" network clean
        echo "✅ Network state cleaned."
        ;;
    status)
        echo "📊 Local Avalanche network status..."
        "${CLI_BIN}" network status
        ;;
    *)
        echo "Usage: $0 [stop|clean|status]"
        exit 1
        ;;
esac

echo ""
