#!/bin/bash
# stop-multinode.sh — Stop Cronos multi-validator localnet
#
# Usage:
#   chmod +x stop-multinode.sh
#   ./stop-multinode.sh [--clean]
#
# Options:
#   --clean   Also remove Docker volumes (full reset, requires re-init)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
ENV_FILE="${SCRIPT_DIR}/.env.multinode"
PROJECT_NAME="cronos-docker"

echo "🛑 Stopping Cronos multi-validator localnet..."

if [ -f "$ENV_FILE" ]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down
else
    echo "   ⚠️  .env.multinode not found, falling back to compose project '${PROJECT_NAME}'"
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down
fi

echo "   ✅ Containers stopped"

if [ "${1:-}" = "--clean" ]; then
    echo ""
    echo "🧹 Cleaning Docker volumes..."
    for i in 1 2 3 4; do
        docker volume rm -f cronos_validator${i}_home 2>/dev/null || true
    done
    rm -f "$ENV_FILE" 2>/dev/null || true
    echo "   ✅ Volumes and config cleaned"
    echo "   Run ./init-multinode.sh to re-initialize"
fi

echo ""
echo "✅ Cronos multi-validator localnet stopped."
