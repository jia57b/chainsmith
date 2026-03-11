#!/bin/bash
# init-multinode.sh — Initialize 4-validator Kii localnet
#
# Architecture: CometBFT-based EVM-compatible chain (Ethermint/Cosmos SDK)
# Each validator = 1 container (consensus + EVM in same process)
# Binary: kiichaind | Home: /root/.kiichain | Denom: akii (18 decimals)
#
# How it works:
#   1. Clean old Docker volumes
#   2. Initialize each validator node (generate keys and config)
#   3. Create operator keys for each validator
#   4. Import founder (test wallet) key on node1
#   5. Add all accounts to genesis on node1
#   6. Patch genesis denominations and EVM config
#   7. Distribute genesis to all nodes for gentx signing
#   8. Create gentx for each validator
#   9. Collect all gentxs on node1 to produce final genesis
#  10. Configure node settings (RPC, EVM, fast blocks)
#  11. Distribute final genesis to all nodes
#  12. Get CometBFT Node IDs and write PERSISTENT_PEERS
#
# Usage:
#   chmod +x init-multinode.sh
#   ./init-multinode.sh

set -e

IMAGE="kiichain/kiichaind:${KII_TAG:-latest}"
CHAIN_ID="kiilocal_1010-1"
KII_HOME="/root/.kiichain"
DENOM="akii"

# Amounts (akii = atto-kii, 18 decimal places)
VALIDATOR_BALANCE="1000000000000000000000000${DENOM}"    # 1,000,000 KII per validator
VALIDATOR_STAKE="100000000000000000000000${DENOM}"       # 100,000 KII staked per validator
FOUNDER_BALANCE="10000000000000000000000000${DENOM}"     # 10,000,000 KII for test wallet

# Hardhat Account #0 private key — injected from environment variable TEST_WALLET_PRIVATE_KEY
if [ -z "$TEST_WALLET_PRIVATE_KEY" ]; then
  echo "❌ Error: TEST_WALLET_PRIVATE_KEY environment variable is not set."
  echo "   Please set it before running this script (e.g., export TEST_WALLET_PRIVATE_KEY=0x...)"
  exit 1
fi
# Strip 0x prefix if present
FOUNDER_ETH_PRIVKEY="${TEST_WALLET_PRIVATE_KEY#0x}"

NUM_VALIDATORS=4
TOTAL_STEPS=12

# Helper: run kiichaind command in a Docker container
# The official Dockerfile sets USER nonroot and ENTRYPOINT ["kiichaind", "start"],
# so we override with --user root --entrypoint kiichaind for init operations.
run_kii() {
  local vol="$1"
  shift
  docker run --rm --user root --entrypoint kiichaind \
    -v "${vol}:${KII_HOME}" "$IMAGE" "$@" --home "${KII_HOME}"
}

run_kii_quiet() {
  local vol="$1"
  shift
  docker run --rm --user root --entrypoint kiichaind \
    -v "${vol}:${KII_HOME}" "$IMAGE" "$@" --home "${KII_HOME}" >/dev/null 2>&1
}

run_genesis_cmd() {
  local vol="$1"
  shift
  docker run --rm --user root --entrypoint kiichaind \
    -v "${vol}:${KII_HOME}" "$IMAGE" genesis "$@" --home "${KII_HOME}" >/dev/null 2>&1
}

echo "============================================"
echo "  Kii Multi-Validator Localnet Init"
echo "  Architecture: CometBFT + Integrated EVM"
echo "  Validators: ${NUM_VALIDATORS}"
echo "  Image: ${IMAGE}"
echo "  Chain ID: ${CHAIN_ID}"
echo "============================================"
echo ""

# Pre-flight: ensure Docker image exists locally (build from source if missing)
KII_REPO="https://github.com/KiiChain/kiichain.git"
KII_BRANCH="${KII_BRANCH:-v7.0.1}"
KII_BUILD_DIR="/tmp/kiichain-src"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "📥 Docker image '${IMAGE}' not found locally. Building from source..."
  echo "   Repository: ${KII_REPO} (branch: ${KII_BRANCH})"
  rm -rf "$KII_BUILD_DIR"
  if ! git clone --depth 1 --branch "$KII_BRANCH" "$KII_REPO" "$KII_BUILD_DIR"; then
    echo "❌ Error: Failed to clone KiiChain repository."
    echo "   Please check your network connection and that branch '${KII_BRANCH}' exists."
    exit 1
  fi
  if ! docker build -t "$IMAGE" "$KII_BUILD_DIR"; then
    echo "❌ Error: Failed to build Docker image '${IMAGE}'."
    echo "   Check the build output above for details."
    rm -rf "$KII_BUILD_DIR"
    exit 1
  fi
  rm -rf "$KII_BUILD_DIR"
  echo "   ✅ Image '${IMAGE}' built successfully"
  echo ""
