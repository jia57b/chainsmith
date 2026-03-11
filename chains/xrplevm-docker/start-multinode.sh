#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d ".testnet/node0" ]; then
    echo "❌ .testnet not found. Run ./init-multinode.sh first."
    exit 1
fi

echo "🚀 Starting XRPLEVM multi-validator localnet..."
docker compose up -d

# Wait for RPC to be ready and blocks to be produced
echo ""
echo "⏳ Waiting for network to produce blocks..."
RPC_URL="http://localhost:26651"
MAX_WAIT=120
WAITED=0
HEIGHT="0"

while [ $WAITED -lt $MAX_WAIT ]; do
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
    echo "   ⚠️  Timeout waiting for blocks."
    exit 1
fi

VALIDATOR_COUNT=$(curl -s "${RPC_URL}/validators" 2>/dev/null | \
  grep -o '"total":"[0-9]*"' | \
  grep -o '[0-9]*' | head -1 || echo "unknown")

EVM_OK=$(curl -s -X POST http://localhost:8541 \
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
echo "✅ XRPLEVM multi-validator localnet started!"
echo ""
echo "📊 Network Status:"
echo "   Block Height:    ${HEIGHT}"
echo "   Validators:      ${VALIDATOR_COUNT}"
echo "   EVM JSON-RPC:    ${EVM_STATUS}"
echo ""
echo "📍 Validator 1 (xrplevm-node-0):"
echo "   CometBFT RPC:    http://localhost:26651"
echo "   Cosmos REST:     http://localhost:1311"
echo "   EVM JSON-RPC:    http://localhost:8541"
echo ""
echo "📍 Other Validators:"
echo "   node-1: RPC=:26652  REST=:1312  EVM=:8542"
echo "   node-2: RPC=:26653  REST=:1313  EVM=:8543"
echo "   node-3: RPC=:26654  REST=:1314  EVM=:8544"
echo ""
echo "To stop: ./stop-multinode.sh"
echo ""
