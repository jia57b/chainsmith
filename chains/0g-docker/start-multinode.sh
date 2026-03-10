#!/bin/bash
# start-multinode.sh — Start 0G 4-node localnet
#
# Prerequisites:
#   Run ./init-multinode.sh first to initialize all validators
#
# Usage:
#   chmod +x start-multinode.sh
#   ./start-multinode.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

if [ ! -f "${SCRIPT_DIR}/.env" ]; then
    echo "❌ .env not found. Run ./init-multinode.sh first."
    exit 1
fi

echo "🚀 Starting 0G multi-validator localnet..."
docker compose -f "$COMPOSE_FILE" up -d

# Wait for RPC to be ready
echo ""
echo "⏳ Waiting for network to produce blocks..."
MAX_WAIT=120
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
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
    echo "   1. Check logs:   docker compose -f docker-compose.yml logs validator1-node"
    echo "   2. Check status: docker compose -f docker-compose.yml ps"
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
  grep -c "result" 2>/dev/null || true)
EVM_OK=${EVM_OK:-0}
EVM_OK=$((EVM_OK + 0))

if [ "$EVM_OK" -gt 0 ] 2>/dev/null; then
    EVM_STATUS="✅ Ready"
else
    EVM_STATUS="⚠️  Not ready yet"
fi

echo ""
echo "✅ 0G multi-validator localnet started!"
echo ""
echo "📊 Network Status:"
echo "   Block Height:    ${HEIGHT}"
echo "   Validators:      ${VALIDATOR_COUNT}"
echo "   EVM JSON-RPC:    ${EVM_STATUS}"
echo ""
echo "📍 Validator 1 Endpoints (primary):"
echo "   CometBFT RPC:   http://localhost:26657"
echo "   Cosmos REST:    http://localhost:1317"
echo "   EVM JSON-RPC:    http://localhost:8545"
echo ""
echo "📍 Other Validators:"
echo "   Validator 2:     RPC=:36657  REST=:21317  EVM=:28545"
echo "   Validator 3:     RPC=:46657  REST=:31317  EVM=:38545"
echo "   Validator 4:     RPC=:56657  REST=:41317  EVM=:48545"
echo ""

echo "To stop: ./stop-multinode.sh"
echo ""
