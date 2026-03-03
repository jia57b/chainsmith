#!/bin/bash
# init-multinode.sh — Init 4-node localnet (0G v2 BeaconKit architecture)
#
# How it works:
#   1. Use 0gchaind init to generate BLS12-381 key pairs for each node
#   2. Use 0gchaind genesis add-premined-deposit to create signed deposits for each node
#   3. Collect all deposits to node1, run collect-premined-deposits to generate final genesis
#   4. Use genesis execution-payload to embed Geth genesis into final genesis
#   5. Distribute final genesis to all nodes
#   6. Initialize Geth data directory for each node
#
# Prerequisites:
#   Pull amd64 images: DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose --profile node pull
#
# Usage:
#   chmod +x init-multinode.sh
#   ./init-multinode.sh

set -e

IMAGE="ghcr.io/emberstake/0g-docker/node:${NODE_TAG:-v2.0.4}"
GETH_IMAGE="ghcr.io/emberstake/0g-docker/geth:${NODE_TAG:-v2.0.4}"
PLATFORM="linux/amd64"
CHAIN_SPEC="devnet"

# Deposit parameters
DEPOSIT_AMOUNT=32000000000  # 32 OG tokens (gwei)
WITHDRAWAL_ADDR="0x63df5c411aa90b9866e7e6082230ffbf61aeda8c"  # devnet withdrawal address

NUM_VALIDATORS=4

echo "============================================"
echo "  0G Multi-Validator Localnet Init"
echo "  Architecture: BeaconKit + CometBFT + Geth"
echo "  Number of validators: ${NUM_VALIDATORS}"
echo "============================================"
echo ""

# ----------------------------------------------------------
# Step 1: Cleaning old volumes
# ----------------------------------------------------------
echo "🧹 Step 1/8: Cleaning old volumes..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker volume rm -f validator${i}_node_config 2>/dev/null || true
  docker volume rm -f validator${i}_node_data 2>/dev/null || true
  docker volume rm -f validator${i}_geth_data 2>/dev/null || true
done
echo "   ✅ Clea  ned"
echo ""

# ----------------------------------------------------------
# Step 2: Initialize each validator node (generate BLS12-381 key pairs)
# ----------------------------------------------------------
echo "🔑 Step 2/8: Initializing nodes and generating BLS keys..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker run --rm --platform $PLATFORM --entrypoint sh \
    -v validator${i}_node_config:/home/zerog/.0gchain/config \
    -v validator${i}_node_data:/home/zerog/.0gchain/data \
    "$IMAGE" -c "
      0gchaind init validator${i} -o --chaincfg.chain-spec ${CHAIN_SPEC} --home /home/zerog/.0gchain 2>/dev/null
    "
  echo "   ✅ Validator $i: BLS key generated"
done
echo ""

# ----------------------------------------------------------
# Step 3: Create signed deposit for each node
# ----------------------------------------------------------
echo "📝 Step 3/8: Creating premined deposits..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker run --rm --platform $PLATFORM --entrypoint sh \
    -v validator${i}_node_config:/home/zerog/.0gchain/config \
    -v validator${i}_node_data:/home/zerog/.0gchain/data \
    "$IMAGE" -c "
      0gchaind genesis add-premined-deposit ${DEPOSIT_AMOUNT} ${WITHDRAWAL_ADDR} \
        --chaincfg.chain-spec ${CHAIN_SPEC} --home /home/zerog/.0gchain 2>/dev/null
    "
  echo "   ✅ Validator $i: deposit created"
done
echo ""

# ----------------------------------------------------------
# Step 4: Collect all deposits to node1 and generate final genesis
# ----------------------------------------------------------
echo "📦 Step 4/8: Collecting deposits and generating final genesis..."

# Copy validator2/3/4 deposit files to validator1
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm --platform $PLATFORM \
    -v validator${i}_node_config:/src:ro \
    -v validator1_node_config:/dst \
    alpine sh -c "cp /src/premined-deposits/* /dst/premined-deposits/" 2>/dev/null
  echo "   ✅ Validator $i deposit → Validator 1"
done

# Collect all deposits on validator1
docker run --rm --platform $PLATFORM --entrypoint sh \
  -v validator1_node_config:/home/zerog/.0gchain/config \
  -v validator1_node_data:/home/zerog/.0gchain/data \
  "$IMAGE" -c "
    0gchaind genesis collect-premined-deposits \
      --chaincfg.chain-spec ${CHAIN_SPEC} --home /home/zerog/.0gchain 2>/dev/null
  "