fi

# ----------------------------------------------------------
# Step 1: Clean old volumes
# ----------------------------------------------------------
echo "🧹 Step 1/${TOTAL_STEPS}: Cleaning old volumes..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker volume rm -f kii_validator${i}_home 2>/dev/null || true
done
echo "   ✅ Cleaned"
echo ""

# ----------------------------------------------------------
# Step 2: Initialize each validator node
# ----------------------------------------------------------
echo "🔑 Step 2/${TOTAL_STEPS}: Initializing nodes..."
for i in $(seq 1 $NUM_VALIDATORS); do
  run_kii_quiet "kii_validator${i}_home" init validator${i} --chain-id ${CHAIN_ID}
  echo "   ✅ Validator $i: initialized"
done
echo ""

# ----------------------------------------------------------
# Step 3: Create operator keys for each validator
# ----------------------------------------------------------
echo "🔐 Step 3/${TOTAL_STEPS}: Creating operator keys..."
declare -a VALIDATOR_ADDRS
for i in $(seq 1 $NUM_VALIDATORS); do
  # Create key
  docker run --rm --user root --entrypoint kiichaind \
    -v kii_validator${i}_home:${KII_HOME} \
    "$IMAGE" keys add validator${i} \
      --keyring-backend test --home ${KII_HOME} 2>/dev/null || true

  # Query address separately
  ADDR=$(docker run --rm --user root --entrypoint kiichaind \
    -v kii_validator${i}_home:${KII_HOME} \
    "$IMAGE" keys show validator${i} \
      --keyring-backend test --home ${KII_HOME} -a 2>/dev/null | tr -d '\n\r')
  VALIDATOR_ADDRS+=("$ADDR")
  echo "   ✅ Validator $i: ${ADDR}"
done
echo ""

# ----------------------------------------------------------
# Step 4: Import founder (test wallet) key on node1
# ----------------------------------------------------------
echo "💰 Step 4/${TOTAL_STEPS}: Importing founder test wallet (Hardhat Account #0)..."
echo -e "password123\npassword123" | docker run -i --rm --user root --entrypoint kiichaind \
  -v kii_validator1_home:${KII_HOME} \
  "$IMAGE" keys unsafe-import-eth-key founder ${FOUNDER_ETH_PRIVKEY} \
    --keyring-backend test --home ${KII_HOME} >/dev/null 2>&1 || true

FOUNDER_ADDR=$(docker run --rm --user root --entrypoint kiichaind \
  -v kii_validator1_home:${KII_HOME} \
  "$IMAGE" keys show founder \
    --keyring-backend test --home ${KII_HOME} -a 2>/dev/null | tr -d '\n\r')

echo "   ✅ Founder Cosmos address: ${FOUNDER_ADDR}"
echo "   ✅ Founder EVM address:    0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo ""

# ----------------------------------------------------------
# Step 5: Add genesis accounts on node1
# ----------------------------------------------------------
echo "📝 Step 5/${TOTAL_STEPS}: Adding genesis accounts..."

# Add founder account
run_genesis_cmd "kii_validator1_home" add-genesis-account "${FOUNDER_ADDR}" "${FOUNDER_BALANCE}" --keyring-backend test
echo "   ✅ Founder account added"

# Add each validator's account
for i in $(seq 1 $NUM_VALIDATORS); do
  idx=$((i-1))
  ADDR="${VALIDATOR_ADDRS[$idx]}"
  if [ $i -eq 1 ]; then
    run_genesis_cmd "kii_validator1_home" add-genesis-account validator1 "${VALIDATOR_BALANCE}" --keyring-backend test
  else
    run_genesis_cmd "kii_validator1_home" add-genesis-account "${ADDR}" "${VALIDATOR_BALANCE}" --keyring-backend test
  fi
  echo "   ✅ Validator $i account added"
done
echo ""

