#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node" ]; then
  echo "❌ node directory not found. Please ensure you are in the correct directory."
  exit 1
fi

echo "🔧 Preparing xrplevm localnet bootstrap..."
echo "If node/bin/exrpd is missing, the script will build it from source using public HTTPS module fetch."

echo "🚀 Initializing 4-node localnet..."

rm -rf .testnet
mkdir -p .testnet

cat << 'SETUP_EOF' > .testnet/setup.sh
#!/bin/bash
set -euo pipefail

apt-get update && apt-get install -y jq > /dev/null 2>&1

if [ ! -f /code/node/bin/exrpd ]; then
  echo "Building exrpd binary locally for initialization..."
  cd /code/node
  git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
  make build
  cd /code
fi

EXRPD=/code/node/bin/exrpd
HOMEDIR=/code/.testnet
CHAINID="xrplevm_1449999-1"
KEYRING="test"
KEYALGO="eth_secp256k1"
NUM_NODES=4

# Hardhat default mnemonic — account #0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
FAUCET_MNEMONIC="test test test test test test test test test test test junk"

# ── Phase 1: Init all nodes and generate validator keys ──────────────
echo "[1/6] Initializing $NUM_NODES nodes..."
for i in $(seq 0 $((NUM_NODES - 1))); do
  NODE_HOME=$HOMEDIR/node$i
  $EXRPD init node$i --chain-id $CHAINID --home $NODE_HOME > /dev/null 2>&1
  $EXRPD keys add validator$i --keyring-backend $KEYRING --algo $KEYALGO --home $NODE_HOME > /dev/null 2>&1
  echo "  node$i initialized"
done

# ── Phase 2: Build genesis on node0 (single source of truth) ────────
echo "[2/6] Building genesis on node0..."
GENESIS=$HOMEDIR/node0/config/genesis.json
TMP_GENESIS=$HOMEDIR/node0/config/tmp_genesis.json

jq '.app_state.staking.params.bond_denom="apoa"
  | .app_state.crisis.constant_fee.denom="axrp"
  | .app_state.evm.params.evm_denom="axrp"
  | .app_state.feemarket.params.base_fee="0"
  | .app_state.feemarket.params.no_base_fee=true
  | .app_state.gov.params.min_deposit[0].denom="axrp"
  | .app_state.gov.params.min_deposit[0].amount="1"
  | .app_state.gov.params.voting_period="10s"
  | .app_state.gov.params.expedited_voting_period="5s"
  | .app_state.slashing.params.slash_fraction_double_sign="0"
  | .app_state.slashing.params.slash_fraction_downtime="0"
  | .consensus.params.block.max_gas="10500000"
  | .app_state.bank.denom_metadata=[{"description":"XRP is the gas token","denom_units":[{"denom":"axrp"},{"denom":"xrp","exponent":18}],"base":"axrp","display":"xrp","name":"XRP","symbol":"XRP"}]
  | .app_state.erc20.native_precompiles=["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]
  | .app_state.erc20.token_pairs=[{"contract_owner":1,"erc20_address":"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","denom":"axrp","enabled":true,"owner_address":"ethm17w0adeg64ky0daxwd2ugyuneellmjgnxcn4sgz"}]' \
  "$GENESIS" > "$TMP_GENESIS" && mv "$TMP_GENESIS" "$GENESIS"

for i in $(seq 0 $((NUM_NODES - 1))); do
  VAL_ADDR=$($EXRPD keys show validator$i -a --keyring-backend $KEYRING --home $HOMEDIR/node$i)
  $EXRPD genesis add-genesis-account $VAL_ADDR 1000000000000000000000000000axrp,1000000000apoa --home $HOMEDIR/node0
  echo "  Added validator$i ($VAL_ADDR)"
done

echo "$FAUCET_MNEMONIC" | $EXRPD keys add devnet-faucet --recover --keyring-backend $KEYRING --algo $KEYALGO --home $HOMEDIR/node0 > /dev/null 2>&1
FAUCET_ADDR=$($EXRPD keys show devnet-faucet -a --keyring-backend $KEYRING --home $HOMEDIR/node0)
$EXRPD genesis add-genesis-account $FAUCET_ADDR 1000000000000000000000000000axrp --home $HOMEDIR/node0
echo "  Added devnet-faucet (EVM: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 => $FAUCET_ADDR)"

# ── Phase 3: Distribute base genesis to all nodes ────────────────────
echo "[3/6] Distributing genesis to all nodes..."
for i in $(seq 1 $((NUM_NODES - 1))); do
  cp "$GENESIS" $HOMEDIR/node$i/config/genesis.json
done

# ── Phase 4: Create gentxs on each node ──────────────────────────────
echo "[4/6] Creating gentxs..."
for i in $(seq 0 $((NUM_NODES - 1))); do
  NODE_HOME=$HOMEDIR/node$i
  $EXRPD genesis gentx validator$i 100000000apoa \
    --gas-prices 0axrp \
    --keyring-backend $KEYRING \
    --home $NODE_HOME \
    --chain-id $CHAINID
  echo "  gentx for validator$i created"

  if [ $i -gt 0 ]; then
    cp $NODE_HOME/config/gentx/* $HOMEDIR/node0/config/gentx/
  fi
done

# ── Phase 5: Collect gentxs and validate ─────────────────────────────
echo "[5/6] Collecting gentxs and validating genesis..."
$EXRPD genesis collect-gentxs --home $HOMEDIR/node0 > /dev/null 2>&1
$EXRPD genesis validate --home $HOMEDIR/node0
echo "  Genesis validated successfully"

for i in $(seq 1 $((NUM_NODES - 1))); do
  cp "$GENESIS" $HOMEDIR/node$i/config/genesis.json
done

# ── Phase 6: Configure networking ────────────────────────────────────
echo "[6/6] Configuring network settings..."
NODE0_ID=$($EXRPD cometbft show-node-id --home $HOMEDIR/node0)
echo "  Node0 ID: $NODE0_ID"

for i in $(seq 0 $((NUM_NODES - 1))); do
    NODE_HOME=$HOMEDIR/node$i

    sed -i 's/127\.0\.0\.1/0.0.0.0/g' $NODE_HOME/config/config.toml
    sed -i 's/localhost/0.0.0.0/g' $NODE_HOME/config/app.toml
    sed -i 's/127\.0\.0\.1/0.0.0.0/g' $NODE_HOME/config/app.toml

    sed -i 's/enable = false/enable = true/g' $NODE_HOME/config/app.toml
    sed -i 's/enabled-unsafe-cors = false/enabled-unsafe-cors = true/g' $NODE_HOME/config/app.toml
    sed -i 's/cors_allowed_origins = \[\]/cors_allowed_origins = ["*"]/g' $NODE_HOME/config/config.toml

    if [ $i -gt 0 ]; then
      sed -i "s/persistent_peers = \"\"/persistent_peers = \"${NODE0_ID}@xrplevm-node-0:26656\"/g" $NODE_HOME/config/config.toml
    fi

    sed -i 's/timeout_commit = "5s"/timeout_commit = "1s"/g' $NODE_HOME/config/config.toml
done

echo "✅ Setup script finished successfully."
SETUP_EOF

chmod +x .testnet/setup.sh
docker run --rm -v $(pwd):/code -w /code golang:1.23.8 bash /code/.testnet/setup.sh

echo "✅ Initialization complete!"
echo "Next steps:"
echo "  1. Start network: ./start-multinode.sh"
echo "  2. Check status:  docker compose ps"
echo "  3. Stop network:  ./stop-multinode.sh"
echo ""
