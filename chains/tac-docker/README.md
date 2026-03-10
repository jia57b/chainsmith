# TAC Local Multi-Validator Environment (Docker)

This folder contains scripts to set up a 4-node local testnet for the TAC chain using Docker. It builds the `tacchain` node from source and runs it in a containerized environment to facilitate local testing and development.

## Prerequisites

- Docker & Docker Compose
- `jq` and `bc` (Optional for your host machine, as the script runs them inside Docker)

## Usage

### 1. Initialize and Start the Localnet

Run the initialization script. It will automatically build the TAC chain Docker image, generate validator configurations, inject a funded test account, and start the 4 nodes via `docker compose`.

```bash
./init-multinode.sh
```

### 2. Stop the Localnet

To stop the running nodes:

```bash
./stop-multinode.sh
```

### 3. Start the Localnet (if already initialized)

If you have already initialized the network and just want to start the containers again:

```bash
./start-multinode.sh
```

### Node Configuration

The localnet spins up 4 validator nodes. They are mapped to the following ports on your host machine:

- **Validator 1 (`tac-node-0`)**:

    - P2P: `45110`
    - Cosmos RPC: `45111`
    - Cosmos REST API: `45112`
    - EVM JSON-RPC: `45118`

- **Validator 2 (`tac-node-1`)**:

    - P2P: `45120`
    - Cosmos RPC: `45121`
    - Cosmos REST API: `45122`
    - EVM JSON-RPC: `45128`

- **Validator 3 (`tac-node-2`)**:

    - P2P: `45130`
    - Cosmos RPC: `45131`
    - Cosmos REST API: `45132`
    - EVM JSON-RPC: `45138`

- **Validator 4 (`tac-node-3`)**:
    - P2P: `45140`
    - Cosmos RPC: `45141`
    - Cosmos REST API: `45142`
    - EVM JSON-RPC: `45148`

### Test Accounts

The following Hardhat test account `#0` is automatically pre-funded with tokens (10M utac):

- **Address:** `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
- **Private Key:** `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
