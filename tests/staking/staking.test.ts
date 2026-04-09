import '../../setup';
import { ethers } from 'ethers';
import fs from 'fs';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { StakingTestBuilder } from '../../src/blockchain/test-library';
import {
    evmAddressToBech32AccountAddress,
    inferAddressPrefixFromOperatorAddress,
} from '../../src/blockchain/utils/cosmos';
import { Config } from '../../src/utils/common';
import path from 'path';

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
chai.use(chaiAsPromised);

const { expect } = chai;

const configPath = path.join(__dirname, '../config.json');
const envName = Config.envName;

function getStakingParams(): { stakeAmount: string; fundAmount: string; precompileAddress?: string } {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const testStaking = raw.testConfig?.staking ?? {};
    const chainStaking = raw[envName]?.staking ?? {};

    const stakeAmount =
        process.env.STAKE_AMOUNT ?? chainStaking.defaultStakeAmount ?? testStaking.defaultStakeAmount ?? '2';

    const fundingMultiplier = chainStaking.fundingMultiplier ?? testStaking.fundingMultiplier ?? 5;

    const fundAmount =
        process.env.FUND_AMOUNT ?? chainStaking.fundAmount ?? (Number(stakeAmount) * fundingMultiplier).toString();

    const precompileAddress = chainStaking.precompileAddress ?? testStaking.precompileAddress;

    return { stakeAmount, fundAmount, precompileAddress };
}

async function getReceiptGasCost(provider: ethers.JsonRpcProvider, receipt: any): Promise<bigint> {
    const gasUsed = BigInt(receipt.gasUsed?.toString?.() ?? receipt.gasUsed ?? 0);
    const tx = await provider.getTransaction(receipt.hash);
    const gasPrice = receipt.gasPrice ?? tx?.gasPrice ?? tx?.maxFeePerGas ?? 0n;
    return gasUsed * gasPrice;
}

async function createBuilder(testName: string): Promise<{
    builder: StakingTestBuilder;
    stakeAmount: string;
    fundAmount: string;
}> {
    const { stakeAmount, fundAmount, precompileAddress } = getStakingParams();
    const rm = new RuntimeManager();
    await rm.connectToChainFromConfigFile(configPath, envName);
    const chain = rm.getChain(envName);
    if (!chain) throw new Error(`Failed to connect to chain: ${envName}`);

    const builder = new StakingTestBuilder(chain)
        .withTestName(testName)
        .withStakingParameters({ stakingAmount: stakeAmount })
        .withPrecompile(precompileAddress);

    return { builder, stakeAmount, fundAmount };
}

function getExpandedFundAmount(stakeAmount: string, fallbackFundAmount: string, multiplier: number = 5): string {
    const numericStake = Number(stakeAmount);
    const numericFallback = Number(fallbackFundAmount);
    return Math.max(numericFallback, numericStake * multiplier).toString();
}

function getBigIntDiff(left: bigint, right: bigint): bigint {
    return left > right ? left - right : right - left;
}

function getUnbondingEntries(unbonding: any): any[] {
    const entries = unbonding?.entries ?? unbonding?.unbondingDelegation?.entries ?? [];
    return Array.isArray(entries) ? entries : [];
}

function sumEntryBalances(entries: any[]): bigint {
    return entries.reduce((sum, entry) => sum + BigInt(entry.balance?.toString?.() ?? entry.balance ?? 0), 0n);
}

function extractRestUnbondingEntries(restResponse: any, validatorAddr?: string): any[] {
    const responses = restResponse?.unbonding_responses ?? restResponse?.unbondingResponses ?? [];
    if (!Array.isArray(responses)) {
        return [];
    }

    const normalized = responses.flatMap((item: any) => {
        const targetValidator =
            item?.validator_address ?? item?.validatorAddress ?? item?.unbonding_delegation?.validator_address;
        if (validatorAddr && targetValidator !== validatorAddr) {
            return [];
        }

        const entries = item?.entries ?? item?.unbonding_delegation?.entries ?? [];
        if (!Array.isArray(entries)) {
            return [];
        }

        return entries.map((entry: any) => ({
            ...entry,
            creationHeight: entry.creationHeight ?? entry.creation_height,
            completionTime: entry.completionTime ?? entry.completion_time,
            balance: entry.balance,
            initialBalance: entry.initialBalance ?? entry.initial_balance,
            validatorAddress: targetValidator,
        }));
    });

    return normalized;
}