# ----------------------------------------------------------
# Step 6: Patch genesis denominations and EVM config
# ----------------------------------------------------------
echo "🔄 Step 6/${TOTAL_STEPS}: Patching genesis.json..."
docker run --rm --user root \
  -v kii_validator1_home:/home/kii \
  alpine sh -c '
    apk add --no-cache jq >/dev/null 2>&1
    GENESIS=/home/kii/config/genesis.json

    # Patch denominations across all modules
    jq ".app_state.staking.params.bond_denom = \"akii\" |
        .app_state.crisis.constant_fee.denom = \"akii\" |
        .app_state.gov.deposit_params.min_deposit[0].denom = \"akii\" |
        .app_state.gov.params.min_deposit[0].denom = \"akii\" |
        .app_state.mint.params.mint_denom = \"akii\" |
        .app_state.evm.params.evm_denom = \"akii\" |
        .consensus_params.block.max_gas = \"30000000\"" $GENESIS > $GENESIS.tmp && \
    mv $GENESIS.tmp $GENESIS

    # Register akii denom metadata in bank module (required by EVM module)
    jq ".app_state.bank.denom_metadata = [{
      \"description\": \"The native staking and governance token of Kii\",
      \"denom_units\": [
        {\"denom\": \"akii\", \"exponent\": 0, \"aliases\": [\"attokii\"]},
        {\"denom\": \"nkii\", \"exponent\": 9, \"aliases\": [\"nanokii\"]},
        {\"denom\": \"kii\",  \"exponent\": 18}
      ],
      \"base\": \"akii\",
      \"display\": \"kii\",
      \"name\": \"Kii\",
      \"symbol\": \"KII\"
    }]" $GENESIS > $GENESIS.tmp && \
    mv $GENESIS.tmp $GENESIS

    # Activate EVM precompiles (staking, distribution, bech32, bank, ICS20, governance)
    jq ".app_state.evm.params.active_static_precompiles = [
      \"0x0000000000000000000000000000000000000400\",
      \"0x0000000000000000000000000000000000000800\",
      \"0x0000000000000000000000000000000000000801\",
      \"0x0000000000000000000000000000000000000802\",
      \"0x0000000000000000000000000000000000000804\",
      \"0x0000000000000000000000000000000000000805\"
    ]" $GENESIS > $GENESIS.tmp && \
    mv $GENESIS.tmp $GENESIS
  ' 2>/dev/null
echo "   ✅ Genesis patched (denom: akii, EVM denom: akii, bank metadata, precompiles activated)"
echo ""

# ----------------------------------------------------------
# Step 7: Distribute genesis (with accounts) to all nodes
# ----------------------------------------------------------
echo "📤 Step 7/${TOTAL_STEPS}: Distributing genesis with accounts..."
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm --user root \
    -v kii_validator1_home:/src:ro \
    -v kii_validator${i}_home:/dst \
    alpine sh -c "cp /src/config/genesis.json /dst/config/genesis.json" 2>/dev/null
  echo "   ✅ Genesis → Validator $i"
done
echo ""

# ----------------------------------------------------------
# Step 8: Create gentx for each validator
# ----------------------------------------------------------
echo "📝 Step 8/${TOTAL_STEPS}: Creating gentx for each validator..."
for i in $(seq 1 $NUM_VALIDATORS); do
  run_genesis_cmd "kii_validator${i}_home" gentx validator${i} ${VALIDATOR_STAKE} \
    --chain-id ${CHAIN_ID} --keyring-backend test
  echo "   ✅ Validator $i: gentx created"
done
echo ""

# ----------------------------------------------------------
# Step 9: Collect gentxs on node1
# ----------------------------------------------------------
echo "📦 Step 9/${TOTAL_STEPS}: Collecting gentxs on node1..."

for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm --user root \
    -v kii_validator${i}_home:/src:ro \
    -v kii_validator1_home:/dst \
    alpine sh -c "cp /src/config/gentx/* /dst/config/gentx/" 2>/dev/null
  echo "   ✅ Validator $i gentx → node1"
done

run_genesis_cmd "kii_validator1_home" collect-gentxs

