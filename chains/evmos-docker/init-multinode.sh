#!/bin/bash
# init-multinode.sh — Initialize 4-validator Evmos localnet
#
# Architecture: Cosmos SDK + CometBFT + integrated EVM (single process)
# Each validator = 1 container (consensus + EVM in the same evmosd process)
#
# Usage:
#   chmod +x init-multinode.sh
#   ./init-multinode.sh

set -e

IMAGE="tharsishq/evmos:${EVMOS_TAG:-v20.0.0}"
CHAIN_ID="evmos_9002-1"
EVMOS_HOME="/root/.evmosd"
DENOM="aevmos"
BASE_FEE="1000000000"

# Amounts (18 decimals)
VALIDATOR_BALANCE="1000000000000000000000000${DENOM}"    # 1,000,000 EVMOS
VALIDATOR_STAKE="100000000000000000000000${DENOM}"       # 100,000 EVMOS
FOUNDER_BALANCE="10000000000000000000000000${DENOM}"     # 10,000,000 EVMOS

if [ -z "$TEST_WALLET_PRIVATE_KEY" ]; then
  echo "❌ Error: TEST_WALLET_PRIVATE_KEY environment variable is not set."
  echo "   Please set it before running this script (e.g., export TEST_WALLET_PRIVATE_KEY=0x...)"
  exit 1
fi

# Strip 0x prefix if present
FOUNDER_ETH_PRIVKEY="${TEST_WALLET_PRIVATE_KEY#0x}"

NUM_VALIDATORS=4
TOTAL_STEPS=11

run_evmos() {
  local vol="$1"
  shift
  docker run --rm --user root --entrypoint evmosd \
    -v "${vol}:${EVMOS_HOME}" "$IMAGE" "$@" --home "${EVMOS_HOME}"
}

run_evmos_quiet() {
  local vol="$1"
  shift
  docker run --rm --user root --entrypoint evmosd \
    -v "${vol}:${EVMOS_HOME}" "$IMAGE" "$@" --home "${EVMOS_HOME}" >/dev/null 2>&1
}

run_genesis_cmd() {
  local vol="$1"
  shift
  docker run --rm --user root --entrypoint evmosd \
    -v "${vol}:${EVMOS_HOME}" "$IMAGE" genesis "$@" --home "${EVMOS_HOME}" >/dev/null 2>&1 || \
  docker run --rm --user root --entrypoint evmosd \
    -v "${vol}:${EVMOS_HOME}" "$IMAGE" "$@" --home "${EVMOS_HOME}" >/dev/null 2>&1
}

echo "============================================"
echo "  Evmos Multi-Validator Localnet Init"
echo "  Architecture: CometBFT + Integrated EVM"
echo "  Validators: ${NUM_VALIDATORS}"
echo "  Image: ${IMAGE}"
echo "  Chain ID: ${CHAIN_ID}"
echo "============================================"
echo ""

# ----------------------------------------------------------
# Step 1: Ensure Docker image
# ----------------------------------------------------------
echo "📦 Step 1/${TOTAL_STEPS}: Ensuring Docker image..."
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "   Image not found locally, pulling ${IMAGE}..."
  docker pull "${IMAGE}" >/dev/null
fi
echo "   ✅ Image ready"
echo ""

# ----------------------------------------------------------
# Step 2: Clean old Docker volumes
# ----------------------------------------------------------
echo "🧹 Step 2/${TOTAL_STEPS}: Cleaning old volumes..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker volume rm -f evmos_validator${i}_home 2>/dev/null || true
done
echo "   ✅ Cleaned"
echo ""

# ----------------------------------------------------------
# Step 3: Initialize validator homes
# ----------------------------------------------------------
echo "🔑 Step 3/${TOTAL_STEPS}: Initializing nodes..."
for i in $(seq 1 $NUM_VALIDATORS); do
  run_evmos_quiet "evmos_validator${i}_home" init validator${i} --chain-id ${CHAIN_ID}
  echo "   ✅ Validator $i: initialized"
done
echo ""

# ----------------------------------------------------------
# Step 4: Create validator keys
# ----------------------------------------------------------
echo "🔐 Step 4/${TOTAL_STEPS}: Creating validator keys..."
declare -a VALIDATOR_ADDRS
for i in $(seq 1 $NUM_VALIDATORS); do
  run_evmos_quiet "evmos_validator${i}_home" keys add validator${i} --keyring-backend test --algo eth_secp256k1 || true

  ADDR=$(docker run --rm --user root --entrypoint evmosd \
    -v evmos_validator${i}_home:${EVMOS_HOME} \
    "$IMAGE" keys show validator${i} \
      --keyring-backend test --home ${EVMOS_HOME} -a 2>/dev/null | tr -d '\n\r')

  if [ -z "$ADDR" ]; then
    echo "❌ Error: failed to resolve validator${i} address."
    exit 1
  fi

  VALIDATOR_ADDRS+=("$ADDR")
  echo "   ✅ Validator $i: ${ADDR}"
done
echo ""

