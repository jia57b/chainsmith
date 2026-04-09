#!/bin/bash
# extract-metadata.sh — Discover local Avalanche CLI metadata for ChainSmith test preparation
#
# Purpose:
#   Read Avalanche CLI local runtime state and emit the metadata needed by ChainSmith tests.
#   This script does NOT run tests and does NOT deploy networks. It only discovers metadata.
#
# Usage:
#   chmod +x extract-metadata.sh
#   ./extract-metadata.sh
#
# Optional environment variables:
#   AVALANCHE_CHAIN_NAME            Blockchain name (default: chainsmithavalanche)
#   AVALANCHE_FOUNDER_ADDRESS       Override founder address in generated metadata
#   AVALANCHE_FOUNDER_PRIVATE_KEY   Override founder private key in generated metadata

set -euo pipefail

CHAIN_NAME="${AVALANCHE_CHAIN_NAME:-chainsmithavalanche}"
DEFAULT_FOUNDER_ADDRESS="${AVALANCHE_FOUNDER_ADDRESS:-0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC}"
DEFAULT_FOUNDER_PRIVATE_KEY="${AVALANCHE_FOUNDER_PRIVATE_KEY:-0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027}"

LOCAL_NETWORKS_FILE="${HOME}/.avalanche-cli/localNetworks.json"
LOCAL_CHAIN_DIR="${HOME}/.avalanche-cli/local/${CHAIN_NAME}-local-node-local-network"

if [ ! -f "${LOCAL_NETWORKS_FILE}" ]; then
    echo "❌ ${LOCAL_NETWORKS_FILE} not found. Start a local Avalanche network first." >&2
    exit 1
fi

if [ ! -d "${LOCAL_CHAIN_DIR}" ]; then
    echo "❌ ${LOCAL_CHAIN_DIR} not found. Deploy the local Avalanche L1 first." >&2
    exit 1
fi

export CHAIN_NAME
export DEFAULT_FOUNDER_ADDRESS
export DEFAULT_FOUNDER_PRIVATE_KEY
export LOCAL_NETWORKS_FILE
export LOCAL_CHAIN_DIR

node <<'NODE'
const fs = require('fs');
const path = require('path');

async function fetchJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listNodeDirs(baseDir) {
  if (!fs.existsSync(baseDir)) {
    return [];
  }
  return fs
    .readdirSync(baseDir)
    .filter(entry => entry.startsWith('NodeID-'))
    .map(entry => path.join(baseDir, entry))
    .filter(entry => fs.statSync(entry).isDirectory());
}

function parseNode(nodeDir) {
  const nodeId = path.basename(nodeDir);
  const processPath = path.join(nodeDir, 'process.json');
  const flagsPath = path.join(nodeDir, 'flags.json');
  const process = fs.existsSync(processPath) ? readJson(processPath) : {};
  const flags = fs.existsSync(flagsPath) ? readJson(flagsPath) : {};

  return {
    nodeId,
    nodeDir,
    uri: process.uri || null,
    stakingAddress: process.stakingAddress || null,
    httpPort: flags['http-port'] ? Number(flags['http-port']) : null,
    stakingPort: flags['staking-port'] ? Number(flags['staking-port']) : null,
    trackSubnets: flags['track-subnets'] || null,
    infoApiUrl: process.uri ? `${process.uri}/ext/info` : null,
    healthApiUrl: process.uri ? `${process.uri}/ext/health` : null,
    controlPlaneRpcUrl: process.uri ? `${process.uri}/ext/bc/P` : null,
  };
}

function discoverBlockchainId(l1NodeDir) {
  const logsDir = path.join(l1NodeDir, 'logs');
  if (!fs.existsSync(logsDir)) {
    return null;
  }

  const candidates = fs
    .readdirSync(logsDir)
    .filter(name => name.endsWith('.log'))
    .filter(name => !['main.log', 'P.log', 'vm-factory.log'].includes(name))
    .map(name => name.replace(/\.log$/, ''))
    .map(name => name.replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d+$/, ''));

  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates[0] || null;
}

