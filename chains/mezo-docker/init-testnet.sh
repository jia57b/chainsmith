#!/bin/bash
# init-testnet.sh — Initialize 4-validator Mezo localnet
#
# Architecture: Ethermint (CometBFT + Cosmos SDK + integrated EVM)
# Each validator = 1 container (consensus + EVM in same process, like Kava)
#
# How it works:
#   1. Clean old testnet data
#   2. Run mezod testnet init-files via Docker (generates 4 validators)
#   3. Create client.toml for each node via Docker
#   4. Inject Hardhat Account #0 as founder wallet into genesis
#   5. Append missing EVM/JSON-RPC config to app.toml
#   6. Fix file permissions and save founder info
#
# Usage:
#   chmod +x init-testnet.sh
#   ./init-testnet.sh

set -e

IMAGE="mezo/mezod:latest"
CHAINID="mezo_31612-1"
NUM_VALIDATORS=4
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="${SCRIPT_DIR}/testnet-data"
SOURCE_BTC_TOKEN="0x0000000000000000000000000000000000000000"
TOTAL_STEPS=6

# Hardhat Account #0 — consistent with kava-docker, 0g-docker, story-docker
FOUNDER_ETH_PRIVKEY="ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
FOUNDER_ETH_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
FOUNDER_MEZO_ADDR="mezo17w0adeg64ky0daxwd2ugyuneellmjgnx5qukc3"
FOUNDER_BALANCE_ABTC="10000000000000000000000000000"
FOUNDER_BALANCE_AMEZO="10000000000000000000000000000"

echo "============================================"
echo "  Mezo Multi-Validator Localnet Init"
echo "  Architecture: Ethermint (CometBFT + EVM)"
echo "  Validators: ${NUM_VALIDATORS}"
echo "  Image: ${IMAGE}"
echo "  Chain ID: ${CHAINID}"
echo "============================================"
echo ""

# ----------------------------------------------------------
# Step 1: Clean old testnet data
# ----------------------------------------------------------
echo "🧹 Step 1/${TOTAL_STEPS}: Cleaning old testnet data..."
rm -rf "$BASE_DIR"
mkdir -p "$BASE_DIR"
echo "   ✅ Cleaned"
echo ""

# ----------------------------------------------------------
# Step 2: Generate testnet files via Docker
# ----------------------------------------------------------
echo "🔑 Step 2/${TOTAL_STEPS}: Running mezod testnet init-files..."
docker run --rm --user 0:0 \
    -v "${BASE_DIR}:/output" \
    --entrypoint /usr/bin/mezod \
    "${IMAGE}" \
    testnet init-files \
        --v "${NUM_VALIDATORS}" \
        --chain-id "${CHAINID}" \
        --output-dir /output \
        --starting-ip-address 192.168.20.2 \
        --key-type eth_secp256k1 \
        --keyring-backend test \
        --source-btc-token "${SOURCE_BTC_TOKEN}"
echo "   ✅ Testnet files generated for ${NUM_VALIDATORS} validators"
echo ""

# ----------------------------------------------------------
# Step 3: Create client.toml for each node
# ----------------------------------------------------------
echo "⚙️  Step 3/${TOTAL_STEPS}: Creating client.toml for each node..."
for i in $(seq 0 $((NUM_VALIDATORS - 1))); do
    CLIENT_TOML="${BASE_DIR}/node${i}/mezod/config/client.toml"

    docker run --rm --user 0:0 \
        -v "${BASE_DIR}/node${i}/mezod:/home/nonroot/.mezod" \
        --entrypoint /usr/bin/mezod \
        "${IMAGE}" \
        config set client chain-id "${CHAINID}" --home /home/nonroot/.mezod 2>&1 || true

    docker run --rm --user 0:0 \
        -v "${BASE_DIR}/node${i}/mezod:/home/nonroot/.mezod" \
        --entrypoint /usr/bin/mezod \
        "${IMAGE}" \
        config set client keyring-backend test --home /home/nonroot/.mezod 2>&1 || true

    if [ ! -f "$CLIENT_TOML" ]; then
        echo "   ⚠️  Node $i: mezod config set did not create client.toml, writing manually..."
        cat > "$CLIENT_TOML" <<EOF
chain-id = "${CHAINID}"
keyring-backend = "test"
output = "text"
node = "tcp://localhost:26657"
broadcast-mode = "sync"
EOF
    fi

    echo "   ✅ Node $i: client.toml created"
done
echo ""

