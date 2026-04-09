#!/bin/bash
# setup-avalanche-self-hosted-runner.sh — Prepare a Linux self-hosted runner
# machine for the Avalanche workflows in this repository.
#
# Scope:
#   - Installs OS packages required by the workflow and helper scripts
#   - Installs Avalanche CLI into $HOME/bin
#   - Verifies avalanchego / signature-aggregator download paths
#   - Optionally bootstraps the ChainSmith Avalanche definition
#
# Non-scope:
#   - Does not register the GitHub Actions runner
#   - Does not configure systemd for the runner service
#   - Does not start the local Avalanche network
#
# Usage:
#   ./scripts/setup-avalanche-self-hosted-runner.sh
#   ./scripts/setup-avalanche-self-hosted-runner.sh --bootstrap-definition
#   ./scripts/setup-avalanche-self-hosted-runner.sh --skip-packages
#
# Optional environment variables:
#   AVALANCHE_CLI_VERSION          Avalanche CLI tag to install (default: v1.4.0)
#   AVALANCHE_CHAIN_NAME           Avalanche chain name (default: chainsmithavalanche)
#   AVALANCHE_BOOTSTRAP_CHAIN_ID   Chain ID used by bootstrap script (default inherited)
#   AVALANCHE_BOOTSTRAP_TOKEN      Token symbol used by bootstrap script (default inherited)
#   AVALANCHE_BOOTSTRAP_OWNER_KEY  Stored key used by bootstrap script (default inherited)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

AVALANCHE_CLI_VERSION="${AVALANCHE_CLI_VERSION:-v1.4.0}"
AVALANCHE_CHAIN_NAME="${AVALANCHE_CHAIN_NAME:-chainsmithavalanche}"

BOOTSTRAP_DEFINITION="false"
SKIP_PACKAGES="false"
SKIP_CLI_INSTALL="false"

log() {
    printf '%s\n' "$*"
}

usage() {
    cat <<'EOF'
Usage: ./scripts/setup-avalanche-self-hosted-runner.sh [options]

Options:
  --bootstrap-definition  Run the repository bootstrap script after installing Avalanche CLI
  --skip-packages         Skip OS package installation
  --skip-cli-install      Skip Avalanche CLI installation
  -h, --help              Show this help text
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --bootstrap-definition)
            BOOTSTRAP_DEFINITION="true"
            ;;
        --skip-packages)
            SKIP_PACKAGES="true"
            ;;
        --skip-cli-install)
            SKIP_CLI_INSTALL="true"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
    shift
done

require_not_root() {
    if [ "$(id -u)" -eq 0 ]; then
        log "❌ Run this script as the runner user, not root." >&2
        exit 1
    fi
}

detect_os() {
    if [ ! -r /etc/os-release ]; then
        log "❌ Cannot detect operating system: /etc/os-release is missing." >&2
        exit 1
    fi

    # shellcheck disable=SC1091
    . /etc/os-release

    OS_ID="${ID:-unknown}"
    OS_ID_LIKE="${ID_LIKE:-}"
}

install_packages_debian() {
    sudo apt-get update
    sudo apt-get install -y \
        bash \
        build-essential \
        ca-certificates \
        curl \
        git \
        jq \
        lsof \
        python3 \
        python3-pip \
        ruby \
        tar \
        unzip
}

install_packages_amazon_linux() {
    sudo dnf install -y \
        bash \
        curl \
        gcc \
        gcc-c++ \
        git \
        jq \
        lsof \
        make \
        python3 \
        python3-pip \
        ruby \
        tar \
        unzip
}

install_packages() {
    case "${OS_ID}" in
        ubuntu|debian)
            install_packages_debian
            ;;
        amzn)
            install_packages_amazon_linux
            ;;
        *)
            case "${OS_ID_LIKE}" in
                *debian*)
                    install_packages_debian
                    ;;
                *rhel*|*fedora*)
                    install_packages_amazon_linux
                    ;;
                *)
                    log "❌ Unsupported Linux distribution: ${OS_ID} (${OS_ID_LIKE})" >&2
                    log "   Install these packages manually: curl git jq lsof python3 ruby tar unzip build tools" >&2
                    exit 1
                    ;;
            esac
            ;;
    esac
}

