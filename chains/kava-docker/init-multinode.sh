#!/bin/bash
# init-multinode.sh — Initialize 4-validator Kava localnet
#
# Architecture: Standard Cosmos SDK (single kava binary with integrated EVM)
# Each validator = 1 container (consensus + EVM in same process)
#
# How it works:
#   1. Clean old Docker volumes
#   2. Initialize each validator node (generate keys and config)
#   3. Create operator keys for each validator
#   4. Import founder (test wallet) key on node1
#   5. Add all accounts to genesis on node1
#   6. Distribute genesis to all nodes for gentx signing
#   7. Create gentx for each validator
#   8. Collect all gentxs on node1 to produce final genesis
#   9. Configure node settings (RPC, EVM, fast blocks)
#  10. Distribute final genesis to all nodes
#  11. Get CometBFT Node IDs and write PERSISTENT_PEERS
#
# Usage:
#   chmod +x init-multinode.sh
#   ./init-multinode.sh

set -e

IMAGE="kava/kava:${KAVA_TAG:-v0.28.2-goleveldb}"
CHAIN_ID="kava_2222-1"
KAVA_HOME="/root/.kava"
DENOM="ukava"

# Amounts
VALIDATOR_BALANCE="1000000000000${DENOM}"    # 1,000,000 KAVA per validator
VALIDATOR_STAKE="100000000000${DENOM}"       # 100,000 KAVA staked per validator
FOUNDER_BALANCE="10000000000000${DENOM}"     # 10,000,000 KAVA for test wallet

# Hardhat Account #0 private key (consistent with 0g-docker and story-docker)
FOUNDER_ETH_PRIVKEY="ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

NUM_VALIDATORS=4
TOTAL_STEPS=11

# Helper: run kava command with fallback (Cosmos SDK v0.47+ uses 'genesis' subcommand)
run_genesis_cmd() {
  local vol="$1"
  shift
  # Try with 'genesis' subcommand first (v0.47+), then without
  docker run --rm -v "${vol}:${KAVA_HOME}" "$IMAGE" kava genesis "$@" --home "${KAVA_HOME}" >/dev/null 2>&1 || \
  docker run --rm -v "${vol}:${KAVA_HOME}" "$IMAGE" kava "$@" --home "${KAVA_HOME}" >/dev/null 2>&1
}

echo "============================================"
echo "  Kava Multi-Validator Localnet Init"
echo "  Architecture: Cosmos SDK + Integrated EVM"
echo "  Validators: ${NUM_VALIDATORS}"
echo "  Image: ${IMAGE}"
echo "  Chain ID: ${CHAIN_ID}"
echo "============================================"
echo ""

# ----------------------------------------------------------
# Step 1: Clean old volumes
# ----------------------------------------------------------
echo "🧹 Step 1/${TOTAL_STEPS}: Cleaning old volumes..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker volume rm -f kava_validator${i}_home 2>/dev/null || true
done
echo "   ✅ Cleaned"
echo ""

# ----------------------------------------------------------
# Step 2: Initialize each validator node
# ----------------------------------------------------------
echo "🔑 Step 2/${TOTAL_STEPS}: Initializing nodes..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker run --rm \
    -v kava_validator${i}_home:${KAVA_HOME} \
    "$IMAGE" kava init validator${i} --chain-id ${CHAIN_ID} --home ${KAVA_HOME} >/dev/null 2>&1
  echo "   ✅ Validator $i: initialized"
done
echo ""

# ----------------------------------------------------------
# Step 3: Create operator keys for each validator
# ----------------------------------------------------------
echo "🔐 Step 3/${TOTAL_STEPS}: Creating operator keys..."
declare -a VALIDATOR_ADDRS
for i in $(seq 1 $NUM_VALIDATORS); do
  # Create key (output goes to stderr in some versions)
  docker run --rm \
    -v kava_validator${i}_home:${KAVA_HOME} \
    "$IMAGE" kava keys add validator${i} \
      --keyring-backend test --home ${KAVA_HOME} 2>/dev/null || true

  # Query address separately (more reliable)
  ADDR=$(docker run --rm \
    -v kava_validator${i}_home:${KAVA_HOME} \
    "$IMAGE" kava keys show validator${i} \
      --keyring-backend test --home ${KAVA_HOME} -a 2>/dev/null | tr -d '\n\r')
  VALIDATOR_ADDRS+=("$ADDR")
  echo "   ✅ Validator $i: ${ADDR}"
done
echo ""

# ----------------------------------------------------------
# Step 4: Import founder (test wallet) key on node1
# ----------------------------------------------------------
echo "💰 Step 4/${TOTAL_STEPS}: Importing founder test wallet (Hardhat Account #0)..."
echo -e "password123\npassword123" | docker run -i --rm \
  -v kava_validator1_home:${KAVA_HOME} \
  "$IMAGE" kava keys unsafe-import-eth-key founder ${FOUNDER_ETH_PRIVKEY} \
    --keyring-backend test --home ${KAVA_HOME} >/dev/null 2>&1 || true

