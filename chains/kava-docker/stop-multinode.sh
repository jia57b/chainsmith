#!/bin/bash
# stop-multinode.sh — Stop Kava multi-validator localnet
#
# Usage:
#   chmod +x stop-multinode.sh
#   ./stop-multinode.sh [--clean]
#
# Options:
#   --clean   Also remove Docker volumes (full reset, requires re-init)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.multinode.yml"

echo "🛑 Stopping Kava multi-validator localnet..."
docker compose --env-file "${SCRIPT_DIR}/.env.multinode" -f "$COMPOSE_FILE" down 2>/dev/null || true
echo "   ✅ Containers stopped"

if [ "$1" = "--clean" ]; then
    echo ""
    echo "🧹 Cleaning Docker volumes..."
    for i in 1 2 3 4; do
        docker volume rm -f kava_validator${i}_home 2>/dev/null || true
    done
    rm -f "${SCRIPT_DIR}/.env.multinode" 2>/dev/null || true
    rm -f "${SCRIPT_DIR}/.founder-info" 2>/dev/null || true
    echo "   ✅ Volumes and config cleaned"
    echo "   Run ./init-multinode.sh to re-initialize"
fi

echo ""
echo "✅ Kava multi-validator localnet stopped."
