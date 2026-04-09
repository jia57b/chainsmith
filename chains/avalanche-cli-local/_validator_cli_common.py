#!/usr/bin/env python3
import os
import re
import select
import subprocess
import sys
import time
from typing import List, Sequence


ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text).replace("\r", "")


def run_interactive_command(
    command: Sequence[str],
    fee_payer_mode: str,
    fee_payer_stored_key: str | None,
    timeout_seconds: int = 180,
) -> int:
    process = subprocess.Popen(
        list(command),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=False,
        bufsize=0,
    )

    assert process.stdout is not None
    assert process.stdin is not None

    start = time.time()
    raw_buffer = ""
    responded_fee_payer_mode = False
    responded_fee_payer_key = False
    confirmation_prompts_handled = 0
    max_confirmation_prompts = 10

    def write_input(text: str) -> None:
        process.stdin.write(text.encode())
        process.stdin.flush()

    def handle_confirmation_prompt(normalized_text: str) -> bool:
        nonlocal confirmation_prompts_handled

        if confirmation_prompts_handled >= max_confirmation_prompts:
            return False

        prompt_patterns = [
            "continue?",
            "proceed?",
            "confirm?",
            "are you sure",
            "do you want to continue",
            "would you like to continue",
            "press enter to continue",
            "accept?",
            "submit transaction",
            "sign transaction",
            "use the current settings",
        ]

        if any(pattern in normalized_text for pattern in prompt_patterns):
            confirmation_prompts_handled += 1
            write_input("\n")
            return True

        yes_no_patterns = [
            "yes",
            "no",
        ]
        if "?" in normalized_text and all(token in normalized_text for token in yes_no_patterns):
            confirmation_prompts_handled += 1
            write_input("\n")
            return True

        return False

    while True:
        if time.time() - start > timeout_seconds:
            process.kill()
            tail = strip_ansi(raw_buffer[-4000:])
            raise TimeoutError(f"Timed out waiting for Avalanche CLI interaction to complete.\nLast output:\n{tail}")

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

        if not responded_fee_payer_mode and "which key should be used to pay for transaction fees on p-chain" in normalized:
            if fee_payer_mode == "stored-key":
                process.stdin.write(b"\n")
            else:
                process.stdin.write(b"\x1b[B\n")
            process.stdin.flush()
            responded_fee_payer_mode = True
            continue

        if (
            responded_fee_payer_mode
            and not responded_fee_payer_key
            and fee_payer_mode == "stored-key"
            and fee_payer_stored_key
            and (
                "which stored key" in normalized
                or "which key would you like to use" in normalized
                or "which private key should be used" in normalized
            )
        ):
            process.stdin.write((fee_payer_stored_key + "\n").encode())
            process.stdin.flush()
            responded_fee_payer_key = True
            continue

        if handle_confirmation_prompt(normalized):
            continue

    exit_code = process.wait()
    if exit_code != 0:
        tail = strip_ansi(raw_buffer[-4000:])
        raise subprocess.CalledProcessError(exit_code, list(command), output=tail)
    return exit_code


def build_add_validator_command(
    cli_bin: str,
    chain_name: str,
    node_endpoint: str | None,
    rpc_endpoint: str,
    remaining_balance_owner: str,
    disable_owner: str,
    validator_manager_owner: str,
    balance: str,
    weight: str | None,
    node_id: str | None = None,
    bls_public_key: str | None = None,
    bls_proof_of_possession: str | None = None,
) -> List[str]:
    command = [
        cli_bin,
        "blockchain",
        "addValidator",
        chain_name,
        "--local",
        "--rpc",
        rpc_endpoint,
        "--balance",
        balance,
        "--remaining-balance-owner",
        remaining_balance_owner,
        "--disable-owner",
        disable_owner,
        "--validator-manager-owner",
        validator_manager_owner,
    ]
    if node_endpoint:
        command.extend(["--node-endpoint", node_endpoint])
    if node_id:
        command.extend(["--node-id", node_id])
    if bls_public_key:
        command.extend(["--bls-public-key", bls_public_key])
    if bls_proof_of_possession:
        command.extend(["--bls-proof-of-possession", bls_proof_of_possession])
    if weight:
        command.extend(["--weight", weight])
    return command


def build_remove_validator_command(
    cli_bin: str,
    chain_name: str,
    node_endpoint: str | None,
    validator_manager_owner: str,
    remove_force: bool,
    node_id: str | None = None,
) -> List[str]:
    command = [
        cli_bin,
        "blockchain",
        "removeValidator",
        chain_name,
        "--local",
        "--validator-manager-owner",
        validator_manager_owner,
    ]
    if node_endpoint:
        command.extend(["--node-endpoint", node_endpoint])
    if node_id:
        command.extend(["--node-id", node_id])
    if remove_force:
        command.append("--force")
    return command