# ----------------------------------------------------------
# Step 5: Import founder wallet key on validator1
# ----------------------------------------------------------
echo "💰 Step 5/${TOTAL_STEPS}: Importing founder test wallet (Hardhat Account #0)..."
echo -e "password123\npassword123" | docker run -i --rm --user root --entrypoint evmosd \
  -v evmos_validator1_home:${EVMOS_HOME} \
  "$IMAGE" keys unsafe-import-eth-key founder ${FOUNDER_ETH_PRIVKEY} \
    --keyring-backend test --home ${EVMOS_HOME} >/dev/null 2>&1 || true

FOUNDER_ADDR=$(docker run --rm --user root --entrypoint evmosd \
  -v evmos_validator1_home:${EVMOS_HOME} \
  "$IMAGE" keys show founder \
    --keyring-backend test --home ${EVMOS_HOME} -a 2>/dev/null | tr -d '\n\r')

if [ -z "$FOUNDER_ADDR" ]; then
  echo "❌ Error: founder key import failed. Please verify TEST_WALLET_PRIVATE_KEY."
  exit 1
fi

echo "   ✅ Founder Cosmos address: ${FOUNDER_ADDR}"
echo "   ✅ Founder EVM address:    0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo ""

# ----------------------------------------------------------
# Step 6: Add genesis accounts and patch genesis on validator1
# ----------------------------------------------------------
echo "📝 Step 6/${TOTAL_STEPS}: Adding genesis accounts and patching genesis..."

run_genesis_cmd "evmos_validator1_home" add-genesis-account "${FOUNDER_ADDR}" "${FOUNDER_BALANCE}" --keyring-backend test
echo "   ✅ Founder account added"

for i in $(seq 1 $NUM_VALIDATORS); do
  idx=$((i-1))
  ADDR="${VALIDATOR_ADDRS[$idx]}"
  if [ $i -eq 1 ]; then
    run_genesis_cmd "evmos_validator1_home" add-genesis-account validator1 "${VALIDATOR_BALANCE}" --keyring-backend test
  else
    run_genesis_cmd "evmos_validator1_home" add-genesis-account "${ADDR}" "${VALIDATOR_BALANCE}" --keyring-backend test
  fi
  echo "   ✅ Validator $i account added"
done

docker run --rm --user root --entrypoint sh \
  -v evmos_validator1_home:${EVMOS_HOME} \
  "$IMAGE" -c '
    GENESIS='"${EVMOS_HOME}"'/config/genesis.json
    jq '"'"'
      .app_state.staking.params.bond_denom = "aevmos" |
      (if .app_state.gov.deposit_params? then .app_state.gov.deposit_params.min_deposit[0].denom = "aevmos" else . end) |
      (if .app_state.gov.params? then .app_state.gov.params.min_deposit[0].denom = "aevmos" else . end) |
      (if .app_state.inflation?.params? then .app_state.inflation.params.mint_denom = "aevmos" else . end) |
      (if .app_state.mint?.params? then .app_state.mint.params.mint_denom = "aevmos" else . end) |
      (if .app_state.evm?.params? then .app_state.evm.params.evm_denom = "aevmos" else . end) |
      (if .app_state.feemarket?.params? then .app_state.feemarket.params.base_fee = "'"${BASE_FEE}"'" else . end) |
      .consensus_params.block.max_gas = "10000000"
    '"'"' "$GENESIS" > "${GENESIS}.tmp" && mv "${GENESIS}.tmp" "$GENESIS"
  ' >/dev/null 2>&1

echo "   ✅ Genesis patched (denom/base_fee/max_gas)"
echo ""

# ----------------------------------------------------------
# Step 7: Distribute genesis (accounts) to all nodes
# ----------------------------------------------------------
echo "📤 Step 7/${TOTAL_STEPS}: Distributing genesis with accounts..."
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm --user root \
    -v evmos_validator1_home:/src:ro \
    -v evmos_validator${i}_home:/dst \
    alpine sh -c "cp /src/config/genesis.json /dst/config/genesis.json" 2>/dev/null
  echo "   ✅ Genesis → Validator $i"
done
echo ""

# ----------------------------------------------------------
# Step 8: Create gentx for each validator
# ----------------------------------------------------------
echo "📝 Step 8/${TOTAL_STEPS}: Creating gentx..."
for i in $(seq 1 $NUM_VALIDATORS); do
  run_genesis_cmd "evmos_validator${i}_home" gentx validator${i} ${VALIDATOR_STAKE} \
    --chain-id ${CHAIN_ID} --keyring-backend test
  echo "   ✅ Validator $i: gentx created"
done
echo ""

# ----------------------------------------------------------
# Step 9: Collect gentxs and configure node settings
# ----------------------------------------------------------
echo "⚙️  Step 9/${TOTAL_STEPS}: Collecting gentxs and patching configs..."
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm --user root \
    -v evmos_validator${i}_home:/src:ro \
    -v evmos_validator1_home:/dst \
    alpine sh -c "cp /src/config/gentx/* /dst/config/gentx/" 2>/dev/null
done

run_genesis_cmd "evmos_validator1_home" collect-gentxs
run_genesis_cmd "evmos_validator1_home" validate-genesis || true

