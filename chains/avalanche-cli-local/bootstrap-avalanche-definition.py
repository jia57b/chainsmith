#!/usr/bin/env python3
import argparse
import os
import select
import subprocess
import sys
import time

from _validator_cli_common import strip_ansi


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Drive `avalanche blockchain create` non-interactively for the ChainSmith local Avalanche definition."
    )
    parser.add_argument("--cli-bin", required=True)
    parser.add_argument("--chain-name", required=True)
    parser.add_argument("--chain-id", required=True)
    parser.add_argument("--token-symbol", required=True)
    parser.add_argument("--owner-key", required=True)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=240)
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    command = [args.cli_bin, "blockchain", "create", args.chain_name]
    if args.force:
        command.append("--force")

    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=False,
        bufsize=0,
    )

    assert process.stdout is not None
    assert process.stdin is not None

    raw_buffer = ""
    start = time.time()
    steps_completed: set[str] = set()
    confirmation_count = 0

    def write_input(text: str) -> None:
        process.stdin.write(text.encode())
        process.stdin.flush()

    while True:
        if time.time() - start > args.timeout_seconds:
            process.kill()
            tail = strip_ansi(raw_buffer[-4000:])
            raise TimeoutError(f"Timed out waiting for Avalanche CLI create wizard.\nLast output:\n{tail}")

        if process.poll() is not None:
            break

        ready, _, _ = select.select([process.stdout], [], [], 0.25)
        if not ready:
            continue

        chunk = os.read(process.stdout.fileno(), 4096)
        if not chunk:
            continue

        decoded = chunk.decode(errors="replace")
        sys.stdout.write(decoded)
        sys.stdout.flush()
        raw_buffer += decoded
        normalized = strip_ansi(raw_buffer).lower()

        if "already exists" in normalized and "successfully created blockchain configuration" not in normalized:
            if args.force:
                # `--force` should handle this, but keep the failure actionable if CLI disagrees.
                raise RuntimeError("Avalanche CLI reported the blockchain definition already exists even with --force.")
            return 0

        if (
            "which virtual machine would you like to use" in normalized
            and "select_vm" not in steps_completed
        ):
            write_input("\n")
            steps_completed.add("select_vm")
            continue

        if (
            "which validator management type would you like to use in your blockchain" in normalized
            and "select_validator_management" not in steps_completed
        ):
            write_input("\n")
            steps_completed.add("select_validator_management")
            continue

        if (
            "which address do you want to enable as controller of validatormanager contract" in normalized
            and "select_owner_source" not in steps_completed
        ):
            write_input("\n")
            steps_completed.add("select_owner_source")
            continue

        if (
            "which stored key should be used enable as controller of validatormanager contract" in normalized
            and "select_owner_key" not in steps_completed
        ):
            write_input(f"{args.owner_key}\n")
            steps_completed.add("select_owner_key")
            continue

        if (
            "do you want to use default values for the blockchain configuration" in normalized
            and "select_defaults" not in steps_completed
        ):
            write_input("\n")
            steps_completed.add("select_defaults")
            continue

        if "chain id:" in normalized and "enter_chain_id" not in steps_completed:
            write_input(f"{args.chain_id}\n")
            steps_completed.add("enter_chain_id")
            continue

        if "token symbol:" in normalized and "enter_token_symbol" not in steps_completed:
            write_input(f"{args.token_symbol}\n")
            steps_completed.add("enter_token_symbol")
            continue

        if "successfully created blockchain configuration" in normalized:
            break

        # Some CLI versions ask for an extra confirmation after rendering defaults.
        if confirmation_count < 8:
            confirmation_prompts = (
                "continue?",
                "proceed?",
                "confirm?",
                "are you sure",
                "press enter to continue",
                "use the current settings",
            )
            if any(pattern in normalized for pattern in confirmation_prompts):
                write_input("\n")
                confirmation_count += 1
                continue

    exit_code = process.wait()
    if exit_code != 0:
        tail = strip_ansi(raw_buffer[-4000:])
        raise subprocess.CalledProcessError(exit_code, command, output=tail)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
