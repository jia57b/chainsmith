#!/bin/bash
# stop-multinode.sh — Stop TAC multi-validator localnet
#
# Usage:
#   chmod +x stop-multinode.sh
#   ./stop-multinode.sh [--clean]
#
# Options:
#   --clean   Also remove testnet-data (full reset, requires re-init)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

echo "🛑 Stopping TAC multi-validator localnet..."
docker compose -f "$COMPOSE_FILE" down 2>/dev/null || true
echo "   ✅ Containers stopped"

if [ "$1" = "--clean" ]; then
    echo ""
    echo "🧹 Cleaning testnet data..."
    rm -rf "${SCRIPT_DIR}/tacchain/.testnet" 2>/dev/null || true
    echo "   ✅ Testnet data cleaned"
    echo "   Run ./init-multinode.sh to re-initialize"
fi

echo ""
echo "✅ TAC multi-validator localnet stopped."