FOUNDER_ADDR=$(docker run --rm \
  -v kava_validator1_home:${KAVA_HOME} \
  "$IMAGE" kava keys show founder \
    --keyring-backend test --home ${KAVA_HOME} -a 2>/dev/null | tr -d '\n\r')

# Also get EVM address
FOUNDER_ETH_ADDR=$(docker run --rm \
  -v kava_validator1_home:${KAVA_HOME} \
  "$IMAGE" kava keys show founder \
    --keyring-backend test --home ${KAVA_HOME} --bech acc 2>/dev/null | grep "address:" | awk '{print $2}' | tr -d '\n\r')

echo "   ✅ Founder Cosmos address: ${FOUNDER_ADDR}"
echo "   ✅ Founder EVM address:    0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo ""

# ----------------------------------------------------------
# Step 5: Add genesis accounts on node1
# ----------------------------------------------------------
echo "📝 Step 5/${TOTAL_STEPS}: Adding genesis accounts..."

# Add founder account
run_genesis_cmd "kava_validator1_home" add-genesis-account "${FOUNDER_ADDR}" "${FOUNDER_BALANCE}" --keyring-backend test
echo "   ✅ Founder account added"

# Add each validator's account (using address, no key needed on node1)
for i in $(seq 1 $NUM_VALIDATORS); do
  idx=$((i-1))
  ADDR="${VALIDATOR_ADDRS[$idx]}"
  if [ $i -eq 1 ]; then
    # Validator1 key exists on node1, can use key name
    run_genesis_cmd "kava_validator1_home" add-genesis-account validator1 "${VALIDATOR_BALANCE}" --keyring-backend test
  else
    # Other validators: use bech32 address directly
    run_genesis_cmd "kava_validator1_home" add-genesis-account "${ADDR}" "${VALIDATOR_BALANCE}" --keyring-backend test
  fi
  echo "   ✅ Validator $i account added"
done
echo ""

# Patch genesis to use ukava for Cosmos modules, akava for EVM
# Note: EvmBankKeeper only supports evm_denom=akava (atto-kava, 18 decimals for EVM compatibility)
echo "🔄 Patching genesis.json denominations..."
docker run --rm \
  -v kava_validator1_home:/home \
  alpine sh -c "
    apk add --no-cache jq >/dev/null 2>&1
    jq '.app_state.staking.params.bond_denom = \"ukava\" |
        .app_state.crisis.constant_fee.denom = \"ukava\" |
        .app_state.gov.deposit_params.min_deposit[0].denom = \"ukava\" |
        .app_state.mint.params.mint_denom = \"ukava\" |
        .app_state.evm.params.evm_denom = \"akava\" |
        .consensus_params.block.max_gas = \"30000000\"' /home/config/genesis.json > /home/config/genesis.json.tmp && \
    mv /home/config/genesis.json.tmp /home/config/genesis.json
  " 2>/dev/null
echo "   ✅ Genesis denominations patched (Cosmos: ukava, EVM: akava)"
echo ""

# ----------------------------------------------------------
# Step 6: Distribute genesis (with accounts) to all nodes
# ----------------------------------------------------------
echo "📤 Step 6/${TOTAL_STEPS}: Distributing genesis with accounts..."
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm \
    -v kava_validator1_home:/src:ro \
    -v kava_validator${i}_home:/dst \
    alpine sh -c "cp /src/config/genesis.json /dst/config/genesis.json" 2>/dev/null
  echo "   ✅ Genesis → Validator $i"
done
echo ""

# ----------------------------------------------------------
# Step 7: Create gentx for each validator
# ----------------------------------------------------------
echo "📝 Step 7/${TOTAL_STEPS}: Creating gentx for each validator..."
for i in $(seq 1 $NUM_VALIDATORS); do
  run_genesis_cmd "kava_validator${i}_home" gentx validator${i} ${VALIDATOR_STAKE} \
    --chain-id ${CHAIN_ID} --keyring-backend test
  echo "   ✅ Validator $i: gentx created"
done
echo ""

# ----------------------------------------------------------
# Step 8: Collect gentxs on node1
# ----------------------------------------------------------
echo "📦 Step 8/${TOTAL_STEPS}: Collecting gentxs on node1..."

# Copy gentx files from validator2/3/4 to validator1
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm \
    -v kava_validator${i}_home:/src:ro \
    -v kava_validator1_home:/dst \
    alpine sh -c "cp /src/config/gentx/* /dst/config/gentx/" 2>/dev/null
  echo "   ✅ Validator $i gentx → node1"
done

# Collect all gentxs
run_genesis_cmd "kava_validator1_home" collect-gentxs