# ----------------------------------------------------------
# Step 4: Inject founder wallet + patch app.toml + distribute genesis
# ----------------------------------------------------------
echo "💰 Step 4/${TOTAL_STEPS}: Injecting founder wallet (Hardhat Account #0) into genesis..."
docker run --rm \
    -v "${BASE_DIR}:/data" \
    alpine sh -c "
        apk add --no-cache jq bc > /dev/null 2>&1

        GENESIS=/data/node0/mezod/config/genesis.json

        # Add EthAccount for founder to auth.accounts
        jq '.app_state.auth.accounts += [{
            \"@type\": \"/ethermint.types.v1.EthAccount\",
            \"base_account\": {
                \"address\": \"${FOUNDER_MEZO_ADDR}\",
                \"pub_key\": null,
                \"account_number\": \"0\",
                \"sequence\": \"0\"
            },
            \"code_hash\": \"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470\"
        }]' \$GENESIS > /tmp/genesis.json && mv /tmp/genesis.json \$GENESIS

        # Add balances for founder to bank.balances
        jq '.app_state.bank.balances += [{
            \"address\": \"${FOUNDER_MEZO_ADDR}\",
            \"coins\": [
                {\"denom\": \"abtc\", \"amount\": \"${FOUNDER_BALANCE_ABTC}\"},
                {\"denom\": \"amezo\", \"amount\": \"${FOUNDER_BALANCE_AMEZO}\"}
            ]
        }]' \$GENESIS > /tmp/genesis.json && mv /tmp/genesis.json \$GENESIS

        # Update bridge.initial_btc_supply to include founder's abtc
        # (x/bridge EndBlock asserts: bank abtc supply == initial_btc_supply)
        CURRENT_SUPPLY=\$(jq -r '.app_state.bridge.initial_btc_supply' \$GENESIS)
        NEW_SUPPLY=\$(echo \"\${CURRENT_SUPPLY} + ${FOUNDER_BALANCE_ABTC}\" | bc)
        jq --arg s \"\$NEW_SUPPLY\" '.app_state.bridge.initial_btc_supply = \$s' \$GENESIS > /tmp/genesis.json && mv /tmp/genesis.json \$GENESIS

        echo '   Account, balances and bridge supply updated on node0 genesis'

        # Distribute modified genesis to all other nodes
        for i in 1 2 3; do
            cp \$GENESIS /data/node\${i}/mezod/config/genesis.json
            echo \"   Genesis distributed to node\${i}\"
        done
    "
echo "   ✅ Founder: ${FOUNDER_ETH_ADDR} (${FOUNDER_MEZO_ADDR})"
echo ""

# ----------------------------------------------------------
# Step 5: Patch app.toml and config.toml
# Newer mezod versions generate [evm]/[json-rpc]/[tls] sections;
# older versions omit them. Only append if missing.
# Also ensure JSON-RPC API includes required namespaces and
# CometBFT RPC listens on all interfaces.
# ----------------------------------------------------------
echo "📝 Step 5/${TOTAL_STEPS}: Patching app.toml and config.toml..."
docker run --rm \
    -v "${BASE_DIR}:/data" \
    alpine sh -c '
        for i in 0 1 2 3; do
            APP_TOML="/data/node${i}/mezod/config/app.toml"
            CONFIG_TOML="/data/node${i}/mezod/config/config.toml"

            # Only append [evm]/[json-rpc]/[tls] if they do not already exist
            if ! grep -q "^\[json-rpc\]" "$APP_TOML"; then
                cat >> "$APP_TOML" <<EVRPC

[evm]
tracer = ""
max-tx-gas-wanted = 0

[json-rpc]
enable = true
address = "0.0.0.0:8545"
ws-address = "0.0.0.0:8546"
api = "eth,txpool,personal,net,debug,web3"
gas-cap = 25000000
evm-timeout = "5s"
txfee-cap = 1
filter-cap = 200
feehistory-cap = 100
logs-cap = 10000
block-range-cap = 10000
http-timeout = "30s"
http-idle-timeout = "120s"
allow-unprotected-txs = false
max-open-connections = 0
enable-indexer = false
metrics-address = "0.0.0.0:6065"
fix-revert-gas-refund-height = 0

[tls]
certificate-path = ""
key-path = ""
EVRPC
                echo "   Node ${i}: [json-rpc] section appended (was missing)"
            else
                echo "   Node ${i}: [json-rpc] section already exists, skipping append"
            fi

            # Ensure JSON-RPC API includes test-required namespaces
            sed -i "s|api = \"eth,net,web3,mezo\"|api = \"eth,txpool,personal,net,debug,web3\"|" "$APP_TOML"

            # Ensure JSON-RPC metrics listens on all interfaces (for Docker)
            sed -i "s|metrics-address = \"127.0.0.1:6065\"|metrics-address = \"0.0.0.0:6065\"|" "$APP_TOML"

            # Ensure CometBFT RPC listens on all interfaces
            sed -i "s|laddr = \"tcp://127.0.0.1:26657\"|laddr = \"tcp://0.0.0.0:26657\"|" "$CONFIG_TOML"

            echo "   Node ${i}: config patched"
        done
    '
echo "   ✅ All nodes patched"
echo ""

# ----------------------------------------------------------
# Step 6: Fix file permissions
# ----------------------------------------------------------
# Init steps run as root (--user 0:0) so all files are owned by UID 0.
# The mezod image runs as "nonroot" (UID 65532) from distroless.
# Without fixing permissions, nonroot cannot read config files.
echo "🔐 Step 6/${TOTAL_STEPS}: Fixing file permissions for nonroot user (UID 65532)..."
docker run --rm --user 0:0 \
    -v "${BASE_DIR}:/data" \
    alpine sh -c 'chown -R 65532:65532 /data && chmod -R u+rw /data'
echo "   ✅ Permissions fixed"
echo ""

echo "============================================"
echo "  ✅ Initialization complete!"
echo "  ${NUM_VALIDATORS} validators + 1 founder configured"
echo "============================================"
echo ""
echo "📋 Founder Wallet (Hardhat Account #0):"
echo "   Mezo:        ${FOUNDER_MEZO_ADDR}"
echo "   EVM:         ${FOUNDER_ETH_ADDR}"
echo "   Private Key: 0x${FOUNDER_ETH_PRIVKEY}"
echo ""
echo "📋 Next steps:"
echo "  1. Start network: docker compose up -d"
echo "  2. Check status:  docker compose ps"
echo "  3. Stop network:  docker compose down -v"
echo ""