for i in $(seq 1 $NUM_VALIDATORS); do
  docker run --rm --user root --entrypoint sh \
    -v evmos_validator${i}_home:${EVMOS_HOME} \
    "$IMAGE" -c '
      CFG='"${EVMOS_HOME}"'/config/config.toml
      APP='"${EVMOS_HOME}"'/config/app.toml

      sed -i "s|laddr = \"tcp://127.0.0.1:26657\"|laddr = \"tcp://0.0.0.0:26657\"|" "$CFG"
      sed -i "s|laddr = \"tcp://localhost:26657\"|laddr = \"tcp://0.0.0.0:26657\"|" "$CFG"
      sed -i "s|laddr = \"tcp://127.0.0.1:26656\"|laddr = \"tcp://0.0.0.0:26656\"|" "$CFG"
      sed -i "s|laddr = \"tcp://localhost:26656\"|laddr = \"tcp://0.0.0.0:26656\"|" "$CFG"
      sed -i "s|cors_allowed_origins = \\[\\]|cors_allowed_origins = [\"*\"]|" "$CFG"

      sed -i "/\\[api\\]/,/\\[/{s|enable = false|enable = true|}" "$APP"
      sed -i "s|address = \"tcp://localhost:1317\"|address = \"tcp://0.0.0.0:1317\"|" "$APP"
      sed -i "s|address = \"tcp://127.0.0.1:1317\"|address = \"tcp://0.0.0.0:1317\"|" "$APP"
      sed -i "s|enabled-unsafe-cors = false|enabled-unsafe-cors = true|" "$APP"

      sed -i "s|address = \"localhost:9090\"|address = \"0.0.0.0:9090\"|" "$APP"
      sed -i "s|address = \"127.0.0.1:9090\"|address = \"0.0.0.0:9090\"|" "$APP"

      sed -i "/\\[json-rpc\\]/,/\\[/{s|enable = false|enable = true|}" "$APP"
      sed -i "s|address = \"127.0.0.1:8545\"|address = \"0.0.0.0:8545\"|" "$APP"
      sed -i "s|address = \"localhost:8545\"|address = \"0.0.0.0:8545\"|" "$APP"
      sed -i "s|ws-address = \"127.0.0.1:8546\"|ws-address = \"0.0.0.0:8546\"|" "$APP"
      sed -i "s|ws-address = \"localhost:8546\"|ws-address = \"0.0.0.0:8546\"|" "$APP"
      sed -i "s|api = \"eth,net,web3\"|api = \"eth,txpool,personal,net,debug,web3\"|" "$APP"
      sed -i "s|api = \"eth,web3,net,txpool,debug\"|api = \"eth,txpool,personal,net,debug,web3\"|" "$APP"

      sed -i "s|minimum-gas-prices = \"\"|minimum-gas-prices = \"0.0001aevmos\"|" "$APP"
      sed -i "s|minimum-gas-prices = \"0stake\"|minimum-gas-prices = \"0.0001aevmos\"|" "$APP"
    ' >/dev/null 2>&1

  echo "   ✅ Validator $i: configured"
done
echo ""

# ----------------------------------------------------------
# Step 10: Distribute final genesis to all nodes
# ----------------------------------------------------------
echo "📤 Step 10/${TOTAL_STEPS}: Distributing final genesis.json..."
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm --user root \
    -v evmos_validator1_home:/src:ro \
    -v evmos_validator${i}_home:/dst \
    alpine sh -c "cp /src/config/genesis.json /dst/config/genesis.json" 2>/dev/null
  echo "   ✅ Genesis → Validator $i"
done
echo ""

# ----------------------------------------------------------
# Step 11: Get node IDs and write PERSISTENT_PEERS
# ----------------------------------------------------------
echo "🔗 Step 11/${TOTAL_STEPS}: Getting CometBFT Node IDs..."
PEERS=""
for i in $(seq 1 $NUM_VALIDATORS); do
  NODE_ID=$(docker run --rm --user root --entrypoint evmosd \
    -v evmos_validator${i}_home:${EVMOS_HOME} \
    "$IMAGE" comet show-node-id --home ${EVMOS_HOME} 2>/dev/null || \
  docker run --rm --user root --entrypoint evmosd \
    -v evmos_validator${i}_home:${EVMOS_HOME} \
    "$IMAGE" tendermint show-node-id --home ${EVMOS_HOME} 2>/dev/null)

  NODE_ID=$(echo "$NODE_ID" | tr -d '\n\r')
  PEER="${NODE_ID}@evmos-validator${i}:26656"
  echo "   Validator $i: ${PEER}"

  if [ -z "$PEERS" ]; then
    PEERS="$PEER"
  else
    PEERS="${PEERS},${PEER}"
  fi
done
echo ""

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
echo "📋 Founder Wallet (Hardhat Account #0):"
echo "   Cosmos:      ${FOUNDER_ADDR}"
echo "   EVM:         0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo ""
echo "📋 Next steps:"
echo "  1. Start network: ./start-multinode.sh"
echo "  2. Check status:  docker compose --env-file .env.multinode -f docker-compose.yml ps"
echo "  3. Stop network:  ./stop-multinode.sh"
echo ""
