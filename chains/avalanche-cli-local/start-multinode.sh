#!/bin/bash
# start-multinode.sh — Deploy an Avalanche Subnet-EVM L1 to a local multi-node network
#
# Usage:
#   chmod +x start-multinode.sh
#   ./start-multinode.sh
#
# Optional environment variables:
#   AVALANCHE_CHAIN_NAME   Blockchain name to deploy (default: chainsmithavalanche)
#   AVALANCHE_OUTPUT_DIR   Directory for deploy logs (default: ./output)
#   AVALANCHE_FORCE_DEPLOY When "true", force redeploy instead of attempting recovery
#
# Notes:
#   - Avalanche local deployments are multi-node, not single-node.
#   - `avalanche blockchain deploy <name> --local` will deploy to a local validator network.
#   - On first use, run ./init-multinode.sh first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"
CHAIN_NAME="${AVALANCHE_CHAIN_NAME:-chainsmithavalanche}"
OUTPUT_DIR="${AVALANCHE_OUTPUT_DIR:-${SCRIPT_DIR}/output}"
FORCE_DEPLOY="${AVALANCHE_FORCE_DEPLOY:-false}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEPLOY_LOG="${OUTPUT_DIR}/deploy-${CHAIN_NAME}-${TIMESTAMP}.log"

mkdir -p "${OUTPUT_DIR}"

extract_summary() {
    local log_file="$1"

    echo ""
    echo "📌 Extracted endpoints from deploy log:"

    local rpc_lines
    rpc_lines="$(grep -Eo 'http://127\.0\.0\.1:[0-9]+/ext/bc/[^ ]+/rpc' "${log_file}" | sort -u || true)"
    if [ -n "${rpc_lines}" ]; then
        echo "${rpc_lines}" | sed 's/^/   - /'
    else
        echo "   - No RPC URL matched automatically. Check the full log."
    fi

    local blockchain_ids
    blockchain_ids="$(grep -Eo '[Bb]lockchain[Ii][Dd][^[:alnum:]]+[A-Za-z0-9]+' "${log_file}" | sed -E 's/.*[^A-Za-z0-9]([A-Za-z0-9]+)$/\1/' | sort -u || true)"
    if [ -n "${blockchain_ids}" ]; then
        echo ""
        echo "📌 Candidate blockchain IDs:"
        echo "${blockchain_ids}" | sed 's/^/   - /'
    fi
}

CLI_BIN="$(resolve_avalanche_cli)"
LOCAL_CHAIN_DIR="${HOME}/.avalanche-cli/local/${CHAIN_NAME}-local-node-local-network"
LOCAL_NETWORKS_FILE="${HOME}/.avalanche-cli/localNetworks.json"

attempt_recovery() {
    echo "♻️ Existing local Avalanche deployment detected."
    echo "   Attempting recovery with: ${CLI_BIN} network start"
    echo ""

    if "${CLI_BIN}" network start 2>&1 | tee "${DEPLOY_LOG}"; then
        if ! ensure_signature_aggregator_running; then
            echo ""
            echo "⚠️ Signature Aggregator is not healthy after 'network start'."
            echo "   Falling back to deploy flow..."
            echo ""
            return 1
        fi

        if [ -x "${SCRIPT_DIR}/check-environment.sh" ] && "${SCRIPT_DIR}/check-environment.sh" >/dev/null 2>&1; then
            echo ""
            echo "✅ Existing local Avalanche network restarted."
            echo "📝 Start log:"
            echo "   ${DEPLOY_LOG}"
            return 0
        fi

        echo ""
        echo "⚠️ 'network start' returned success but the environment check did not pass."
        echo "   Falling back to deploy flow..."
        echo ""
        return 1
    fi

    if grep -q "node is already running" "${DEPLOY_LOG}" && [ -x "${SCRIPT_DIR}/check-environment.sh" ]; then
        if ! ensure_signature_aggregator_running; then
            echo ""
            echo "⚠️ Signature Aggregator is not healthy while the network is already running."
            echo "   Falling back to deploy flow..."
            echo ""
            return 1
        fi

        if "${SCRIPT_DIR}/check-environment.sh" >/dev/null 2>&1; then
            echo ""
            echo "✅ Local Avalanche environment is already running and healthy."
            echo "📝 Start log:"
            echo "   ${DEPLOY_LOG}"
            return 0
        fi
    fi

    echo ""
    echo "⚠️ Recovery via 'network start' failed. Falling back to deploy flow..."
    echo ""
    return 1
}

echo "============================================"
echo "  Avalanche Local L1 Start"
echo "  CLI: ${CLI_BIN}"
echo "  Blockchain Name: ${CHAIN_NAME}"
echo "  Output Dir: ${OUTPUT_DIR}"
echo "============================================"
echo ""
echo "This deploys to a local multi-node Avalanche network."
echo "If the blockchain definition does not exist yet, run:"
echo "   ./init-multinode.sh"
echo ""
if [ "${FORCE_DEPLOY}" != "true" ] && [ -d "${LOCAL_CHAIN_DIR}" ] && [ -f "${LOCAL_NETWORKS_FILE}" ]; then
    if attempt_recovery; then
        echo ""
        echo "Next steps for ChainSmith:"
        echo "  1. ./check-environment.sh"
        echo "  2. ./refresh-config.sh"
        echo "  3. Run:"
        echo "     export CHAIN_ENV=avalanche-local"
        echo "     pnpm test:avalanche:platform"
        echo "     pnpm test:basic"
        echo "     pnpm test:rpc:evm"
        echo "     pnpm test:load:stress"
        echo ""
        exit 0
    fi
fi

echo "🚀 Deploying ${CHAIN_NAME} to local network..."
echo "📝 Full output will be saved to:"
echo "   ${DEPLOY_LOG}"
echo ""

"${CLI_BIN}" blockchain deploy "${CHAIN_NAME}" --local | tee "${DEPLOY_LOG}"

echo ""
if ! ensure_signature_aggregator_running; then
    echo "❌ Signature Aggregator is not healthy after deploy."
    echo "   Check ${SIGNATURE_AGGREGATOR_RUNTIME_DIR} for details."
    exit 1
fi

echo ""
echo "✅ Local Avalanche deployment finished."
echo "📝 Deploy log:"
echo "   ${DEPLOY_LOG}"

extract_summary "${DEPLOY_LOG}"

echo ""
echo "Next steps for ChainSmith:"
echo "  1. ./check-environment.sh"
echo "  2. ./refresh-config.sh"
echo "  3. Run:"
echo "     export CHAIN_ENV=avalanche-local"
echo "     pnpm test:avalanche:platform"
echo "     pnpm test:basic"
echo "     pnpm test:rpc:evm"
echo "     pnpm test:load:stress"
echo ""
