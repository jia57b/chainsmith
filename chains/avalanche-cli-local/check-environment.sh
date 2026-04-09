#!/bin/bash
# check-environment.sh — Validate that the local Avalanche environment is ready for ChainSmith tests
#
# Usage:
#   chmod +x check-environment.sh
#   ./check-environment.sh
#
# Optional environment variables:
#   AVALANCHE_CHAIN_NAME   Blockchain name (default: chainsmithavalanche)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
METADATA_JSON="$("${SCRIPT_DIR}/extract-metadata.sh")"
SIGNATURE_AGGREGATOR_CONFIG="$(signature_aggregator_config_file)"
SIGNATURE_AGGREGATOR_PROCESS="$(signature_aggregator_process_file)"
SIGNATURE_AGGREGATOR_LOG="$(signature_aggregator_log_file)"
SIGNATURE_AGGREGATOR_API_PORT="$(signature_aggregator_api_port || true)"
SIGNATURE_AGGREGATOR_PID="$(signature_aggregator_pid || true)"
if [ -n "${SIGNATURE_AGGREGATOR_API_PORT}" ] && is_port_listening "${SIGNATURE_AGGREGATOR_API_PORT}"; then
    SIGNATURE_AGGREGATOR_LISTENING="true"
else
    SIGNATURE_AGGREGATOR_LISTENING="false"
fi

export METADATA_JSON
export SIGNATURE_AGGREGATOR_CONFIG
export SIGNATURE_AGGREGATOR_PROCESS
export SIGNATURE_AGGREGATOR_LOG
export SIGNATURE_AGGREGATOR_API_PORT
export SIGNATURE_AGGREGATOR_PID
export SIGNATURE_AGGREGATOR_LISTENING

node <<'NODE'
const metadata = JSON.parse(process.env.METADATA_JSON);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`✅ ${message}`);
}

console.log('============================================');
console.log('  Avalanche Local Environment Check');
console.log('============================================');
console.log('');
console.log(`Chain Name:        ${metadata.chainName}`);
console.log(`Network Dir:       ${metadata.networkDir}`);
console.log(`Local Chain Dir:   ${metadata.localChainDir}`);
console.log(`Network ID:        ${metadata.networkId ?? 'N/A'}`);
console.log(`Network Name:      ${metadata.networkName ?? 'N/A'}`);
console.log(`Chain ID:          ${metadata.chainId ?? 'N/A'}`);
console.log(`Subnet ID:         ${metadata.subnetId ?? 'N/A'}`);
console.log(`Blockchain ID:     ${metadata.blockchainId ?? 'N/A'}`);
console.log(`Primary Nodes:     ${metadata.primaryNodes.length}`);
console.log(`L1 Nodes:          ${metadata.l1Nodes.length}`);
console.log(`SigAgg Config:     ${process.env.SIGNATURE_AGGREGATOR_CONFIG ?? 'N/A'}`);
console.log(`SigAgg PID:        ${process.env.SIGNATURE_AGGREGATOR_PID ?? 'N/A'}`);
console.log(`SigAgg API Port:   ${process.env.SIGNATURE_AGGREGATOR_API_PORT ?? 'N/A'}`);
console.log(`SigAgg Listening:  ${process.env.SIGNATURE_AGGREGATOR_LISTENING}`);
console.log('');

if (!metadata.networkDir) fail('localNetworks.json does not point to an active primary network directory');
if (!metadata.localChainDir) fail('local chain directory is missing');
if (!metadata.subnetId) fail('subnetId could not be discovered');
if (!metadata.blockchainId) fail('blockchainId could not be discovered');
if (!metadata.primaryNodes.length) fail('no primary nodes were discovered');
if (!metadata.l1Nodes.length) fail('no L1 nodes were discovered');
if (!metadata.representativeL1Node?.uri) fail('representative L1 node URI is missing');
if (!metadata.representativeL1Node?.executeLayerHttpRpcUrl) fail('representative L1 RPC URL is missing');
if (metadata.health?.healthy !== true) fail('representative L1 node is not healthy');
if (!process.env.SIGNATURE_AGGREGATOR_CONFIG) fail('signature aggregator config path is missing');
if (process.env.SIGNATURE_AGGREGATOR_LISTENING !== 'true') {
  fail(`signature aggregator is not listening on port ${process.env.SIGNATURE_AGGREGATOR_API_PORT ?? 'unknown'}`);
}

ok('metadata discovery succeeded');
ok(`representative L1 node: ${metadata.representativeL1Node.nodeId}`);
ok(`representative RPC URL: ${metadata.representativeL1Node.executeLayerHttpRpcUrl}`);
ok(`health API reports healthy=true`);
ok(`signature aggregator is listening on port ${process.env.SIGNATURE_AGGREGATOR_API_PORT}`);

const bootstrapped = Array.isArray(metadata.health?.checks?.bootstrapped?.message);
if (!bootstrapped) {
  fail('health API does not report bootstrapped state');
}
ok('bootstrapped check is present');

console.log('');
console.log('Primary Nodes:');
for (const node of metadata.primaryNodes) {
  console.log(`  - ${node.nodeId} @ ${node.uri ?? 'N/A'}`);
}

console.log('');
console.log('L1 Nodes:');
for (const node of metadata.l1Nodes) {
  console.log(`  - ${node.nodeId} @ ${node.uri ?? 'N/A'} (track-subnets=${node.trackSubnets ?? 'N/A'})`);
}

console.log('');
console.log('Environment is ready for ChainSmith tests.');
NODE
