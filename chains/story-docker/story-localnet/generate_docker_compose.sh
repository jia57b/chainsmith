#!/bin/bash

set -e

# Nodes and their corresponding base IPs
NODE_NAMES=("bootnode1" "validator1" "validator2" "validator3" "validator4")
NODE_BASE_IPS=("10.0.0.10" "10.0.0.20" "10.0.0.22" "10.0.0.24" "10.0.0.26")

GETH_PORTS=(18545 28545 38545 48545 58545)
NODE_RPC_PORTS=(16657 36657 46657 56657 60657)
NODE_P2P_PORTS=(16656 36656 46656 56656 60656)
NODE_REST_PORTS=(11317 21317 31317 41317 51317)

# Template content for the Docker Compose file with placeholders for replacement
generate_compose_file() {
  local NODE_NAME=$1
  local BASE_IP=$2
  local GETH_IP=$BASE_IP
  local NODE_IP=$(echo $BASE_IP | awk -F '.' '{print $1 "." $2 "." $3 "." $4+1}')
  
  local GETH_PORT=$3
  local NODE_RPC_PORT=$4
  local NODE_P2P_PORT=$5
  local NODE_REST_PORT=$6

  # Bootnode: don't expose EVM RPC and RPC ports - per Consensus-Basic-02
  local GETH_PORTS_BLOCK NODE_PORTS_BLOCK
  if [[ "$NODE_NAME" == "bootnode1" ]]; then
    GETH_PORTS_BLOCK="    # EVM RPC (8545) not exposed - bootnode should only serve P2P
"
    NODE_PORTS_BLOCK="    # RPC (26657) not exposed - bootnode should only serve P2P
    ports:
      - \"${NODE_REST_PORT}:1317\"
      - \"${NODE_P2P_PORT}:26656\"
"
  else
    GETH_PORTS_BLOCK="    ports:
      - \"${GETH_PORT}:8545\"
"
    NODE_PORTS_BLOCK="    ports:
      - \"${NODE_RPC_PORT}:26657\"
      - \"${NODE_REST_PORT}:1317\"
      - \"${NODE_P2P_PORT}:26656\"
"
  fi

  cat <<EOF > "./docker-compose-${NODE_NAME}.yml"
x-logging: &logging
  logging:
    driver: json-file
    options:
      max-size: 10m
      max-file: '3'

services:
  ${NODE_NAME}-common-init:
    container_name: ${NODE_NAME}-common-init
    image: alpine
    command: >
      sh -c "apk add --no-cache openssl && openssl rand -hex 32 > /root/.story/geth/data/jwtsecret"
    volumes:
      - db-${NODE_NAME}-geth-data:/root/.story/geth/data

  ${NODE_NAME}-geth-init:
    container_name: ${NODE_NAME}-geth-init
    image: story-geth:localnet
    build:
      context: ../story-geth
      dockerfile: ../story-localnet/Dockerfile.story-geth
    entrypoint: ''
    command: >
      /bin/sh -c "/usr/local/bin/geth --state.scheme=hash init --datadir=/root/.story/geth/data /root/.story/geth/config/genesis.json"
    volumes:
      - ./config/story/genesis-geth.json:/root/.story/geth/config/genesis.json:ro
      - db-${NODE_NAME}-geth-data:/root/.story/geth/data
    depends_on:
      - ${NODE_NAME}-common-init

  ${NODE_NAME}-geth:
    container_name: ${NODE_NAME}-geth
    restart: unless-stopped
    stop_grace_period: 50s
    image: story-geth:localnet
    build:
      context: ../story-geth
      dockerfile: ../story-localnet/Dockerfile.story-geth
    entrypoint: >
      sh -c 'sleep 10 && geth "\$\$@"'
    command:
      - --datadir=/root/.story/geth/data
      - --config=/root/.story/geth/config/geth.toml
      - --nodekey=/root/.story/geth/config/nodekey
      - --authrpc.addr=0.0.0.0
      - --authrpc.port=8551
      - --authrpc.vhosts=*
      - --authrpc.jwtsecret=/root/.story/geth/data/jwtsecret
      - --http
      - --http.vhosts=*
      - --http.addr=0.0.0.0
      - --http.port=8545
      - --http.api=web3,eth,txpool,net,engine,debug,admin
      - --metrics
      - --metrics.addr=0.0.0.0
      - --metrics.port=6060
      - --port=30303
      - --discovery.port=30303
      - --nat=extip:${GETH_IP}
${GETH_PORTS_BLOCK}    volumes:
      - ./config/story/${NODE_NAME}/geth:/root/.story/geth/config
      - db-${NODE_NAME}-geth-data:/root/.story/geth/data
      - db-${NODE_NAME}-node-data:/root/.story/story/data
    networks:
      story-localnet:
        ipv4_address: ${GETH_IP}
    depends_on:
      - ${NODE_NAME}-geth-init
    <<: *logging

  ${NODE_NAME}-node-init:
    container_name: ${NODE_NAME}-node-init
    image: alpine
    command: >
      sh -c "echo '{\"height\": \"0\", \"round\": 0, \"step\": 0}' > /root/.story/story/data/priv_validator_state.json"
    volumes:
      - db-${NODE_NAME}-node-data:/root/.story/story/data
    depends_on:
      - ${NODE_NAME}-common-init

  ${NODE_NAME}-node:
    container_name: ${NODE_NAME}-node
    restart: unless-stopped
    stop_grace_period: 50s
    image: story-node:localnet
    build:
      context: ../story
      dockerfile: ../story-localnet/Dockerfile.story-node
    entrypoint: >
      sh -c 'sleep 10 && story run "\$\$@"'
    command:
      - --api-enable
      - --api-address=0.0.0.0:1317
      - --engine-jwt-file=/root/.story/geth/data/jwtsecret
      - --engine-endpoint=http://${NODE_NAME}-geth:8551
      - --log_level=debug
    volumes:
      - ./config/story/genesis-node.json:/root/.story/story/config/genesis.json
      - ./config/story/${NODE_NAME}/story/config.toml:/root/.story/story/config/config.toml
      - ./config/story/${NODE_NAME}/story/node_key.json:/root/.story/story/config/node_key.json
      - ./config/story/${NODE_NAME}/story/priv_validator_key.json:/root/.story/story/config/priv_validator_key.json
      - ./config/story/${NODE_NAME}/story/story.toml:/root/.story/story/config/story.toml
      - db-${NODE_NAME}-geth-data:/root/.story/geth/data
      - db-${NODE_NAME}-node-data:/root/.story/story/data
${NODE_PORTS_BLOCK}    networks:
      story-localnet:
        ipv4_address: ${NODE_IP}
    depends_on:
      - ${NODE_NAME}-geth
      - ${NODE_NAME}-node-init
    <<: *logging

volumes:
  db-${NODE_NAME}-geth-data:
  db-${NODE_NAME}-node-data:

networks:
  story-localnet:
    driver: bridge
    ipam:
      config:
        - subnet: 10.0.0.0/16
EOF

  echo "Generated docker-compose-${NODE_NAME}.yml with Geth IP ${GETH_IP} and Node IP ${NODE_IP}"
}

# Loop through nodes and generate their respective compose files
for i in "${!NODE_NAMES[@]}"; do
  generate_compose_file "${NODE_NAMES[$i]}" "${NODE_BASE_IPS[$i]}" "${GETH_PORTS[$i]}" "${NODE_RPC_PORTS[$i]}" "${NODE_P2P_PORTS[$i]}" "${NODE_REST_PORTS[$i]}"
done
