#!/bin/bash
# init-multinode.sh — Initialize 4-validator Sei localnet
#
# Architecture: CometBFT (Twin Turbo Consensus) + Parallelized EVM (Sei V2)
# Each validator = 1 container (consensus + EVM in same process)
# Binary: seid | Home: /root/.sei | Denom: usei (6 decimals)
#
# How it works:
#   1. Clean old Docker volumes
#   2. Initialize each validator node (generate keys and config)
#   3. Create operator keys for each validator
#   4. Derive founder (test wallet) address for EVM
#   5. Add all accounts to genesis on node1
#   6. Patch genesis denominations and chain params
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

IMAGE="sei-chain:${SEI_TAG:-local}"
CHAIN_ID="sei"
SEI_HOME="/root/.sei"
DENOM="usei"

# Amounts (usei = micro-sei, 6 decimal places)
VALIDATOR_BALANCE="100000000000${DENOM}"    # 100,000 SEI per validator
VALIDATOR_STAKE="10000000000${DENOM}"       # 10,000 SEI staked per validator
FOUNDER_BALANCE="1000000000000${DENOM}"     # 1,000,000 SEI for test wallet

# Hardhat Account #0 EVM address and mnemonic
FOUNDER_EVM_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
FOUNDER_EVM_HEX="f39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

NUM_VALIDATORS=4
TOTAL_STEPS=12

# Helper: run seid command in a Docker container
run_sei() {
  local vol="$1"
  shift
  docker run --rm --entrypoint seid \
    -v "${vol}:${SEI_HOME}" "$IMAGE" "$@" --home "${SEI_HOME}"
}

run_sei_quiet() {
  local vol="$1"
  shift
  docker run --rm --entrypoint seid \
    -v "${vol}:${SEI_HOME}" "$IMAGE" "$@" --home "${SEI_HOME}" >/dev/null 2>&1
}

echo "============================================"
echo "  Sei Multi-Validator Localnet Init"
echo "  Architecture: CometBFT + Parallelized EVM"
echo "  Validators: ${NUM_VALIDATORS}"
echo "  Image: ${IMAGE}"
echo "  Chain ID: ${CHAIN_ID}"
echo "============================================"
echo ""

# Pre-flight: ensure Docker image exists locally (build from source if missing)
SEI_REPO="https://github.com/sei-protocol/sei-chain.git"
SEI_BRANCH="${SEI_BRANCH:-v6.3.3}"
SEI_BUILD_DIR="/tmp/sei-chain-src"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "📥 Docker image '${IMAGE}' not found locally. Building from source..."
  echo "   Repository: ${SEI_REPO} (branch: ${SEI_BRANCH})"
  rm -rf "$SEI_BUILD_DIR"
  if ! git clone --depth 1 --branch "$SEI_BRANCH" "$SEI_REPO" "$SEI_BUILD_DIR"; then
    echo "❌ Error: Failed to clone Sei repository."
    echo "   Please check your network connection and that branch '${SEI_BRANCH}' exists."
    exit 1
  fi

  # Initialize submodules (sei-wasmd, sei-wasmvm are required for the build)
  cd "$SEI_BUILD_DIR"
  git submodule update --init --recursive --depth 1 || {
    echo "⚠️  Shallow submodule update failed, trying full clone..."
    git submodule update --init --recursive
  }
  cd -

  if ! DOCKER_DEFAULT_PLATFORM=linux/amd64 docker build -t "$IMAGE" "$SEI_BUILD_DIR"; then
    echo "❌ Error: Failed to build Docker image '${IMAGE}'."
    echo "   Check the build output above for details."
    rm -rf "$SEI_BUILD_DIR"
    exit 1
  fi
  rm -rf "$SEI_BUILD_DIR"
  echo "   ✅ Image '${IMAGE}' built successfully"
  echo ""
fi

# ----------------------------------------------------------
# Step 1: Clean old volumes
# ----------------------------------------------------------
echo "🧹 Step 1/${TOTAL_STEPS}: Cleaning old volumes..."
for i in $(seq 1 $NUM_VALIDATORS); do
  docker volume rm -f sei_validator${i}_home 2>/dev/null || true
done
echo "   ✅ Cleaned"
echo ""

# ----------------------------------------------------------
# Step 2: Initialize each validator node
# ----------------------------------------------------------
echo "🔑 Step 2/${TOTAL_STEPS}: Initializing nodes..."
for i in $(seq 1 $NUM_VALIDATORS); do
  run_sei_quiet "sei_validator${i}_home" init validator${i} --chain-id ${CHAIN_ID}
  echo "   ✅ Validator $i: initialized"