# Verify deposit count
DEPOSIT_COUNT=$(docker run --rm --platform $PLATFORM --entrypoint sh \
  -v validator1_node_config:/home/zerog/.0gchain/config \
  "$IMAGE" -c "
    cat /home/zerog/.0gchain/config/genesis.json | jq '.app_state.beacon.deposits | length'
  " 2>/dev/null)

echo "   ✅ Genesis contains ${DEPOSIT_COUNT} validator deposits"
echo ""

# ----------------------------------------------------------
# Step 5: Embed Geth genesis into final genesis (execution-payload)
# ----------------------------------------------------------
echo "⛓️  Step 5/8: Embedding Geth genesis..."

# Get genesis.json from geth image
docker run --rm --platform $PLATFORM --entrypoint sh \
  -v validator1_node_config:/home/zerog/.0gchain/config \
  -v validator1_node_data:/home/zerog/.0gchain/data \
  "$GETH_IMAGE" -c "cp /home/zerog/genesis.json /home/zerog/.0gchain/config/eth-genesis.json" 2>/dev/null

# Inject test wallet into Geth genesis (Hardhat Account #0)
# Address:    0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
echo "   💰 Injecting test wallet (Hardhat Account #0)..."
docker run --rm --platform $PLATFORM \
  -v validator1_node_config:/config \
  alpine sh -c "
    apk add --no-cache jq >/dev/null 2>&1
    cat /config/eth-genesis.json | jq '.alloc += {
      \"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\": {
        \"balance\": \"0x033b2e3c9fd0803ce8000000\"
      }
    }' > /config/eth-genesis-patched.json
    mv /config/eth-genesis-patched.json /config/eth-genesis.json
  " 2>/dev/null
echo "   ✅ Test wallet injected"

docker run --rm --platform $PLATFORM --entrypoint sh \
  -v validator1_node_config:/home/zerog/.0gchain/config \
  -v validator1_node_data:/home/zerog/.0gchain/data \
  "$IMAGE" -c "
    0gchaind genesis execution-payload /home/zerog/.0gchain/config/eth-genesis.json \
      --chaincfg.chain-spec ${CHAIN_SPEC} --home /home/zerog/.0gchain 2>&1 || echo '   ⚠️ execution-payload optional step, skipped'
  "
echo "   ✅ Execution payload processed"
echo ""

# ----------------------------------------------------------
# Step 6: Distribute final genesis to all validators
# ----------------------------------------------------------
echo "📤 Step 6/8: Distributing genesis.json to all nodes..."

for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm --platform $PLATFORM \
    -v validator1_node_config:/src:ro \
    -v validator${i}_node_config:/dst \
    alpine sh -c "cp /src/genesis.json /dst/genesis.json" 2>/dev/null
  echo "   ✅ Genesis → Validator $i"
done
echo ""

# ----------------------------------------------------------
# Step 7: Initialize Geth and configure P2P interconnections
# ----------------------------------------------------------
echo "🔧 Step 7/8: Initializing Geth and configuring P2P interconnections..."

# Geth P2P port mapping (consistent with docker-compose.multinode.yml)
GETH_PORTS=(0 30303 30304 30305 30306)

# Initialize Geth (using patched eth-genesis.json instead of image's built-in genesis.json)
for i in $(seq 1 $NUM_VALIDATORS); do
  docker run --rm --platform $PLATFORM --entrypoint sh \
    -v validator1_node_config:/config:ro \
    -v validator${i}_geth_data:/home/zerog/geth_home \
    "$GETH_IMAGE" -c "
      geth init --datadir /home/zerog/geth_home /config/eth-genesis.json 2>/dev/null
    "
  echo "   ✅ Validator $i: Geth initialized"
done

# Extract Geth nodekey and calculate enode URL
echo ""
echo "   Configuring Geth static nodes (static-nodes.json)..."

ENODE_URLS=()
for i in $(seq 1 $NUM_VALIDATORS); do
  # Extract nodekey (private key) from Geth datadir
  NODEKEY=$(docker run --rm --platform $PLATFORM --entrypoint sh \
    -v validator${i}_geth_data:/home/zerog/geth_home:ro \
    "$GETH_IMAGE" -c "cat /home/zerog/geth_home/geth/nodekey" 2>/dev/null)

  # Use Node.js to calculate enode public key from private key (secp256k1 uncompressed, remove 04 prefix)
  PUBKEY=$(node -e "
    const ecdh = require('crypto').createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from('${NODEKEY}', 'hex'));
    console.log(ecdh.getPublicKey('hex', 'uncompressed').slice(2));
  " 2>/dev/null)

  ENODE="enode://${PUBKEY}@validator${i}-geth:${GETH_PORTS[$i]}"
  ENODE_URLS+=("$ENODE")
  echo "   Validator $i enode: ${PUBKEY:0:20}...@validator${i}-geth:${GETH_PORTS[$i]}"
