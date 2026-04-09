#!/usr/bin/env python3
import argparse
import os
import sys

from _validator_cli_common import build_add_validator_command, run_interactive_command


def main() -> int:
    parser = argparse.ArgumentParser(description="Interactive automation wrapper for avalanche blockchain addValidator")
    parser.add_argument("--cli-bin", required=True)
    parser.add_argument("--chain-name", required=True)
    parser.add_argument("--node-endpoint")
    parser.add_argument("--node-id")
    parser.add_argument("--bls-public-key")
    parser.add_argument("--bls-proof-of-possession")
    parser.add_argument("--rpc", required=True)
    parser.add_argument("--remaining-balance-owner", required=True)
    parser.add_argument("--disable-owner", required=True)
    parser.add_argument("--validator-manager-owner", required=True)
    parser.add_argument("--balance", default="100000000")
    parser.add_argument("--weight", default="20")
    parser.add_argument("--fee-payer-mode", choices=["stored-key", "ledger"], default="stored-key")
    parser.add_argument("--fee-payer-stored-key", default="ewoq")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    args = parser.parse_args()

    using_endpoint = bool(args.node_endpoint)
    using_identity = bool(args.node_id and args.bls_public_key and args.bls_proof_of_possession)
    if using_endpoint == using_identity:
        raise ValueError(
            "Provide either --node-endpoint or the full identity tuple (--node-id, --bls-public-key, --bls-proof-of-possession)"
        )

    command = build_add_validator_command(
        cli_bin=args.cli_bin,
        chain_name=args.chain_name,
        node_endpoint=args.node_endpoint,
        rpc_endpoint=args.rpc,
        remaining_balance_owner=args.remaining_balance_owner,
        disable_owner=args.disable_owner,
        validator_manager_owner=args.validator_manager_owner,
        balance=args.balance,
        weight=args.weight,
        node_id=args.node_id,
        bls_public_key=args.bls_public_key,
        bls_proof_of_possession=args.bls_proof_of_possession,
    )

    print(" ".join(command))
    return run_interactive_command(
        command,
        fee_payer_mode=args.fee_payer_mode,
        fee_payer_stored_key=args.fee_payer_stored_key,
        timeout_seconds=args.timeout_seconds,
    )


if __name__ == "__main__":
    sys.exit(main())
