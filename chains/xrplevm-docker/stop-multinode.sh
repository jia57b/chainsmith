#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🛑 Stopping XRPLEVM multi-validator localnet..."
docker compose down

if [ "$1" == "--clean" ]; then
    echo "🧹 Cleaning up testnet data..."
    rm -rf .testnet
    echo "✅ Cleanup complete!"
else
    echo "✅ Stopped! Run ./start-multinode.sh to start again, or ./stop-multinode.sh --clean to wipe data."
fi