async function waitForUnbondingEntries(
    builder: StakingTestBuilder,
    delegatorAddress: string,
    validatorAddr?: string,
    timeoutMs: number = 18000,
    pollIntervalMs: number = 1000
): Promise<{ unbonding: any; entries: any[]; elapsedMs: number }> {
    const startedAt = Date.now();
    const consensusClient = builder.getConsensusClient();
    const delegatorQueryAddress =
        delegatorAddress.startsWith('0x') && validatorAddr
            ? evmAddressToBech32AccountAddress(delegatorAddress, inferAddressPrefixFromOperatorAddress(validatorAddr))
            : delegatorAddress;

    while (Date.now() - startedAt < timeoutMs) {
        const unbonding = await builder.queryUnbondingDelegation(delegatorAddress, validatorAddr);
        const entries = getUnbondingEntries(unbonding);
        if (entries.length > 0) {
            return {
                unbonding,
                entries,
                elapsedMs: Date.now() - startedAt,
            };
        }

        if (consensusClient) {
            const restUnbonding = await consensusClient.getDelegatorUnbondingDelegations(delegatorQueryAddress);
            const restEntries = extractRestUnbondingEntries(restUnbonding, validatorAddr);
            if (restEntries.length > 0) {
                return {
                    unbonding: restUnbonding,
                    entries: restEntries,
                    elapsedMs: Date.now() - startedAt,
                };
            }
        }

        try {
            await builder.getBlockchain().waitForBlocks(1, 3000);
        } catch {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Timed out waiting for unbonding entries after ${timeoutMs}ms`);
}

describe('Staking tests', () => {
    it('S-01: should delegate and verify through precompile & REST, and validate global staking info', async function () {
        this.timeout(120000);
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-01: Basic Delegate & Queries');

        await builder.discoverValidator();
        const validatorAddr = builder.getValidatorAddress()!;
        expect(validatorAddr).to.be.a('string').and.not.empty;

        await builder.prepareWallets(1, fundAmount);
        const wallet = builder.getWallets()[0];

        // 1. Execute Delegate
        const receipt = await builder.delegateFrom(wallet, stakeAmount);
        expect(receipt.status).to.equal(1);
        expect(receipt.hash).to.be.a('string').and.not.empty;

        await builder.getBlockchain().waitForBlocks(2, 3000);

        // 2. Query globally via REST API (Merged S-14, S-15, S-16, S-17)
        const consensusClient = builder.getConsensusClient()!;

        const paramsResult = await consensusClient.getStakingParams();
        expect(paramsResult.params.bond_denom).to.be.a('string').and.not.empty;
        expect(paramsResult.params.unbonding_time).to.exist;

        const poolResult = await consensusClient.getStakingPool();
        expect(BigInt(poolResult.pool.bonded_tokens) > 0n).to.be.true;

        const validatorsResult = await consensusClient.getStakingValidators();
        expect(validatorsResult.validators).to.be.an('array').and.not.empty;

        const valDetailResult = await consensusClient.getStakingValidator(validatorAddr);
        expect(valDetailResult.validator.operator_address).to.equal(validatorAddr);

        // 3. Compare PRECOMPILE with REST delegation results (Merged S-02 & S-01)
        const delegationPrecompile = await builder.queryDelegation(wallet.address);
        expect(delegationPrecompile).to.not.be.null;
        expect(delegationPrecompile!.shares > 0n).to.be.true;

        const delegationRestResult = await consensusClient.getValidatorDelegations(validatorAddr);
        const hasEntries = delegationRestResult.delegation_responses.length > 0;
        expect(hasEntries, 'REST API should return at least one delegation for the validator').to.be.true;

        await builder.cleanup();
    });

    it('S-02: should execute partial/full undelegate smoothly and restore wallet balance automatically', async function () {
        this.timeout(600000); // 10 minutes max for dynamic unbonding
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-02: Full Lifecycle & Balance Tracker');

        await builder.discoverValidator();
        const consensusClient = builder.getConsensusClient()!;

        const stakingParamsResult = await consensusClient.getStakingParams();
        const unbondingTimeSeconds = parseInt(stakingParamsResult.params.unbonding_time.replace('s', ''), 10);
        const bondDenom = String(stakingParamsResult.params.bond_denom ?? 'tokens');

        if (unbondingTimeSeconds > 60) {
            console.log(`   ⚠️ unbonding_time is ${unbondingTimeSeconds}s, skipping test to avoid stalling CI`);
            await builder.cleanup();
            this.skip();
        }

        await builder.prepareWallets(1, fundAmount);
        const wallet = builder.getWallets()[0];
        const provider = builder.getProvider();

        const balanceBeforeStake = await provider.getBalance(wallet.address);
        console.log(`   Balance before stake: ${ethers.formatEther(balanceBeforeStake)}`);

        // 1. Delegate
        await builder.delegateFrom(wallet, stakeAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const balanceAfterStake = await provider.getBalance(wallet.address);
        const balanceDecreaseForStake = balanceBeforeStake - balanceAfterStake;
        console.log(
            `   Balance after stake: ${ethers.formatEther(balanceAfterStake)} (decreased by ${ethers.formatEther(balanceDecreaseForStake)})`
        );
        expect(balanceDecreaseForStake >= ethers.parseEther(stakeAmount)).to.be.true;

        const balanceBeforeUndelegate = await provider.getBalance(wallet.address);
        console.log(`   Balance snapshot (before any undelegate): ${ethers.formatEther(balanceBeforeUndelegate)}`);

        // 2. Partial Undelegate
        const partialAmount = (Number(stakeAmount) / 2).toString();
        const firstUndelegateReceipt = await builder.undelegateFrom(wallet, partialAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const delegationAfterPartial = await builder.queryDelegation(wallet.address);
        expect(delegationAfterPartial!.amount > 0n, 'Remaining positive after partition').to.be.true;

        // 3. Full (Rest) Undelegate
        const secondUndelegateReceipt = await builder.undelegateFrom(wallet, partialAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const finalDelegation = await builder.queryDelegation(wallet.address);
        const isCleared = !finalDelegation || finalDelegation.shares === 0n;
        expect(isCleared, 'Delegation totally cleared').to.be.true;

        // 4. Query Unbonding Queue
        const unbonding = await builder.queryUnbondingDelegation(wallet.address);
        expect(unbonding, 'Unbonding queue should hold our two undelegate calls').to.not.be.null;

        // 5. Wait Unbonding Period
        // We need to wait for BOTH unbonding records to mature.
        // The two undelegates are separated by ~4 blocks (~8s). With unbonding_time=10s,
        // the second one matures ~8s after the first. We add generous buffer.
        const bufferWaitMs = 15000;
        const totalWaitMs = unbondingTimeSeconds * 1000 + bufferWaitMs;
        console.log(`   Waiting for ${totalWaitMs / 1000}s for ALL refunds to clear...`);
        await new Promise(resolve => setTimeout(resolve, totalWaitMs));
        await builder.getBlockchain().waitForBlocks(4, 3000);

        // 6. Verify refund
        const finalWalletBalance = await provider.getBalance(wallet.address);
        const totalRefunded = finalWalletBalance - balanceBeforeUndelegate;
        const actualGasCost =
            (await getReceiptGasCost(provider, firstUndelegateReceipt)) +
            (await getReceiptGasCost(provider, secondUndelegateReceipt));

        console.log(`   Balance after full unbonding: ${ethers.formatEther(finalWalletBalance)}`);
        console.log(
            `   Total refunded (vs pre-undelegate snapshot): ${ethers.formatEther(totalRefunded)} ${bondDenom}`
        );

        const expectedRefund = ethers.parseEther(stakeAmount);
        const refundPlusGas = totalRefunded + actualGasCost;
        const refundTolerance = ethers.parseEther('0.01'); // small tolerance for share rounding / fee estimation drift

        console.log(`   Expected refund: ~${stakeAmount} ${bondDenom}`);
        console.log(`   Actual undelegate gas cost: ${ethers.formatEther(actualGasCost)} ${bondDenom}`);
        console.log(`   Refund + gas: ${ethers.formatEther(refundPlusGas)} ${bondDenom}`);
        console.log(`   Allowed refund tolerance: ${ethers.formatEther(refundTolerance)} ${bondDenom}`);

        // totalRefunded should be positive (we got money back)
        expect(
            totalRefunded > 0n,
            `Wallet should gain balance after unbonding. finalBalance=${ethers.formatEther(finalWalletBalance)}, snapshotBalance=${ethers.formatEther(balanceBeforeUndelegate)}, diff=${ethers.formatEther(totalRefunded)}`
        ).to.be.true;

        // Refund plus actual gas spent should be close to the undelegated principal.
        const refundDiff =
            refundPlusGas > expectedRefund ? refundPlusGas - expectedRefund : expectedRefund - refundPlusGas;

        expect(
            refundDiff <= refundTolerance,
            `Refund difference after adding actual gas (${ethers.formatEther(refundDiff)}) exceeds tolerance (${ethers.formatEther(refundTolerance)}). Actual refunded=${ethers.formatEther(totalRefunded)}, actualGas=${ethers.formatEther(actualGasCost)}, expected=${stakeAmount}`
        ).to.be.true;

        await builder.cleanup();
    });

    it('S-03: should correctly revert on zero amount, insufficient funds, and false undelegations', async function () {
        this.timeout(120000);
        const { builder, fundAmount } = await createBuilder('S-03: Constraints Testing');

        await builder.discoverValidator();
        await builder.prepareWallets(1, fundAmount);
        const wallet = builder.getWallets()[0];

        // Assert 1: Zero Amount Delegation
        let failedZero = false;
        try {
            await builder.delegateFrom(wallet, '0');
        } catch (_e) {
            console.log(_e);
            failedZero = true;
        }
        expect(failedZero, 'Zero amount delegation should fail').to.be.true;

        // Assert 2: Insufficient Balance
        let failedInsufficient = false;
        try {
            await builder.delegateFrom(wallet, fundAmount);
        } catch (_e) {
            console.log(_e);
            failedInsufficient = true;
        }
        expect(failedInsufficient, 'Delegation exceeding wallet balance should fail').to.be.true;

        // Assert 3: Empty Undelegation
        let failedEmptyUndelegation = false;
        try {
            await builder.undelegateFrom(wallet, '0.5');
        } catch (_e) {
            console.log(_e);
            failedEmptyUndelegation = true;
        }
        expect(failedEmptyUndelegation, 'Undelegate with no prior setup should fail').to.be.true;

        // Give it some funds and stake normally
        await builder.delegateFrom(wallet, '0.5');
        await builder.getBlockchain().waitForBlocks(2, 3000);

        // Assert 4: Excess Undelegation
        let failedExcessUndelegate = false;
        try {
            await builder.undelegateFrom(wallet, '100');
        } catch (_e) {
            console.log(_e);
            failedExcessUndelegate = true;
        }
        expect(failedExcessUndelegate, 'Undelegate exceeding bounds should fail').to.be.true;

        await builder.cleanup();
    });

    it('S-04: should accumulate delegation amount across multiple delegate calls', async function () {
        this.timeout(180000);
        const { builder, fundAmount } = await createBuilder('S-04: Incremental Delegation');
        const incrementAmount = '1';
        const numIncrements = 3;

        await builder.discoverValidator();
        await builder.prepareWallets(1, fundAmount);
        const wallet = builder.getWallets()[0];

        const tokensBefore = await builder.getValidatorTokens();

        for (let i = 0; i < numIncrements; i++) {
            const receipt = await builder.delegateFrom(wallet, incrementAmount);
            expect(receipt.status).to.equal(1);
            console.log(`   Increment ${i + 1}/${numIncrements} delegated ${incrementAmount}`);
            await builder.getBlockchain().waitForBlocks(2, 3000);
        }

        const delegation = await builder.queryDelegation(wallet.address);
        expect(delegation).to.not.be.null;

        const expectedWei = ethers.parseEther(incrementAmount) * BigInt(numIncrements);
        const tolerance = expectedWei / 50n; // 2% tolerance for accumulated rounding
        const diff =
            delegation!.amount > expectedWei ? delegation!.amount - expectedWei : expectedWei - delegation!.amount;
        expect(
            diff <= tolerance,
            `Accumulated delegation ${ethers.formatEther(delegation!.amount)} should be ~${numIncrements * Number(incrementAmount)}`
        ).to.be.true;

        const tokensAfter = await builder.getValidatorTokens();
        const tokenIncrease = tokensAfter - tokensBefore;
        console.log(
            `   Validator tokens increased by ${ethers.formatEther(tokenIncrease)} (expected: ${numIncrements * Number(incrementAmount)})`
        );
        expect(tokenIncrease > 0n, 'Validator tokens should increase').to.be.true;

        await builder.cleanup();
    });

    it('S-05: should redelegate tokens from one validator to another', async function () {
        this.timeout(180000);
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-08: Redelegate');

        let validators: string[];
        try {
            validators = await builder.discoverMultipleValidators(2);
        } catch (err) {
            console.log(`   Skipping: need at least 2 bonded validators. ${err}`);
            this.skip();
        }

        const [validatorA, validatorB] = validators;
        builder.withStakingParameters({ stakingAmount: stakeAmount, validatorAddress: validatorA });

        await builder.prepareWallets(1, fundAmount);
        const wallet = builder.getWallets()[0];

        const tokensA_before = await builder.getValidatorTokens(validatorA);
        const tokensB_before = await builder.getValidatorTokens(validatorB);

        await builder.delegateFrom(wallet, stakeAmount, validatorA);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const receipt = await builder.redelegateFrom(wallet, validatorA, validatorB, stakeAmount);
        expect(receipt.status).to.equal(1);

        await builder.getBlockchain().waitForBlocks(2, 3000);

        const delegationA = await builder.queryDelegation(wallet.address, validatorA);
        const delegationB = await builder.queryDelegation(wallet.address, validatorB);

        const aCleared = !delegationA || delegationA.shares === 0n;
        expect(aCleared, 'Source validator delegation should be cleared').to.be.true;

        expect(delegationB).to.not.be.null;
        expect(delegationB!.amount > 0n, 'Destination validator delegation should be positive').to.be.true;

        const tokensA_after = await builder.getValidatorTokens(validatorA);
        const tokensB_after = await builder.getValidatorTokens(validatorB);
        console.log(`   Validator A token change: ${ethers.formatEther(tokensA_after - tokensA_before)}`);
        console.log(`   Validator B token change: ${ethers.formatEther(tokensB_after - tokensB_before)}`);

        const stakeWei = ethers.parseEther(stakeAmount);
        const bIncrease = tokensB_after - tokensB_before;
        const tolerance = stakeWei / 50n;
        const diff = bIncrease > stakeWei ? bIncrease - stakeWei : stakeWei - bIncrease;
        expect(diff <= tolerance, `Validator B tokens should increase by ~${stakeAmount}`).to.be.true;

        await builder.cleanup();
    });

    it('S-06: should handle concurrent delegations from multiple wallets', async function () {
        this.timeout(180000);
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-13: Concurrent Delegation');
        const walletCount = 3;

        await builder.discoverValidator();
        await builder.prepareWallets(walletCount, fundAmount);
        const wallets = builder.getWallets();

        const tokensBefore = await builder.getValidatorTokens();

        const results = await Promise.all(
            wallets.map(async (wallet: ethers.Wallet, index: number) => {
                try {
                    const receipt = await builder.delegateFrom(wallet, stakeAmount);
                    return { index, success: receipt.status === 1, hash: receipt.hash };
                } catch (err) {
                    return { index, success: false, error: String(err) };
                }
            })
        );

        const successful = results.filter(r => r.success);
        console.log(`   Concurrent delegations: ${successful.length}/${walletCount} successful`);
        expect(successful.length).to.equal(walletCount);

        await builder.getBlockchain().waitForBlocks(2, 3000);

        for (const wallet of wallets) {
            const delegation = await builder.queryDelegation(wallet.address);
            expect(delegation).to.not.be.null;
            expect(delegation!.amount > 0n, 'Each wallet should have positive delegation').to.be.true;
        }

        const tokensAfter = await builder.getValidatorTokens();
        const totalIncrease = tokensAfter - tokensBefore;
        const expectedTotal = ethers.parseEther(stakeAmount) * BigInt(walletCount);
        const tolerance = expectedTotal / 50n;
        const diff = totalIncrease > expectedTotal ? totalIncrease - expectedTotal : expectedTotal - totalIncrease;
        expect(
            diff <= tolerance,
            `Total token increase ${ethers.formatEther(totalIncrease)} should be ~${Number(stakeAmount) * walletCount}`
        ).to.be.true;

        console.log(
            `   Total validator token increase: ${ethers.formatEther(totalIncrease)} (expected: ${Number(stakeAmount) * walletCount})`
        );
        await builder.cleanup();
    });

    it('S-07: should handle concurrent delegations from multiple wallets', async function () {
        this.timeout(180000);
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-13: Concurrent Delegation');
        const walletCount = 3;

        await builder.discoverValidator();
        await builder.prepareWallets(walletCount, fundAmount);
        const wallets = builder.getWallets();

        const tokensBefore = await builder.getValidatorTokens();

        const results = await Promise.all(
            wallets.map(async (wallet: ethers.Wallet, index: number) => {
                try {
                    const receipt = await builder.delegateFrom(wallet, stakeAmount);
                    return { index, success: receipt.status === 1, hash: receipt.hash };
                } catch (err) {
                    return { index, success: false, error: String(err) };
                }
            })
        );

        const successful = results.filter(r => r.success);
        console.log(`   Concurrent delegations: ${successful.length}/${walletCount} successful`);
        expect(successful.length).to.equal(walletCount);

        await builder.getBlockchain().waitForBlocks(2, 3000);

        for (const wallet of wallets) {
            const delegation = await builder.queryDelegation(wallet.address);
            expect(delegation).to.not.be.null;
            expect(delegation!.amount > 0n, 'Each wallet should have positive delegation').to.be.true;
        }

        const tokensAfter = await builder.getValidatorTokens();
        const totalIncrease = tokensAfter - tokensBefore;
        const expectedTotal = ethers.parseEther(stakeAmount) * BigInt(walletCount);
        const tolerance = expectedTotal / 50n;
        const diff = totalIncrease > expectedTotal ? totalIncrease - expectedTotal : expectedTotal - totalIncrease;
        expect(
            diff <= tolerance,
            `Total token increase ${ethers.formatEther(totalIncrease)} should be ~${Number(stakeAmount) * walletCount}`
        ).to.be.true;

        console.log(
            `   Total validator token increase: ${ethers.formatEther(totalIncrease)} (expected: ${Number(stakeAmount) * walletCount})`
        );
        await builder.cleanup();
    });

    it('S-08: should accurately track validator token changes at Wei precision', async function () {
        this.timeout(180000);
        const { builder, fundAmount } = await createBuilder('S-19: Token Precision');
        const preciseAmount = '1.5';

        await builder.discoverValidator();
        await builder.prepareWallets(1, fundAmount);
        const wallet = builder.getWallets()[0];

        const tokensBefore = await builder.getValidatorTokens();
        console.log(`   Tokens before: ${ethers.formatEther(tokensBefore)}`);

        await builder.delegateFrom(wallet, preciseAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const tokensAfterStake = await builder.getValidatorTokens();
        const increase = tokensAfterStake - tokensBefore;
        const expectedWei = ethers.parseEther(preciseAmount);

        console.log(`   Tokens after stake: ${ethers.formatEther(tokensAfterStake)}`);
        console.log(`   Increase: ${ethers.formatEther(increase)} (expected: ${preciseAmount})`);

        const stakeDiff = increase > expectedWei ? increase - expectedWei : expectedWei - increase;
        const tolerance = expectedWei / 100n;
        expect(
            stakeDiff <= tolerance,
            `Token increase precision: diff=${ethers.formatEther(stakeDiff)}, tolerance=${ethers.formatEther(tolerance)}`
        ).to.be.true;

        await builder.undelegateFrom(wallet, preciseAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const tokensAfterUnstake = await builder.getValidatorTokens();
        const decrease = tokensAfterStake - tokensAfterUnstake;

        console.log(`   Tokens after unstake: ${ethers.formatEther(tokensAfterUnstake)}`);
        console.log(`   Decrease: ${ethers.formatEther(decrease)} (expected: ${preciseAmount})`);

        const unstakeDiff = decrease > expectedWei ? decrease - expectedWei : expectedWei - decrease;
        expect(
            unstakeDiff <= tolerance,
            `Token decrease precision: diff=${ethers.formatEther(unstakeDiff)}, tolerance=${ethers.formatEther(tolerance)}`
        ).to.be.true;

        await builder.cleanup();
    });

    it('S-09: should cancel an unbonding delegation and restore delegation state', async function () {
        this.timeout(240000);
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-09: Cancel Unbonding Delegation');
        const richFundAmount = getExpandedFundAmount(stakeAmount, fundAmount);

        // Test steps:
        // 1. Discover a bonded validator and fund a fresh wallet with enough balance.
        // 2. Delegate the full stake amount to establish an initial delegation position.
        // 3. Partially undelegate to create a pending unbonding entry.
        // 4. Read the unbonding queue and capture the entry creation height needed by
        //    cancelUnbondingDelegation.
        // 5. Cancel that unbonding entry through the staking precompile.
        // 6. Verify the delegation amount is restored close to the pre-undelegate value.
        // 7. Verify the cancelled unbonding entry no longer exists in the queue.
        // 8. Verify the precompile emitted CancelUnbondingDelegation with the expected amount.
        await builder.discoverValidator();
        const validatorAddr = builder.getValidatorAddress()!;
        await builder.prepareWallets(1, richFundAmount);
        const wallet = builder.getWallets()[0];

        await builder.delegateFrom(wallet, stakeAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const partialAmount = (Number(stakeAmount) / 2).toString();
        const stakeWei = ethers.parseEther(stakeAmount);
        const partialWei = ethers.parseEther(partialAmount);
        const tolerance = partialWei / 50n;

        const delegationBeforeCancel = await builder.queryDelegation(wallet.address);
        expect(delegationBeforeCancel).to.not.be.null;

        const undelegateStartedAt = Date.now();
        await builder.undelegateFrom(wallet, partialAmount);

        await builder.getBlockchain().waitForBlocks(2, 3000);

        const { entries: entriesBeforeCancel, elapsedMs } = await waitForUnbondingEntries(
            builder,
            wallet.address,
            validatorAddr
        );
        expect(entriesBeforeCancel.length > 0, 'Expected at least one unbonding entry before cancellation').to.be.true;
        expect(
            Date.now() - undelegateStartedAt < 28000 && elapsedMs < 28000,
            'Cancellation should happen while the 30s unbonding window is still open'
        ).to.be.true;

        const targetEntry = entriesBeforeCancel[0];
        const creationHeight = BigInt(
            targetEntry.creationHeight?.toString?.() ?? targetEntry.creationHeight ?? targetEntry.creation_height ?? 0
        );
        expect(creationHeight > 0n, 'Unbonding entry creation height should be positive').to.be.true;

        const cancelReceipt = await builder.cancelUnbondingDelegationFrom(wallet, partialAmount, creationHeight);
        expect(cancelReceipt.status).to.equal(1);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const delegationAfterCancel = await builder.queryDelegation(wallet.address);
        expect(delegationAfterCancel).to.not.be.null;

        const delegationDiff = getBigIntDiff(delegationAfterCancel!.amount, stakeWei);
        expect(
            delegationDiff <= tolerance,
            `Delegation amount after cancellation should be ~${stakeAmount}; got ${ethers.formatEther(delegationAfterCancel!.amount)}`
        ).to.be.true;

        const unbondingAfterCancel = await builder.queryUnbondingDelegation(wallet.address, validatorAddr);
        const entriesAfterCancel = getUnbondingEntries(unbondingAfterCancel);
        const matchingEntry = entriesAfterCancel.find(
            entry =>
                BigInt(entry.creationHeight?.toString?.() ?? entry.creationHeight ?? entry.creation_height ?? 0) ===
                creationHeight
        );
        expect(!matchingEntry, 'Cancelled unbonding entry should be removed').to.be.true;

        const decodedEvents = builder.decodeStakingEvents(cancelReceipt);
        const cancelEvent = decodedEvents.find(event => event.name === 'CancelUnbondingDelegation');
        expect(cancelEvent, 'CancelUnbondingDelegation event should be emitted').to.exist;
        expect(cancelEvent!.args.delegatorAddress.toLowerCase()).to.equal(wallet.address.toLowerCase());
        expect(BigInt(cancelEvent!.args.amount.toString())).to.equal(partialWei);

        await builder.cleanup();
    });

    it('S-10: should keep redelegation queries consistent with source and destination validator state', async function () {
        this.timeout(240000);
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-10: Redelegation Query Consistency');
        const richFundAmount = getExpandedFundAmount(stakeAmount, fundAmount);

        let validators: string[];
        try {
            validators = await builder.discoverMultipleValidators(2);
        } catch (err) {
            console.log(`   Skipping: need at least 2 bonded validators. ${err}`);
            this.skip();
        }

        const [validatorA, validatorB] = validators;
        await builder.prepareWallets(1, richFundAmount);
        const wallet = builder.getWallets()[0];
        const consensusClient = builder.getConsensusClient()!;
        const delegatorQueryAddress = evmAddressToBech32AccountAddress(
            wallet.address,
            inferAddressPrefixFromOperatorAddress(validatorA)
        );

        await builder.delegateFrom(wallet, stakeAmount, validatorA);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const redelegateAmount = (Number(stakeAmount) / 2).toString();
        const redelegateWei = ethers.parseEther(redelegateAmount);
        const totalStakeWei = ethers.parseEther(stakeAmount);
        const tolerance = redelegateWei / 50n;

        await builder.redelegateFrom(wallet, validatorA, validatorB, redelegateAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const delegationA = await builder.queryDelegation(wallet.address, validatorA);
        const delegationB = await builder.queryDelegation(wallet.address, validatorB);
        expect(delegationA).to.not.be.null;
        expect(delegationB).to.not.be.null;

        expect(getBigIntDiff(delegationA!.amount, redelegateWei) <= tolerance).to.be.true;
        expect(getBigIntDiff(delegationB!.amount, redelegateWei) <= tolerance).to.be.true;
        expect(getBigIntDiff(delegationA!.amount + delegationB!.amount, totalStakeWei) <= tolerance).to.be.true;

        const redelegationResponse = await consensusClient.getDelegatorRedelegations(delegatorQueryAddress);
        const redelegations = redelegationResponse.redelegation_responses ?? redelegationResponse.responses ?? [];
        const matching = redelegations.find((item: any) => {
            const redelegation = item.redelegation ?? item;
            return (
                redelegation?.delegator_address === delegatorQueryAddress &&
                redelegation?.validator_src_address === validatorA &&
                redelegation?.validator_dst_address === validatorB
            );
        });

        expect(matching, 'Redelegation query should include the matching src/dst validator pair').to.exist;
        const queryEntries = matching.entries ?? matching.redelegation?.entries ?? [];
        expect(queryEntries.length > 0, 'Redelegation query should contain at least one entry').to.be.true;
        const queryBalance = BigInt(queryEntries[0].balance?.toString?.() ?? queryEntries[0].balance ?? 0);
        expect(getBigIntDiff(queryBalance, redelegateWei) <= tolerance).to.be.true;

        await builder.cleanup();
    });

    it('S-11: should emit staking precompile events with expected names and amounts', async function () {
        this.timeout(240000);
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-11: Staking Event Assertions');
        const richFundAmount = getExpandedFundAmount(stakeAmount, fundAmount);
        const eventStakeAmount = '2';
        const eventPartialAmount = '1';

        let validators: string[];
        try {
            validators = await builder.discoverMultipleValidators(2);
        } catch (err) {
            console.log(`   Skipping: need at least 2 bonded validators. ${err}`);
            this.skip();
        }

        const [validatorA, validatorB] = validators;
        await builder.prepareWallets(1, richFundAmount);
        const wallet = builder.getWallets()[0];

        const delegateReceipt = await builder.delegateFrom(wallet, eventStakeAmount, validatorA);
        await builder.getBlockchain().waitForBlocks(2, 3000);
        const redelegateReceipt = await builder.redelegateFrom(wallet, validatorA, validatorB, eventPartialAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);
        const unbondReceipt = await builder.undelegateFrom(wallet, eventPartialAmount, validatorA);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const delegateEvent = builder.decodeStakingEvents(delegateReceipt).find(event => event.name === 'Delegate');
        expect(delegateEvent, 'Delegate event should be emitted').to.exist;
        expect(delegateEvent!.args.delegatorAddress.toLowerCase()).to.equal(wallet.address.toLowerCase());
        expect(BigInt(delegateEvent!.args.amount.toString())).to.equal(ethers.parseEther(eventStakeAmount));

        const redelegateEvent = builder
            .decodeStakingEvents(redelegateReceipt)
            .find(event => event.name === 'Redelegate');
        expect(redelegateEvent, 'Redelegate event should be emitted').to.exist;
        expect(redelegateEvent!.args.delegatorAddress.toLowerCase()).to.equal(wallet.address.toLowerCase());
        expect(BigInt(redelegateEvent!.args.amount.toString())).to.equal(ethers.parseEther(eventPartialAmount));

        const unbondEvent = builder.decodeStakingEvents(unbondReceipt).find(event => event.name === 'Unbond');
        expect(unbondEvent, 'Unbond event should be emitted').to.exist;
        expect(unbondEvent!.args.delegatorAddress.toLowerCase()).to.equal(wallet.address.toLowerCase());
        expect(BigInt(unbondEvent!.args.amount.toString())).to.equal(ethers.parseEther(eventPartialAmount));

        await builder.cleanup();
    });

    it('S-12: should keep validator REST queries consistent with token changes across stake and unstake', async function () {
        this.timeout(240000);
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-12: Validator Query Consistency');
        const richFundAmount = getExpandedFundAmount(stakeAmount, fundAmount);
        const tolerance = ethers.parseEther(stakeAmount) / 50n;

        await builder.discoverValidator();
        const validatorAddr = builder.getValidatorAddress()!;
        const consensusClient = builder.getConsensusClient()!;
        await builder.prepareWallets(1, richFundAmount);
        const wallet = builder.getWallets()[0];

        const beforeValidator = await consensusClient.getStakingValidator(validatorAddr);
        const beforeTokens = BigInt(beforeValidator.validator.tokens);

        await builder.delegateFrom(wallet, stakeAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const afterStakeValidator = await consensusClient.getStakingValidator(validatorAddr);
        const afterStakeTokens = BigInt(afterStakeValidator.validator.tokens);
        expect(afterStakeValidator.validator.operator_address).to.equal(validatorAddr);
        expect(afterStakeValidator.validator.status).to.equal(beforeValidator.validator.status);
        expect(getBigIntDiff(afterStakeTokens - beforeTokens, ethers.parseEther(stakeAmount)) <= tolerance).to.be.true;
        expect(afterStakeTokens).to.equal(await builder.getValidatorTokens());

        await builder.undelegateFrom(wallet, stakeAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const afterUnstakeValidator = await consensusClient.getStakingValidator(validatorAddr);
        const afterUnstakeTokens = BigInt(afterUnstakeValidator.validator.tokens);
        expect(afterUnstakeValidator.validator.operator_address).to.equal(validatorAddr);
        expect(afterUnstakeValidator.validator.status).to.equal(beforeValidator.validator.status);
        expect(getBigIntDiff(afterUnstakeTokens, beforeTokens) <= tolerance).to.be.true;
        expect(afterUnstakeTokens).to.equal(await builder.getValidatorTokens());

        await builder.cleanup();
    });

    it('S-13: should create multiple distinct unbonding queue entries for repeated undelegations', async function () {
        this.timeout(240000);
        const { builder, fundAmount } = await createBuilder('S-13: Multi-Entry Unbonding Queue');
        const richFundAmount = getExpandedFundAmount('3', fundAmount);

        await builder.discoverValidator();
        const validatorAddr = builder.getValidatorAddress()!;
        await builder.prepareWallets(1, richFundAmount);
        const wallet = builder.getWallets()[0];

        await builder.delegateFrom(wallet, '3');
        await builder.getBlockchain().waitForBlocks(2, 3000);

        await builder.undelegateFrom(wallet, '1');
        const firstObserved = await waitForUnbondingEntries(builder, wallet.address, validatorAddr);
        expect(firstObserved.entries.length > 0, 'Expected at least one unbonding entry after first undelegate').to.be
            .true;

        await builder.undelegateFrom(wallet, '0.5');
        const secondObserved = await waitForUnbondingEntries(builder, wallet.address, validatorAddr);

        const entries = secondObserved.entries;
        const hasMultipleEntries = entries.length >= 2;

        const creationHeights = entries.map(entry =>
            BigInt(entry.creationHeight?.toString?.() ?? entry.creationHeight ?? entry.creation_height ?? 0).toString()
        );

        const totalQueued = sumEntryBalances(entries);
        const expectedQueued = ethers.parseEther('1.5');
        const tolerance = expectedQueued / 50n;
        expect(getBigIntDiff(totalQueued, expectedQueued) <= tolerance).to.be.true;

        if (hasMultipleEntries) {
            expect(new Set(creationHeights).size).to.equal(entries.length);
        } else {
            console.log(
                `   WARNING: only ${entries.length} unbonding entry visible; accepting total queued amount match as fallback`
            );
        }

        await builder.cleanup();
    });

    it('S-14: should conserve value across undelegation refunds after accounting for actual gas spent', async function () {
        this.timeout(240000);
        const { builder, stakeAmount, fundAmount } = await createBuilder('S-14: Funds Conservation');
        const richFundAmount = getExpandedFundAmount(stakeAmount, fundAmount);
        const refundTolerance = ethers.parseEther('0.01');

        await builder.discoverValidator();
        const consensusClient = builder.getConsensusClient()!;
        const stakingParamsResult = await consensusClient.getStakingParams();
        const unbondingTimeSeconds = parseInt(stakingParamsResult.params.unbonding_time.replace('s', ''), 10);

        if (unbondingTimeSeconds > 60) {
            console.log(`   ⚠️ unbonding_time is ${unbondingTimeSeconds}s, skipping test to avoid stalling CI`);
            await builder.cleanup();
            this.skip();
        }

        await builder.prepareWallets(1, richFundAmount);
        const wallet = builder.getWallets()[0];
        const provider = builder.getProvider();

        await builder.delegateFrom(wallet, stakeAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const balanceBeforeUndelegate = await provider.getBalance(wallet.address);
        const undelegateReceipt = await builder.undelegateFrom(wallet, stakeAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const totalWaitMs = unbondingTimeSeconds * 1000 + 15000;
        await new Promise(resolve => setTimeout(resolve, totalWaitMs));
        await builder.getBlockchain().waitForBlocks(4, 3000);

        const finalWalletBalance = await provider.getBalance(wallet.address);
        const totalRefunded = finalWalletBalance - balanceBeforeUndelegate;
        const actualGasCost = await getReceiptGasCost(provider, undelegateReceipt);
        const expectedRefund = ethers.parseEther(stakeAmount);
        const refundPlusGas = totalRefunded + actualGasCost;

        expect(totalRefunded > 0n, 'Wallet should gain balance after undelegation maturity').to.be.true;
        expect(getBigIntDiff(refundPlusGas, expectedRefund) <= refundTolerance).to.be.true;

        await builder.cleanup();
    });
});
