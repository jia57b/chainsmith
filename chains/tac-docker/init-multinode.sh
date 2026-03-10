#!/bin/bash
set -e

if [ ! -d "tacchain" ]; then
  echo "Cloning tacchain repository..."
  git clone --depth 1 https://github.com/TacBuild/tacchain.git tacchain
fi

echo "Building tacchain Docker image..."
cd tacchain
docker build -t tacchain:local .
cd ..

echo "Initializing 4-node localnet..."
docker run --rm -v $(pwd)/tacchain:/code -w /code tacchain:local bash -c "
apt-get update && apt-get install -y jq bc
cd contrib/localnet
# Provide y to overwrite existing testnet
echo y | HOMEDIR=/code/.testnet ./init-multi-node.sh

# Inject ChainSmith test wallet (Hardhat Account #0) into genesis
# EVM: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# TAC (bech32): tac17w0adeg64ky0daxwd2ugyuneellmjgnxxhfnn2
FOUNDER_TAC_ADDR=\"tac17w0adeg64ky0daxwd2ugyuneellmjgnxxhfnn2\"
FOUNDER_BALANCE=\"10000000000000000000000000utac\"

tacchaind genesis add-genesis-account \$FOUNDER_TAC_ADDR \$FOUNDER_BALANCE --home /code/.testnet/node0

# Distribute genesis to all nodes
GENESIS=/code/.testnet/node0/config/genesis.json
cp \$GENESIS /code/.testnet/node1/config/genesis.json
cp \$GENESIS /code/.testnet/node2/config/genesis.json
cp \$GENESIS /code/.testnet/node3/config/genesis.json

# Change bind addresses from 127.0.0.1 to 0.0.0.0 to expose ports in Docker
for i in 0 1 2 3; do
    sed -i 's/127\.0\.0\.1/0.0.0.0/g' /code/.testnet/node\$i/config/config.toml
    sed -i 's/localhost/0.0.0.0/g' /code/.testnet/node\$i/config/app.toml
    sed -i 's/127\.0\.0\.1/0.0.0.0/g' /code/.testnet/node\$i/config/app.toml
    
    # Fix persistent peers to use container names instead of 0.0.0.0
    sed -i 's/0\.0\.0\.0:45110/tac-node-0:45110/g' /code/.testnet/node\$i/config/config.toml
    sed -i 's/0\.0\.0\.0:45120/tac-node-1:45120/g' /code/.testnet/node\$i/config/config.toml
    sed -i 's/0\.0\.0\.0:45130/tac-node-2:45130/g' /code/.testnet/node\$i/config/config.toml
    sed -i 's/0\.0\.0\.0:45140/tac-node-3:45140/g' /code/.testnet/node\$i/config/config.toml

    # CORS settings to allow API access
    sed -i 's/enabled-unsafe-cors = false/enabled-unsafe-cors = true/g' /code/.testnet/node\$i/config/app.toml
    sed -i 's/cors_allowed_origins = \[\]/cors_allowed_origins = [\"*\"]/g' /code/.testnet/node\$i/config/config.toml
done
"

echo "Initialization complete!"
echo "Next steps:"
echo "  1. Start network: ./start-multinode.sh"
echo "  2. Check status:  docker compose ps"
echo "  3. Stop network:  ./stop-multinode.sh"
echo ""