done

# Build static-nodes.json and inject into each Geth datadir
STATIC_NODES="["
for idx in "${!ENODE_URLS[@]}"; do
  if [ $idx -gt 0 ]; then
    STATIC_NODES="${STATIC_NODES},"
  fi
  STATIC_NODES="${STATIC_NODES}\"${ENODE_URLS[$idx]}\""
done
STATIC_NODES="${STATIC_NODES}]"

for i in $(seq 1 $NUM_VALIDATORS); do
  docker run --rm --platform $PLATFORM --entrypoint sh \
    -v validator${i}_geth_data:/home/zerog/geth_home \
    "$GETH_IMAGE" -c "
      echo '${STATIC_NODES}' > /home/zerog/geth_home/geth/static-nodes.json
    "
done
echo "   ✅ static-nodes.json written to all Geth nodes"

echo ""

# ----------------------------------------------------------
# Step 8: Get CometBFT Node IDs
# ----------------------------------------------------------
echo "🔧 Step 8/8: Getting CometBFT Node IDs..."

# Get Node IDs
PEERS=""
for i in $(seq 1 $NUM_VALIDATORS); do
  NODE_ID=$(docker run --rm --platform $PLATFORM --entrypoint sh \
    -v validator${i}_node_config:/home/zerog/.0gchain/config \
    -v validator${i}_node_data:/home/zerog/.0gchain/data \
    "$IMAGE" -c "
      0gchaind comet show-node-id --home /home/zerog/.0gchain 2>/dev/null || \
      cat /home/zerog/.0gchain/config/node_key.json | jq -r '.id' 2>/dev/null
    " 2>/dev/null | tail -1)

  PEER="${NODE_ID}@validator${i}-node:26656"
  echo "   Validator $i: ${PEER}"

  if [ -z "$PEERS" ]; then
    PEERS="$PEER"
  else
    PEERS="${PEERS},${PEER}"
  fi
done

echo ""

# ----------------------------------------------------------
# Step 9: Auto-update PERSISTENT_PEERS in .env
# ----------------------------------------------------------
echo "📝 Step 9/9: Updating PERSISTENT_PEERS in .env..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# copy .env.sample to .env
cp "${SCRIPT_DIR}/.env.sample" "${SCRIPT_DIR}/.env"
ENV_FILE="${SCRIPT_DIR}/.env"

if [ -f "$ENV_FILE" ]; then
  if grep -q "^PERSISTENT_PEERS=" "$ENV_FILE"; then
    sed -i.bak "s|^PERSISTENT_PEERS=.*|PERSISTENT_PEERS=\"${PEERS}\"|" "$ENV_FILE"
    rm -f "${ENV_FILE}.bak"
    echo "   ✅ Updated PERSISTENT_PEERS in .env"
  else
    echo "PERSISTENT_PEERS=\"${PEERS}\"" >> "$ENV_FILE"
    echo "   ✅ Appended PERSISTENT_PEERS to .env"
  fi
else
  echo "   ⚠️  .env file does not exist, please create it manually and set:"
  echo "   PERSISTENT_PEERS=${PEERS}"
fi

echo ""
echo "============================================"
echo "  ✅ Initialization complete! ${NUM_VALIDATORS} validators configured"
echo "============================================"
echo ""
echo "📋 Validator BLS Public Keys:"
for i in $(seq 1 $NUM_VALIDATORS); do
  PUBKEY=$(docker run --rm --platform $PLATFORM --entrypoint sh \
    -v validator${i}_node_config:/home/zerog/.0gchain/config \
    "$IMAGE" -c "
      cat /home/zerog/.0gchain/config/priv_validator_key.json | jq -r '.pub_key.value' 2>/dev/null
    " 2>/dev/null | tail -1)
  echo "   Validator $i: ${PUBKEY:0:40}..."
done
echo ""
echo "📋 Persistent Peers:"
echo "   PERSISTENT_PEERS=${PEERS}"
echo ""
echo "📋 Next steps:"
echo "  1. Start multi-node network: docker compose -f docker-compose.multinode.yml up -d"
echo "  2. Check status: docker compose -f docker-compose.multinode.yml ps"
echo "  3. Verify block production: curl -s localhost:26657/status | jq .result.sync_info.latest_block_height"
echo "  4. Verify validator count: curl -s localhost:26657/validators | jq '.result.validators | length'"
echo ""