install_avalanche_cli() {
    mkdir -p "${HOME}/bin"

    log "⬇️ Installing Avalanche CLI ${AVALANCHE_CLI_VERSION} into ${HOME}/bin ..."
    curl -fsSL https://raw.githubusercontent.com/ava-labs/avalanche-cli/main/scripts/install.sh | \
        VERSION="${AVALANCHE_CLI_VERSION}" BINDIR="${HOME}/bin" sh -s

    if [ ! -x "${HOME}/bin/avalanche" ]; then
        log "❌ Avalanche CLI install did not produce ${HOME}/bin/avalanche" >&2
        exit 1
    fi
}

ensure_shell_profile_path() {
    local shell_rc
    shell_rc="${HOME}/.bashrc"

    if [ "${SHELL:-}" = "/bin/zsh" ] || [ "${SHELL:-}" = "/usr/bin/zsh" ]; then
        shell_rc="${HOME}/.zshrc"
    fi

    if [ ! -f "${shell_rc}" ]; then
        touch "${shell_rc}"
    fi

    if ! grep -Fq 'export PATH="$HOME/bin:$PATH"' "${shell_rc}"; then
        printf '\nexport PATH="$HOME/bin:$PATH"\n' >> "${shell_rc}"
        log "✅ Added \$HOME/bin to ${shell_rc}"
    else
        log "✅ \$HOME/bin already present in ${shell_rc}"
    fi
}

verify_repo_scripts() {
    local common_sh
    common_sh="${PROJECT_ROOT}/chains/avalanche-cli-local/common.sh"
    if [ ! -f "${common_sh}" ]; then
        log "❌ Repository helper not found: ${common_sh}" >&2
        exit 1
    fi

    # shellcheck disable=SC1090
    source "${common_sh}"

    local cli_bin
    cli_bin="$(resolve_avalanche_cli)"
    log "✅ Avalanche CLI resolved: ${cli_bin}"

    if resolve_avalanchego_bin >/dev/null 2>&1; then
        log "✅ avalanchego already available"
    else
        log "ℹ️ avalanchego not found yet. It is usually downloaded by Avalanche CLI on first deploy."
    fi

    if resolve_signature_aggregator_bin >/dev/null 2>&1; then
        log "✅ signature-aggregator already available"
    else
        log "ℹ️ signature-aggregator not found yet. It is usually downloaded by Avalanche CLI on first deploy."
    fi
}

bootstrap_definition() {
    log "🔧 Bootstrapping Avalanche definition for ${AVALANCHE_CHAIN_NAME} ..."
    chmod +x "${PROJECT_ROOT}/chains/avalanche-cli-local/bootstrap-avalanche-definition.sh"
    (
        cd "${PROJECT_ROOT}"
        AVALANCHE_CHAIN_NAME="${AVALANCHE_CHAIN_NAME}" \
        "${PROJECT_ROOT}/chains/avalanche-cli-local/bootstrap-avalanche-definition.sh" --force
    )
}

print_summary() {
    cat <<EOF

============================================
  ✅ Self-Hosted Runner Machine Prepared
============================================
Repository: ${PROJECT_ROOT}
Chain name: ${AVALANCHE_CHAIN_NAME}
CLI version: ${AVALANCHE_CLI_VERSION}

Next steps:
1. Register the GitHub self-hosted runner on this machine
2. Confirm the runner has labels: self-hosted, linux, x64
3. Run workflow: .github/workflows/avalanche-self-hosted-serial.yml

Recommended one-time manual check:
  cd "${PROJECT_ROOT}"
  source chains/avalanche-cli-local/common.sh
  resolve_avalanche_cli
  chains/avalanche-cli-local/start-multinode.sh
  chains/avalanche-cli-local/check-environment.sh
  chains/avalanche-cli-local/refresh-config.sh
  CHAIN_ENV=avalanche-local pnpm test:avalanche:platform
EOF
}

require_not_root
detect_os

log "============================================"
log "  Avalanche Self-Hosted Runner Setup"
log "  OS: ${OS_ID} ${OS_ID_LIKE}"
log "  Repo: ${PROJECT_ROOT}"
log "============================================"
log ""

if [ "${SKIP_PACKAGES}" != "true" ]; then
    log "📦 Installing OS packages ..."
    install_packages
else
    log "⏭️ Skipping OS package installation"
fi

if [ "${SKIP_CLI_INSTALL}" != "true" ]; then
    install_avalanche_cli
else
    log "⏭️ Skipping Avalanche CLI installation"
fi

ensure_shell_profile_path
verify_repo_scripts

if [ "${BOOTSTRAP_DEFINITION}" = "true" ]; then
    bootstrap_definition
else
    log "⏭️ Skipping Avalanche definition bootstrap"
fi

print_summary