done
echo ""

# ----------------------------------------------------------
# Step 3: Create operator keys for each validator
# ----------------------------------------------------------
echo "🔐 Step 3/${TOTAL_STEPS}: Creating operator keys..."
declare -a VALIDATOR_ADDRS
for i in $(seq 1 $NUM_VALIDATORS); do
  # Create standard Cosmos key for validator (secp256k1)
  docker run --rm --entrypoint seid \
    -v sei_validator${i}_home:${SEI_HOME} \
    "$IMAGE" keys add validator${i} --keyring-backend test --home ${SEI_HOME} >/dev/null 2>&1

  ADDR=$(docker run --rm --entrypoint seid \
    -v sei_validator${i}_home:${SEI_HOME} \
    "$IMAGE" keys show validator${i} \
      --keyring-backend test --home ${SEI_HOME} -a 2>/dev/null | tr -d '\n\r')

  if [ -z "$ADDR" ]; then
    echo "❌ Error: failed to create validator${i} key or resolve its address."
    exit 1
  fi
  VALIDATOR_ADDRS+=("$ADDR")
  echo "   ✅ Validator $i: ${ADDR}"
done
echo ""

# ----------------------------------------------------------
# Step 4: Derive founder (test wallet) Sei address
# ----------------------------------------------------------
echo "💰 Step 4/${TOTAL_STEPS}: Deriving founder wallet address..."

# Sei V2 is NOT Ethermint-based. We derive the sei1... address from the EVM hex
# using bech32 encoding. The founder wallet (Hardhat Account #0) will have funds
# accessible via both the Cosmos and EVM address once associated.
#
# Method 1: Try seid debug addr (standard Cosmos SDK debug command)
# Method 2: Use Python-based bech32 computation as fallback
FOUNDER_SEI_ADDR=""

FOUNDER_SEI_ADDR=$(docker run --rm --entrypoint seid \
  "$IMAGE" debug addr "${FOUNDER_EVM_HEX}" 2>&1 | grep -i "Bech32 Acc" | awk '{print $NF}' | tr -d '\n\r') || true

if [ -z "$FOUNDER_SEI_ADDR" ]; then
  echo "   ℹ️  seid debug addr not available, computing bech32 via Python..."
  FOUNDER_SEI_ADDR=$(docker run --rm python:3-alpine python3 -c "
CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
def polymod(values):
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ v
        for i in range(5):
            chk ^= [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3][i] if ((b >> i) & 1) else 0
    return chk
def encode(hrp, data):
    values = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp] + data
    p = polymod(values + [0]*6) ^ 1
    cs = [(p >> 5*(5-i)) & 31 for i in range(6)]
    return hrp + '1' + ''.join(CHARSET[d] for d in data + cs)
def cvt(data, fb, tb, pad=True):
    acc, bits, ret = 0, 0, []
    for v in data:
        acc = (acc << fb) | v; bits += fb
        while bits >= tb:
            bits -= tb; ret.append((acc >> bits) & ((1 << tb) - 1))
    if pad and bits: ret.append((acc << (tb - bits)) & ((1 << tb) - 1))
    return ret
print(encode('sei', cvt(bytes.fromhex('${FOUNDER_EVM_HEX}'), 8, 5, True)))
" | tr -d '\n\r')
fi

if [ -z "$FOUNDER_SEI_ADDR" ]; then
  echo "❌ Error: Failed to derive Sei bech32 address for EVM address ${FOUNDER_EVM_ADDR}"
  exit 1
fi

echo "   ✅ Founder Cosmos address: ${FOUNDER_SEI_ADDR}"
echo "   ✅ Founder EVM address:    ${FOUNDER_EVM_ADDR}"
echo ""

# ----------------------------------------------------------
# Step 5: Add genesis accounts on node1
# ----------------------------------------------------------
echo "📝 Step 5/${TOTAL_STEPS}: Adding genesis accounts..."

# Add founder account (use keyring-backend=os: with "test", Sei requires the account pubkey in the
# local keyring to derive the EVM association — raw bech32-only would error with "not found".)
run_sei_quiet "sei_validator1_home" add-genesis-account "${FOUNDER_SEI_ADDR}" "${FOUNDER_BALANCE}" --keyring-backend os
echo "   ✅ Founder account added"