# Verify gentx count
GENTX_COUNT=$(docker run --rm \
  -v kava_validator1_home:/home \
  alpine sh -c "
    apk add --no-cache jq >/dev/null 2>&1
    cat /home/config/genesis.json | jq '.app_state.genutil.gen_txs | length'
  " 2>/dev/null || echo "unknown")
echo "   ✅ Genesis contains ${GENTX_COUNT} validator gentxs"
echo ""

# ----------------------------------------------------------
# Step 9: Configure node settings
# ----------------------------------------------------------
echo "⚙️  Step 9/${TOTAL_STEPS}: Configuring node settings..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker run --rm \
    -v kava_validator${i}_home:/home \
    alpine sh -c '
      CONFIG=/home/config/config.toml
      APP=/home/config/app.toml

      # === CometBFT config.toml ===

      # Listen on all interfaces (required for Docker networking)
      sed -i "s|laddr = \"tcp://127.0.0.1:26657\"|laddr = \"tcp://0.0.0.0:26657\"|" $CONFIG

      # Faster block times for dev environment
      sed -i "s|timeout_commit = \"5s\"|timeout_commit = \"2s\"|" $CONFIG
      sed -i "s|timeout_propose = \"3s\"|timeout_propose = \"2s\"|" $CONFIG

      # Allow CORS for local development
      sed -i "s|cors_allowed_origins = \[\]|cors_allowed_origins = [\"*\"]|" $CONFIG

      # === Cosmos app.toml ===

      # Enable and bind REST API (section: [api])
      sed -i "/\[api\]/,/\[/{s|enable = false|enable = true|}" $APP
      sed -i "s|address = \"tcp://localhost:1317\"|address = \"tcp://0.0.0.0:1317\"|" $APP
      sed -i "s|address = \"tcp://127.0.0.1:1317\"|address = \"tcp://0.0.0.0:1317\"|" $APP
      sed -i "s|enabled-unsafe-cors = false|enabled-unsafe-cors = true|" $APP

      # Enable and bind gRPC
      sed -i "s|address = \"localhost:9090\"|address = \"0.0.0.0:9090\"|" $APP
      sed -i "s|address = \"127.0.0.1:9090\"|address = \"0.0.0.0:9090\"|" $APP

      # Enable and bind EVM JSON-RPC (section: [json-rpc])
      sed -i "/\[json-rpc\]/,/\[/{s|enable = false|enable = true|}" $APP
      sed -i "s|address = \"127.0.0.1:8545\"|address = \"0.0.0.0:8545\"|" $APP
      sed -i "s|address = \"localhost:8545\"|address = \"0.0.0.0:8545\"|" $APP
      sed -i "s|ws-address = \"127.0.0.1:8546\"|ws-address = \"0.0.0.0:8546\"|" $APP
      sed -i "s|ws-address = \"localhost:8546\"|ws-address = \"0.0.0.0:8546\"|" $APP

      # Minimum gas prices
      sed -i "s|minimum-gas-prices = \"\"|minimum-gas-prices = \"0.001ukava\"|" $APP
    ' 2>/dev/null
  echo "   ✅ Validator $i: configured"
done
echo ""

# ----------------------------------------------------------
# Step 10: Distribute final genesis to all nodes
# ----------------------------------------------------------
echo "📤 Step 10/${TOTAL_STEPS}: Distributing final genesis.json..."
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm \
    -v kava_validator1_home:/src:ro \
    -v kava_validator${i}_home:/dst \
    alpine sh -c "cp /src/config/genesis.json /dst/config/genesis.json" 2>/dev/null
  echo "   ✅ Genesis → Validator $i"
done
echo ""

# ----------------------------------------------------------
# Step 11: Get CometBFT Node IDs and write PERSISTENT_PEERS
# ----------------------------------------------------------
echo "🔗 Step 11/${TOTAL_STEPS}: Getting CometBFT Node IDs..."

PEERS=""
for i in $(seq 1 $NUM_VALIDATORS); do
  # Try 'comet show-node-id' first, then 'tendermint show-node-id'
  NODE_ID=$(docker run --rm \
    -v kava_validator${i}_home:${KAVA_HOME} \
    "$IMAGE" kava comet show-node-id --home ${KAVA_HOME} 2>/dev/null || \
  docker run --rm \
    -v kava_validator${i}_home:${KAVA_HOME} \
    "$IMAGE" kava tendermint show-node-id --home ${KAVA_HOME} 2>/dev/null)
  NODE_ID=$(echo "$NODE_ID" | tr -d '\n\r')

  PEER="${NODE_ID}@kava-validator${i}:26656"
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
echo "   Private Key: 0x${FOUNDER_ETH_PRIVKEY}"
echo ""
echo "📋 Persistent Peers:"
echo "   ${PEERS}"
echo ""
echo "📋 Next steps:"
echo "  1. Start network: ./start-multinode.sh"
echo "  2. Check status:  docker compose -f docker-compose.multinode.yml ps"
echo "  3. Stop network:  ./stop-multinode.sh"
echo ""