GENTX_COUNT=$(docker run --rm --user root \
  -v kii_validator1_home:/home/kii \
  alpine sh -c "
    apk add --no-cache jq >/dev/null 2>&1
    cat /home/kii/config/genesis.json | jq '.app_state.genutil.gen_txs | length'
  " 2>/dev/null || echo "unknown")
echo "   ✅ Genesis contains ${GENTX_COUNT} validator gentxs"
echo ""

# ----------------------------------------------------------
# Step 10: Configure node settings
# ----------------------------------------------------------
echo "⚙️  Step 10/${TOTAL_STEPS}: Configuring node settings..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker run --rm --user root \
    -v kii_validator${i}_home:/home/kii \
    alpine sh -c '
      CONFIG=/home/kii/config/config.toml
      APP=/home/kii/config/app.toml

      # === CometBFT config.toml ===
      sed -i "s|laddr = \"tcp://127.0.0.1:26657\"|laddr = \"tcp://0.0.0.0:26657\"|" $CONFIG
      sed -i "s|timeout_commit = \"5s\"|timeout_commit = \"2s\"|" $CONFIG
      sed -i "s|timeout_propose = \"3s\"|timeout_propose = \"2s\"|" $CONFIG
      sed -i "s|cors_allowed_origins = \[\]|cors_allowed_origins = [\"*\"]|" $CONFIG

      # === Cosmos app.toml ===
      sed -i "/\[api\]/,/\[/{s|enable = false|enable = true|}" $APP
      sed -i "s|address = \"tcp://localhost:1317\"|address = \"tcp://0.0.0.0:1317\"|" $APP
      sed -i "s|address = \"tcp://127.0.0.1:1317\"|address = \"tcp://0.0.0.0:1317\"|" $APP
      sed -i "s|enabled-unsafe-cors = false|enabled-unsafe-cors = true|" $APP

      sed -i "s|address = \"localhost:9090\"|address = \"0.0.0.0:9090\"|" $APP
      sed -i "s|address = \"127.0.0.1:9090\"|address = \"0.0.0.0:9090\"|" $APP

      sed -i "/\[json-rpc\]/,/\[/{s|enable = false|enable = true|}" $APP
      sed -i "s|address = \"127.0.0.1:8545\"|address = \"0.0.0.0:8545\"|" $APP
      sed -i "s|address = \"localhost:8545\"|address = \"0.0.0.0:8545\"|" $APP
      sed -i "s|ws-address = \"127.0.0.1:8546\"|ws-address = \"0.0.0.0:8546\"|" $APP
      sed -i "s|ws-address = \"localhost:8546\"|ws-address = \"0.0.0.0:8546\"|" $APP

      sed -i "s|minimum-gas-prices = \"\"|minimum-gas-prices = \"1000000000akii\"|" $APP
    ' 2>/dev/null
  echo "   ✅ Validator $i: configured"
done
echo ""

# ----------------------------------------------------------
# Step 11: Distribute final genesis to all nodes
# ----------------------------------------------------------
echo "📤 Step 11/${TOTAL_STEPS}: Distributing final genesis.json..."
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm --user root \
    -v kii_validator1_home:/src:ro \
    -v kii_validator${i}_home:/dst \
    alpine sh -c "cp /src/config/genesis.json /dst/config/genesis.json" 2>/dev/null
  echo "   ✅ Genesis → Validator $i"
done
echo ""

# ----------------------------------------------------------
# Step 12: Get CometBFT Node IDs and write PERSISTENT_PEERS
# ----------------------------------------------------------
echo "🔗 Step 12/${TOTAL_STEPS}: Getting CometBFT Node IDs..."

PEERS=""
for i in $(seq 1 $NUM_VALIDATORS); do
  NODE_ID=$(docker run --rm --user root --entrypoint kiichaind \
    -v kii_validator${i}_home:${KII_HOME} \
    "$IMAGE" comet show-node-id --home ${KII_HOME} 2>/dev/null || \
  docker run --rm --user root --entrypoint kiichaind \
    -v kii_validator${i}_home:${KII_HOME} \
    "$IMAGE" tendermint show-node-id --home ${KII_HOME} 2>/dev/null)
  NODE_ID=$(echo "$NODE_ID" | tr -d '\n\r')

  PEER="${NODE_ID}@kii-validator${i}:26656"
  echo "   Validator $i: ${PEER}"

  if [ -z "$PEERS" ]; then
    PEERS="$PEER"
  else
    PEERS="${PEERS},${PEER}"
  fi
done

echo ""

# Write to .env.multinode
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/.env.multinode.sample" "${SCRIPT_DIR}/.env.multinode" 2>/dev/null || true
ENV_FILE="${SCRIPT_DIR}/.env.multinode"

if [ -f "$ENV_FILE" ] && grep -q "^PERSISTENT_PEERS=" "$ENV_FILE"; then
  sed -i.bak "s|^PERSISTENT_PEERS=.*|PERSISTENT_PEERS=${PEERS}|" "$ENV_FILE"
  rm -f "${ENV_FILE}.bak"
else
  echo "PERSISTENT_PEERS=${PEERS}" >> "$ENV_FILE"
fi
echo "   ✅ Updated PERSISTENT_PEERS in .env.multinode"

echo ""
echo "============================================"
echo "  ✅ Initialization complete!"
echo "  ${NUM_VALIDATORS} validators configured"
echo "============================================"
echo ""
echo "📋 Validator Addresses:"
for i in $(seq 1 $NUM_VALIDATORS); do
  idx=$((i-1))
  echo "   Validator $i: ${VALIDATOR_ADDRS[$idx]}"
done
echo ""
echo "📋 Founder Wallet (Hardhat Account #0):"
echo "   Cosmos:      ${FOUNDER_ADDR}"
echo "   EVM:         0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo ""
echo "📋 Persistent Peers:"
echo "   ${PEERS}"
echo ""
echo "📋 Next steps:"
echo "  1. Start network: ./start-multinode.sh"
echo "  2. Check status:  docker compose --env-file .env.multinode -f docker-compose.yml ps"
echo "  3. Stop network:  ./stop-multinode.sh"
echo ""