# Add each validator's account
for i in $(seq 1 $NUM_VALIDATORS); do
  idx=$((i-1))
  ADDR="${VALIDATOR_ADDRS[$idx]}"
  if [ $i -eq 1 ]; then
    run_sei_quiet "sei_validator1_home" add-genesis-account validator1 "${VALIDATOR_BALANCE}" --keyring-backend test
  else
    # Validator 2–4 addresses are not in node1 keyring; use os backend like founder.
    run_sei_quiet "sei_validator1_home" add-genesis-account "${ADDR}" "${VALIDATOR_BALANCE}" --keyring-backend os
  fi
  echo "   ✅ Validator $i account added"
done
echo ""

# ----------------------------------------------------------
# Step 6: Patch genesis denominations and chain params
# ----------------------------------------------------------
echo "🔄 Step 6/${TOTAL_STEPS}: Patching genesis.json..."
docker run --rm \
  -e FOUNDER_SEI="${FOUNDER_SEI_ADDR}" \
  -e FOUNDER_ETH="${FOUNDER_EVM_ADDR}" \
  -v sei_validator1_home:/home/sei \
  alpine sh -c '
    apk add --no-cache jq >/dev/null 2>&1
    GENESIS=/home/sei/config/genesis.json

    # Patch Cosmos module denominations and timing
    jq ".app_state.staking.params.bond_denom = \"usei\" |
        .app_state.staking.params.unbonding_time = \"10s\" |
        .app_state.slashing.params.signed_blocks_window = \"10\" |
        .app_state.slashing.params.downtime_jail_duration = \"1m0s\" |
        .app_state.crisis.constant_fee.denom = \"usei\" |
        .app_state.gov.deposit_params.min_deposit[0].denom = \"usei\" |
        .app_state.mint.params.mint_denom = \"usei\" |
        .consensus_params.block.max_gas = \"30000000\"" $GENESIS > $GENESIS.tmp && \
    mv $GENESIS.tmp $GENESIS

    # Register usei denom metadata in bank module
    jq ".app_state.bank.denom_metadata = [{
      \"description\": \"The native staking and governance token of Sei\",
      \"denom_units\": [
        {\"denom\": \"usei\", \"exponent\": 0, \"aliases\": [\"microsei\"]},
        {\"denom\": \"msei\", \"exponent\": 3, \"aliases\": [\"millisei\"]},
        {\"denom\": \"sei\",  \"exponent\": 6}
      ],
      \"base\": \"usei\",
      \"display\": \"sei\",
      \"name\": \"Sei\",
      \"symbol\": \"SEI\"
    }]" $GENESIS > $GENESIS.tmp && \
    mv $GENESIS.tmp $GENESIS

    # Link founder sei1 address to Hardhat EVM address (same as keyring-backend=test path in seid)
    jq --arg sei "$FOUNDER_SEI" --arg eth "$FOUNDER_ETH" \
      ".app_state.evm.address_associations += [{\"sei_address\": \$sei, \"eth_address\": \$eth}]" \
      $GENESIS > $GENESIS.tmp && \
    mv $GENESIS.tmp $GENESIS
  ' 2>/dev/null
echo "   ✅ Genesis patched (denom: usei, EVM address association for founder, bank metadata)"
echo ""

# ----------------------------------------------------------
# Step 7: Distribute genesis (with accounts) to all nodes
# ----------------------------------------------------------
echo "📤 Step 7/${TOTAL_STEPS}: Distributing genesis with accounts..."
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm \
    -v sei_validator1_home:/src:ro \
    -v sei_validator${i}_home:/dst \
    alpine sh -c "cp /src/config/genesis.json /dst/config/genesis.json" 2>/dev/null
  echo "   ✅ Genesis → Validator $i"
done
echo ""

# ----------------------------------------------------------
# Step 8: Create gentx for each validator
# ----------------------------------------------------------
echo "📝 Step 8/${TOTAL_STEPS}: Creating gentx for each validator..."
for i in $(seq 1 $NUM_VALIDATORS); do
  run_sei_quiet "sei_validator${i}_home" gentx validator${i} ${VALIDATOR_STAKE} \
    --chain-id ${CHAIN_ID} --keyring-backend test
  echo "   ✅ Validator $i: gentx created"
done
echo ""

# ----------------------------------------------------------
# Step 9: Collect gentxs on node1
# ----------------------------------------------------------
echo "📦 Step 9/${TOTAL_STEPS}: Collecting gentxs on node1..."

for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm \
    -v sei_validator${i}_home:/src:ro \
    -v sei_validator1_home:/dst \
    alpine sh -c "cp /src/config/gentx/* /dst/config/gentx/" 2>/dev/null
  echo "   ✅ Validator $i gentx → node1"
