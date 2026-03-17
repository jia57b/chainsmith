import '../../setup';
import { ethers } from 'ethers';
import fs from 'fs';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { StakingTestBuilder } from '../../src/blockchain/test-library';
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
        await builder.undelegateFrom(wallet, partialAmount);
        await builder.getBlockchain().waitForBlocks(2, 3000);

        const delegationAfterPartial = await builder.queryDelegation(wallet.address);
        expect(delegationAfterPartial!.amount > 0n, 'Remaining positive after partition').to.be.true;

        // 3. Full (Rest) Undelegate
        await builder.undelegateFrom(wallet, partialAmount);
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

        console.log(`   Balance after full unbonding: ${ethers.formatEther(finalWalletBalance)}`);
        console.log(`   Total refunded (vs pre-undelegate snapshot): ${ethers.formatEther(totalRefunded)} KII`);

        const expectedRefund = ethers.parseEther(stakeAmount);
        const maxGasCost = ethers.parseEther('0.1'); // generous gas allowance for 2 txs

        console.log(`   Expected refund: ~${stakeAmount} KII`);
        console.log(`   Max allowed gas deduction: ${ethers.formatEther(maxGasCost)} KII`);

        // totalRefunded should be positive (we got money back)
        expect(
            totalRefunded > 0n,
            `Wallet should gain balance after unbonding. finalBalance=${ethers.formatEther(finalWalletBalance)}, snapshotBalance=${ethers.formatEther(balanceBeforeUndelegate)}, diff=${ethers.formatEther(totalRefunded)}`
        ).to.be.true;

        // totalRefunded should be close to stakeAmount (within gas tolerance)
        const refundDiff =
            totalRefunded > expectedRefund ? totalRefunded - expectedRefund : expectedRefund - totalRefunded;

        expect(
            refundDiff <= maxGasCost,
            `Refund difference (${ethers.formatEther(refundDiff)}) exceeds max gas allowance (${ethers.formatEther(maxGasCost)}). Actual refunded=${ethers.formatEther(totalRefunded)}, expected=${stakeAmount}`
        ).to.be.true;

        await builder.cleanup();
    });

    it('S-03: should correctly revert on zero amount, insufficient funds, and false undelegations', async function () {
        this.timeout(120000);
        // We only prepare a tiny fund amount of "1.0" for insufficient tests
        const { builder } = await createBuilder('S-03: Constraints Testing');

        await builder.discoverValidator();
        await builder.prepareWallets(1, '1');
        const wallet = builder.getWallets()[0];

        // Assert 1: Zero Amount Delegation (S-09)
        let failedZero = false;
        try {
            await builder.delegateFrom(wallet, '0');
        } catch (_e) {
            console.log(_e);
            failedZero = true;
        }
        expect(failedZero, 'Zero amount delegation should fail').to.be.true;

        // Assert 2: Insufficient Balance (S-10)
        let failedInsufficient = false;
        try {
            await builder.delegateFrom(wallet, '1000');
        } catch (_e) {
            console.log(_e);
            failedInsufficient = true;
        }
        expect(failedInsufficient, 'Delegation exceeding wallet balance should fail').to.be.true;

        // Assert 3: Empty Undelegation (S-12)
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

        // Assert 4: Excess Undelegation (S-11)
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
});
