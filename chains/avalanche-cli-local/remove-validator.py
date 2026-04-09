#!/usr/bin/env python3
import argparse
import subprocess
import sys

from _validator_cli_common import build_remove_validator_command, run_interactive_command


def main() -> int:
    parser = argparse.ArgumentParser(description="Interactive automation wrapper for avalanche blockchain removeValidator")
    parser.add_argument("--cli-bin", required=True)
    parser.add_argument("--chain-name", required=True)
    parser.add_argument("--node-endpoint")
    parser.add_argument("--node-id")
    parser.add_argument("--rpc")
    parser.add_argument("--validator-manager-owner", required=True)
    parser.add_argument("--fee-payer-mode", choices=["stored-key", "ledger"], default="stored-key")
    parser.add_argument("--fee-payer-stored-key", default="ewoq")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if not args.node_endpoint and not args.node_id:
        raise ValueError("Provide either --node-endpoint or --node-id for removeValidator")

    command = build_remove_validator_command(
        cli_bin=args.cli_bin,
        chain_name=args.chain_name,
        node_endpoint=args.node_endpoint,
        validator_manager_owner=args.validator_manager_owner,
        remove_force=args.force,
        node_id=args.node_id,
    )

    print(" ".join(command))
    try:
        return run_interactive_command(
            command,
            fee_payer_mode=args.fee_payer_mode,
            fee_payer_stored_key=args.fee_payer_stored_key,
            timeout_seconds=args.timeout_seconds,
        )
    except TimeoutError as error:
        message = str(error)
        if "validator removal process was already initialized" in message.lower():
            print("Detected previously initialized validator removal flow; delegating completion check to caller.")
            return 0
        raise
    except subprocess.CalledProcessError as error:
        output = str(error.output or "")
        if "validator removal process was already initialized" in output.lower():
            print("Detected previously initialized validator removal flow; delegating completion check to caller.")
            return 0
        raise


if __name__ == "__main__":
    sys.exit(main())