done

run_sei_quiet "sei_validator1_home" collect-gentxs

GENTX_COUNT=$(docker run --rm \
  -v sei_validator1_home:/home/sei \
  alpine sh -c "
    apk add --no-cache jq >/dev/null 2>&1
    cat /home/sei/config/genesis.json | jq '.app_state.genutil.gen_txs | length'
  " 2>/dev/null || echo "unknown")
echo "   ✅ Genesis contains ${GENTX_COUNT} validator gentxs"
echo ""

# ----------------------------------------------------------
# Step 9b: Inject top-level .validators array into genesis
# ----------------------------------------------------------
# Sei's Tendermint fork (sei-tendermint) requires an explicit .validators[]
# array at the top level of genesis.json, containing each validator's Ed25519
# pubkey and voting power. Standard collect-gentxs does NOT populate this in
# Sei — the official localnet uses step3_add_validator_to_genesis.sh for this.
# Without it, Tendermint has no validator set and consensus stalls at height 1.
echo "🔑 Step 9b: Injecting .validators array into genesis..."

docker run --rm \
  -v sei_validator1_home:/home/sei \
  alpine sh -c '
    apk add --no-cache jq >/dev/null 2>&1
    GENESIS=/home/sei/config/genesis.json

    jq ".validators = []" $GENESIS > $GENESIS.tmp && mv $GENESIS.tmp $GENESIS

    IDX=0
    for GENTX_FILE in /home/sei/config/gentx/*.json; do
      KEY=$(jq -r ".body.messages[0].pubkey.key" "$GENTX_FILE")
      DELEGATION=$(jq -r ".body.messages[0].value.amount" "$GENTX_FILE")
      POWER=$((DELEGATION / 1000000))

      jq --argjson idx "$IDX" \
         --arg power "$POWER" \
         --arg key "$KEY" \
         ".validators[$idx] = {\"power\": \$power, \"pub_key\": {\"type\": \"tendermint/PubKeyEd25519\", \"value\": \$key}}" \
         $GENESIS > $GENESIS.tmp && mv $GENESIS.tmp $GENESIS

      IDX=$((IDX + 1))
    done

    echo "   Injected $IDX validators into genesis.validators[]"
  ' 2>/dev/null
echo "   ✅ Top-level .validators array written"
echo ""

# ----------------------------------------------------------
# Step 10: Configure node settings (RPC, REST, per-node persistent peers)
# ----------------------------------------------------------
echo "⚙️  Step 10/${TOTAL_STEPS}: Configuring node settings..."

declare -a PEER_ENTRY
for i in $(seq 1 $NUM_VALIDATORS); do
  NODE_ID=$(docker run --rm --entrypoint seid \
    -v sei_validator${i}_home:${SEI_HOME} \
    "$IMAGE" tendermint show-node-id --home ${SEI_HOME} 2>/dev/null || \
  docker run --rm --entrypoint seid \
    -v sei_validator${i}_home:${SEI_HOME} \
    "$IMAGE" comet show-node-id --home ${SEI_HOME} 2>/dev/null)
  NODE_ID=$(echo "$NODE_ID" | tr -d '\n\r')
  PEER_ENTRY+=("${NODE_ID}@sei-validator${i}:26656")
done

for i in $(seq 1 $NUM_VALIDATORS); do
  PEERS_EXCL=""
  for j in $(seq 1 $NUM_VALIDATORS); do
    if [ "$i" -eq "$j" ]; then
      continue
    fi
    idx=$((j - 1))
    p="${PEER_ENTRY[$idx]}"
    if [ -z "$PEERS_EXCL" ]; then
      PEERS_EXCL="$p"
    else
      PEERS_EXCL="${PEERS_EXCL},${p}"
    fi
  done

  docker run --rm \
    -e PEERS="$PEERS_EXCL" \
    -e EXT_ADDR="sei-validator${i}:26656" \
    -v sei_validator${i}_home:/home/sei \
    alpine sh -c "
      CONFIG=/home/sei/config/config.toml
      APP=/home/sei/config/app.toml

      sed -i \"s|^persistent-peers = .*|persistent-peers = \\\"\$PEERS\\\"|\" \"\$CONFIG\"

      sed -i \"s|laddr = \\\"tcp://127.0.0.1:26656\\\"|laddr = \\\"tcp://0.0.0.0:26656\\\"|\" \"\$CONFIG\"
      sed -i \"s|^allow-duplicate-ip = false|allow-duplicate-ip = true|\" \"\$CONFIG\"
      sed -i \"s|^external-address = \\\"\\\"|external-address = \\\"\$EXT_ADDR\\\"|\" \"\$CONFIG\"

      sed -i \"s|laddr = \\\"tcp://127.0.0.1:26657\\\"|laddr = \\\"tcp://0.0.0.0:26657\\\"|\" \"\$CONFIG\"

      # Sei uses unsafe-*-override params (sei-tendermint), matching official localnode config
      sed -i \"s|^unsafe-propose-timeout-override = .*|unsafe-propose-timeout-override = \\\"3s\\\"|\" \"\$CONFIG\"
      sed -i \"s|^unsafe-propose-timeout-delta-override = .*|unsafe-propose-timeout-delta-override = \\\"500ms\\\"|\" \"\$CONFIG\"
      sed -i \"s|^unsafe-vote-timeout-override = .*|unsafe-vote-timeout-override = \\\"50ms\\\"|\" \"\$CONFIG\"
      sed -i \"s|^unsafe-vote-timeout-delta-override = .*|unsafe-vote-timeout-delta-override = \\\"500ms\\\"|\" \"\$CONFIG\"
      sed -i \"s|^unsafe-commit-timeout-override = .*|unsafe-commit-timeout-override = \\\"50ms\\\"|\" \"\$CONFIG\"

      # Set node mode to validator (sei-tendermint requires explicit mode)
      sed -i \"s|^mode = \\\"full\\\"|mode = \\\"validator\\\"|\" \"\$CONFIG\"

      sed -i \"s|cors_allowed_origins = \\[\\]|cors_allowed_origins = [\\\"*\\\"]|\" \"\$CONFIG\"

      sed -i \"/\\[api\\]/,/\\[/{s|enable = false|enable = true|}\" \"\$APP\"
      sed -i \"s|address = \\\"tcp://localhost:1317\\\"|address = \\\"tcp://0.0.0.0:1317\\\"|\" \"\$APP\"
      sed -i \"s|address = \\\"tcp://127.0.0.1:1317\\\"|address = \\\"tcp://0.0.0.0:1317\\\"|\" \"\$APP\"
      sed -i \"s|enabled-unsafe-cors = false|enabled-unsafe-cors = true|\" \"\$APP\"

      sed -i \"s|address = \\\"localhost:9090\\\"|address = \\\"0.0.0.0:9090\\\"|\" \"\$APP\"
      sed -i \"s|address = \\\"127.0.0.1:9090\\\"|address = \\\"0.0.0.0:9090\\\"|\" \"\$APP\"

      sed -i \"s|minimum-gas-prices = \\\"\\\"|minimum-gas-prices = \\\"0.01usei\\\"|\" \"\$APP\"
    " 2>/dev/null
  echo "   ✅ Validator $i: configured (persistent-peers excludes self)"
done
echo ""

# ----------------------------------------------------------
# Step 11: Distribute final genesis to all nodes
# ----------------------------------------------------------
echo "📤 Step 11/${TOTAL_STEPS}: Distributing final genesis.json..."
for i in $(seq 2 $NUM_VALIDATORS); do
  docker run --rm \
    -v sei_validator1_home:/src:ro \
    -v sei_validator${i}_home:/dst \
    alpine sh -c "cp /src/config/genesis.json /dst/config/genesis.json" 2>/dev/null
  echo "   ✅ Genesis → Validator $i"
done
echo ""

# ----------------------------------------------------------
# Step 12: Write .env.multinode (peers are stored in each config.toml; .env is informational)
# ----------------------------------------------------------
echo "🔗 Step 12/${TOTAL_STEPS}: Recording peer list for reference..."

PEERS=$(IFS=,; echo "${PEER_ENTRY[*]}")
for idx in $(seq 0 $((NUM_VALIDATORS - 1))); do
  echo "   Validator $((idx + 1)): ${PEER_ENTRY[$idx]}"
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
echo "   ✅ .env.multinode updated (reference only; compose reads peers from config.toml)"

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
echo "   Cosmos:      ${FOUNDER_SEI_ADDR}"
echo "   EVM:         ${FOUNDER_EVM_ADDR}"
echo ""
echo "📋 Persistent Peers:"
echo "   ${PEERS}"
echo ""
echo "📋 Next steps:"
echo "  1. Start network: ./start-multinode.sh"
echo "  2. Check status:  docker compose --env-file .env.multinode -f docker-compose.yml ps"
echo "  3. Stop network:  ./stop-multinode.sh"
echo ""