async function main() {
  const chainName = process.env.CHAIN_NAME;
  const founderAddress = process.env.DEFAULT_FOUNDER_ADDRESS;
  const founderPrivateKey = process.env.DEFAULT_FOUNDER_PRIVATE_KEY;
  const localNetworksFile = process.env.LOCAL_NETWORKS_FILE;
  const localChainDir = process.env.LOCAL_CHAIN_DIR;

  const localNetworks = readJson(localNetworksFile);
  const networkDir = localNetworks.networkDir;
  const sidecarPath = path.join(process.env.HOME, '.avalanche-cli', 'subnets', chainName, 'sidecar.json');
  const sidecar = fs.existsSync(sidecarPath) ? readJson(sidecarPath) : {};

  const primaryNodeDirs = listNodeDirs(networkDir);
  const l1NodeDirs = listNodeDirs(localChainDir);

  const primaryNodes = primaryNodeDirs.map(parseNode);
  const l1Nodes = l1NodeDirs.map(parseNode);

  const representativeL1Node = l1Nodes[0] || null;
  const blockchainId = representativeL1Node ? discoverBlockchainId(representativeL1Node.nodeDir) : null;
  const subnetId = representativeL1Node?.trackSubnets || null;

  const localConfigPath = path.join(localChainDir, 'config.json');
  const localConfig = fs.existsSync(localConfigPath) ? readJson(localConfigPath) : {};
  const networkId = localConfig.networkID || null;

  let chainId = null;
  let networkName = null;
  let l1Health = null;

  if (representativeL1Node?.uri) {
    const infoUrl = `${representativeL1Node.uri}/ext/info`;
    const healthUrl = `${representativeL1Node.uri}/ext/health`;

    const [infoNetworkName, healthResponse] = await Promise.all([
      fetchJson(infoUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'info.getNetworkName',
        params: {},
      }),
      fetchJson(healthUrl, null),
    ]);

    networkName = infoNetworkName?.result?.networkName || null;
    l1Health = healthResponse;
  }

  if (representativeL1Node?.uri && blockchainId) {
    const rpcUrl = `${representativeL1Node.uri}/ext/bc/${blockchainId}/rpc`;
    const chainIdResponse = await fetchJson(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_chainId',
      params: [],
    });
    chainId = chainIdResponse?.result ? parseInt(chainIdResponse.result, 16) : null;

    representativeL1Node.executeLayerHttpRpcUrl = rpcUrl;
  }

  for (const node of l1Nodes) {
    if (node.uri && blockchainId) {
      node.executeLayerHttpRpcUrl = `${node.uri}/ext/bc/${blockchainId}/rpc`;
    } else {
      node.executeLayerHttpRpcUrl = null;
    }
  }

  const metadata = {
    generatedAt: new Date().toISOString(),
    chainName,
    sidecarPath: fs.existsSync(sidecarPath) ? sidecarPath : null,
    networkDir,
    localChainDir,
    networkId,
    networkName,
    chainId,
    subnetId,
    blockchainId,
    validatorManagementType: sidecar.ValidatorManagement || null,
    validatorManagerAddress: sidecar.Networks?.['Local Network']?.ValidatorManagerAddress || null,
    validatorManagerRpcEndpoint: sidecar.Networks?.['Local Network']?.ValidatorManagerRPCEndpoint || null,
    specializedValidatorManagerAddress: sidecar.Networks?.['Local Network']?.SpecializedValidatorManagerAddress || null,
    changeOwnerAddress: sidecar.Networks?.['Local Network']?.BootstrapValidators?.[0]?.ChangeOwnerAddr || null,
    validatorManagerOwner: sidecar.ValidatorManagerOwner || null,
    proxyContractOwner: sidecar.ProxyContractOwner || null,
    founderWallet: {
      address: founderAddress,
      privateKey: founderPrivateKey,
    },
    primaryNodes,
    l1Nodes,
    representativeL1Node,
    health: l1Health,
  };

  console.log(JSON.stringify(metadata, null, 2));
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});
NODE
