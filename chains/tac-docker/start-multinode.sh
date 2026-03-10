#!/bin/bash
# start-multinode.sh — Start TAC 4-validator localnet
#
# Prerequisites:
#   Run ./init-multinode.sh first to initialize all validators
#
# Usage:
#   chmod +x start-multinode.sh
#   ./start-multinode.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "tacchain/.testnet/node0" ]; then
    echo "❌ tacchain/.testnet not found. Run ./init-multinode.sh first."
    exit 1
fi

echo "🚀 Starting TAC multi-validator localnet..."
docker compose up -d

# Wait for RPC to be ready and blocks to be produced
echo ""
echo "⏳ Waiting for network to produce blocks..."
RPC_URL="http://localhost:45111"
MAX_WAIT=120
WAITED=0
HEIGHT="0"

while [ $WAITED -lt $MAX_WAIT ]; do
    # Check if CometBFT RPC is responding with a block height > 0
    HEIGHT=$(curl -s "${RPC_URL}/status" 2>/dev/null | \
      grep -o '"latest_block_height":"[0-9]*"' | \
      grep -o '[0-9]*' || echo "0")

    if [ -n "$HEIGHT" ] && [ "$HEIGHT" != "0" ]; then
        echo "   ✅ Block height: ${HEIGHT}"
        break
    fi

    echo "   Waiting... (${WAITED}s)"
    sleep 5
    WAITED=$((WAITED + 5))
done

if [ $WAITED -ge $MAX_WAIT ]; then
    echo "   ⚠️  Timeout waiting for blocks. Check logs:"
    echo "   1. Check logs:   docker compose logs tac-node-0"
    echo "   2. Check status: docker compose ps"
    exit 1
fi

# Verify validator count
VALIDATOR_COUNT=$(curl -s "${RPC_URL}/validators" 2>/dev/null | \
  grep -o '"total":"[0-9]*"' | \
  grep -o '[0-9]*' | head -1 || echo "unknown")

# Check EVM JSON-RPC (trim to avoid newline causing "integer expression expected" in GitHub Actions)
EVM_OK=$(curl -s -X POST http://localhost:45118 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' 2>/dev/null | \
  grep -c "result" 2>/dev/null || true)
EVM_OK=${EVM_OK:-0}
EVM_OK=$((EVM_OK + 0))  # Ensure numeric, strips whitespace/newlines

if [ "$EVM_OK" -gt 0 ] 2>/dev/null; then
    EVM_STATUS="✅ Ready"
else
    EVM_STATUS="⚠️  Not ready yet"
fi

echo ""
echo "✅ TAC multi-validator localnet started!"
echo ""
echo "📊 Network Status:"
echo "   Block Height:    ${HEIGHT}"
echo "   Validators:      ${VALIDATOR_COUNT}"
echo "   EVM JSON-RPC:    ${EVM_STATUS}"
echo ""
echo "📍 Validator 1 (tac-node-0) Endpoints (primary):"
echo "   CometBFT RPC:    http://localhost:45111"
echo "   Cosmos REST:     http://localhost:45112"
echo "   EVM JSON-RPC:    http://localhost:45118"
echo ""
echo "📍 Other Validators:"
echo "   tac-node-1:      RPC=:45121  REST=:45122  EVM=:45128"
echo "   tac-node-2:      RPC=:45131  REST=:45132  EVM=:45138"
echo "   tac-node-3:      RPC=:45141  REST=:45142  EVM=:45148"
echo ""

echo "To stop: ./stop-multinode.sh"
echo ""
