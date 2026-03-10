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

/**
 * Resolve staking parameters from config and env.
 * Priority: env vars > chain config > testConfig defaults.
 */
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

/**
 * End-to-end staking workflow tests.
 */
describe('Staking Workflow Tests', () => {
    it('should stake, verify voting power increase, unstake, and verify voting power decrease', async function () {
        this.timeout(180000);

        const { stakeAmount, fundAmount, precompileAddress } = getStakingParams();

        // ── 1. Connect ──────────────────────────────────────────────
        const rm = new RuntimeManager();
        await rm.connectToChainFromConfigFile(configPath, envName);
        const chain = rm.getChain(envName);
        if (!chain) throw new Error(`Failed to connect to chain: ${envName}`);

        const builder = new StakingTestBuilder(chain)
            .withTestName('E2E: Stake → Check VP → Unstake → Check VP')
            .withStakingParameters({ stakingAmount: stakeAmount })
            .withPrecompile(precompileAddress);

        // ── 2. Discover validator & prepare wallet ──────────────────
        await builder.discoverValidator();
        const validatorAddr = builder.getValidatorAddress()!;
        expect(validatorAddr).to.be.a('string').and.not.empty;
        console.log(`\n   Target validator: ${validatorAddr}`);

        await builder.prepareWallets(1, fundAmount);

        // ── 3. Execute full workflow: stake → wait → check → unstake → wait → check
        await builder.executeStakingWorkflow();

        // ── 4. Retrieve precise token snapshots ─────────────────────
        const tokensBefore = builder.getTokensBefore();
        const tokensAfterStake = builder.getTokensAfterStake();
        const tokensAfterUnstake = builder.getTokensAfterUnstake();
        const stakeWei = ethers.parseEther(stakeAmount);
        const tolerance = stakeWei / 100n; // 1% tolerance for share/token rounding

        const increase = tokensAfterStake - tokensBefore;
        const decrease = tokensAfterStake - tokensAfterUnstake;
        const netChange =
            tokensAfterUnstake > tokensBefore ? tokensAfterUnstake - tokensBefore : tokensBefore - tokensAfterUnstake;

        console.log(`\n   ── Token Summary ──`);
        console.log(`   Before staking  : ${ethers.formatEther(tokensBefore)}`);
        console.log(`   After staking   : ${ethers.formatEther(tokensAfterStake)}`);
        console.log(`   After unstaking : ${ethers.formatEther(tokensAfterUnstake)}`);
        console.log(`   Increase        : ${ethers.formatEther(increase)} (expected: ${stakeAmount})`);
        console.log(`   Decrease        : ${ethers.formatEther(decrease)} (expected: ${stakeAmount})`);
        console.log(`   Net change      : ${ethers.formatEther(netChange)} (expected: ~0)`);

        // ── 5. Assertions ───────────────────────────────────────────

        // After staking: tokens must increase by ~stakeAmount
        expect(increase > 0n, 'Tokens should increase after staking').to.be.true;
        const stakeDiff = increase > stakeWei ? increase - stakeWei : stakeWei - increase;
        expect(stakeDiff <= tolerance, `Stake increase ${ethers.formatEther(increase)} should be ~${stakeAmount}`).to.be
            .true;

        // After unstaking: tokens must decrease by ~stakeAmount from peak
        expect(decrease > 0n, 'Tokens should decrease after unstaking').to.be.true;
        const unstakeDiff = decrease > stakeWei ? decrease - stakeWei : stakeWei - decrease;
        expect(unstakeDiff <= tolerance, `Unstake decrease ${ethers.formatEther(decrease)} should be ~${stakeAmount}`)
            .to.be.true;

        // Net change from initial should be near zero
        expect(netChange < stakeWei, 'Net token change should be near zero after stake+unstake').to.be.true;

        // ── 6. Print summary ────────────────────────────────────────
        builder.analyzeResults();
        await builder.cleanup();

        console.log(`\n   ✅ PASS — Stake/unstake workflow completed, voting power changes verified`);
    });
});
