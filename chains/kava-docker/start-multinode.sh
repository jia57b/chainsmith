#!/bin/bash
# start-multinode.sh — Start Kava 4-validator localnet
#
# Prerequisites:
#   Run ./init-multinode.sh first to initialize all validators
#
# Usage:
#   chmod +x start-multinode.sh
#   ./start-multinode.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.multinode.yml"

if [ ! -f "${SCRIPT_DIR}/.env.multinode" ]; then
    echo "❌ .env.multinode not found. Run ./init-multinode.sh first."
    exit 1
fi

echo "🚀 Starting Kava multi-validator localnet..."
docker compose --env-file "${SCRIPT_DIR}/.env.multinode" -f "$COMPOSE_FILE" up -d

# Wait for RPC to be ready
echo ""
echo "⏳ Waiting for network to produce blocks..."
MAX_WAIT=120
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    # Check if CometBFT RPC is responding with a block height > 0
    HEIGHT=$(curl -s http://localhost:26657/status 2>/dev/null | \
      grep -o '"latest_block_height":"[0-9]*"' | \
      grep -o '[0-9]*' || echo "0")

    if [ "$HEIGHT" != "0" ] && [ -n "$HEIGHT" ]; then
        echo "   ✅ Block height: ${HEIGHT}"
        break
    fi

    echo "   Waiting... (${WAITED}s)"
    sleep 5
    WAITED=$((WAITED + 5))
done

if [ $WAITED -ge $MAX_WAIT ]; then
    echo "   ⚠️  Timeout waiting for blocks. Check logs:"
    echo "   1. Check logs:   docker compose --env-file .env.multinode -f docker-compose.multinode.yml logs kava-validator1"
    echo "   2. Check status: docker compose --env-file .env.multinode -f docker-compose.multinode.yml ps"
    exit 1
fi

# Verify validator count
VALIDATOR_COUNT=$(curl -s http://localhost:26657/validators 2>/dev/null | \
  grep -o '"total":"[0-9]*"' | \
  grep -o '[0-9]*' | head -1 || echo "unknown")

# Check EVM JSON-RPC
EVM_OK=$(curl -s -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' 2>/dev/null | \
  grep -c "result" || echo "0")

echo ""
echo "✅ Kava multi-validator localnet started!"
echo ""
echo "📊 Network Status:"
echo "   Block Height:    ${HEIGHT}"
echo "   Validators:      ${VALIDATOR_COUNT}"
echo "   EVM JSON-RPC:    $([ "$EVM_OK" -gt 0 ] && echo '✅ Ready' || echo '⚠️  Not ready yet')"
echo ""
echo "📍 Validator 1 Endpoints (primary):"
echo "   CometBFT RPC:   http://localhost:26657"
echo "   Cosmos REST:     http://localhost:1317"
echo "   EVM JSON-RPC:    http://localhost:8545"
echo "   EVM WebSocket:   ws://localhost:8546"
echo "   gRPC:            localhost:9090"
echo ""
echo "📍 Other Validators:"
echo "   Validator 2:     RPC=:36657  REST=:21317  EVM=:28545"
echo "   Validator 3:     RPC=:46657  REST=:31317  EVM=:38545"
echo "   Validator 4:     RPC=:56657  REST=:41317  EVM=:48545"
echo ""

# Print founder wallet info if available
if [ -f "${SCRIPT_DIR}/.founder-info" ]; then
    echo "📋 Founder Wallet (from .founder-info):"
    grep -v "^#" "${SCRIPT_DIR}/.founder-info" | sed 's/^/   /'
    echo ""
fi

echo "To stop: ./stop-multinode.sh"
echo ""
