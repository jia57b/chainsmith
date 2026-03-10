#!/bin/bash
# stop-multinode.sh — Stop 0G multi-validator localnet
#
# Usage:
#   chmod +x stop-multinode.sh
#   ./stop-multinode.sh [--clean]
#
# Options:
#   --clean   Also remove Docker volumes (full reset, requires re-init)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

echo "🛑 Stopping 0G multi-validator localnet..."
docker compose -f "$COMPOSE_FILE" down 2>/dev/null || true
echo "   ✅ Containers stopped"

if [ "$1" = "--clean" ]; then
    echo ""
    echo "🧹 Cleaning Docker volumes..."
    for i in 1 2 3 4; do
        docker volume rm -f validator${i}_node_config 2>/dev/null || true
        docker volume rm -f validator${i}_node_data 2>/dev/null || true
        docker volume rm -f validator${i}_geth_data 2>/dev/null || true
    done
    echo "   ✅ Volumes cleaned"
    echo "   Run ./init-multinode.sh to re-initialize"
fi

echo ""
echo "✅ 0G multi-validator localnet stopped."
