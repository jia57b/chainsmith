import { ethers } from 'ethers';
import { Blockchain } from '../../core/Blockchain';
import { BlockchainType, IConsensusLayerClient } from '../types';
import { CosmosConsensusClient } from '../clients/cosmos-consensus-client';

const DEFAULT_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000000800';

const DEFAULT_PRECOMPILE_ABI = [
    'function delegate(address delegatorAddress, string validatorAddress, uint256 amount) external returns (bool success)',
    'function undelegate(address delegatorAddress, string validatorAddress, uint256 amount) external returns (int64 completionTime)',
    'function redelegate(address delegatorAddress, string validatorSrcAddress, string validatorDstAddress, uint256 amount) external returns (int64 completionTime)',
    'function cancelUnbondingDelegation(address delegatorAddress, string validatorAddress, uint256 amount, uint256 creationHeight) external returns (bool success)',
    'function delegation(address delegatorAddress, string validatorAddress) external view returns (uint256 shares, tuple(string denom, uint256 amount) balance)',
    'function unbondingDelegation(address delegatorAddress, string validatorAddress) external view returns (tuple(string delegatorAddress, string validatorAddress, tuple(int64 creationHeight, int64 completionTime, uint256 initialBalance, uint256 balance, uint64 unbondingId, int64 unbondingOnHoldRefCount)[] entries) unbondingDelegation)',
    'function validator(address validatorAddress) external view returns (tuple(string operatorAddress, string consensusPubkey, bool jailed, uint8 status, uint256 tokens, uint256 delegatorShares, string description, int64 unbondingHeight, int64 unbondingTime, uint256 commission, uint256 minSelfDelegation) validator)',
    'event Delegate(address indexed delegatorAddress, address indexed validatorAddress, uint256 amount, uint256 newShares)',
    'event Unbond(address indexed delegatorAddress, address indexed validatorAddress, uint256 amount, uint256 completionTime)',
    'event Redelegate(address indexed delegatorAddress, address indexed validatorSrcAddress, address indexed validatorDstAddress, uint256 amount, uint256 completionTime)',
    'event CancelUnbondingDelegation(address indexed delegatorAddress, address indexed validatorAddress, uint256 amount, uint256 creationHeight)',
];

/**
 * Staking Test Builder - for staking workflow testing on Cosmos+EVM chains.
 *
 * Uses EVM staking precompile for delegation/undelegation.
 * Requires Cosmos consensus layer for validator discovery and voting power queries.
 */
export class StakingTestBuilder {
    private blockchain: Blockchain;
    private wallets: any[] = [];
    private testResults: any[] = [];
    private startTime: number = 0;
    private endTime: number = 0;
    private testName: string = '';
    private configuration: any = {};
    private validatorAddress?: string;
    private stakingAmount: string = '0.1';
    private votingPowerBefore: number = 0;
    private votingPowerAfterStake: number = 0;
    private votingPowerAfterUnstake: number = 0;
    private tokensBefore: bigint = 0n;
    private tokensAfterStake: bigint = 0n;
    private tokensAfterUnstake: bigint = 0n;
    private founderWallet: ethers.Wallet;
    private provider: ethers.JsonRpcProvider;
    private consensusClient: IConsensusLayerClient | null = null;
    private precompileAddress: string = DEFAULT_PRECOMPILE_ADDRESS;
    private precompileAbi: string[] = DEFAULT_PRECOMPILE_ABI;

    constructor(blockchain: Blockchain) {
        this.blockchain = blockchain;
        if (this.blockchain.executeLayer !== BlockchainType.EVM) {
            throw new Error(`Staking test requires EVM-compatible blockchain, got: ${blockchain.executeLayer}`);
        }

        if (!this.blockchain.founderWallet?.privateKey) {
            throw new Error('Founder wallet private key is required for staking tests');
        }

        this.provider = this.blockchain.getDefaultExecuteLayerClient().getProvider();
        this.founderWallet = this.blockchain.createFounderEthersWallet();

        if (this.blockchain.consensusLayer !== BlockchainType.COSMOS) {
            throw new Error('Staking test requires Cosmos consensus layer (Cosmos+EVM chain)');
        }
        this.consensusClient = this.blockchain.getDefaultConsensusLayerClient();
        console.log(`   Cosmos consensus layer detected`);
    }

    /**
     * Override the precompile address and ABI.
     */
    withPrecompile(address?: string, abi?: string[]): StakingTestBuilder {
        if (address) {
            this.precompileAddress = address;
        }
        if (abi) {
            this.precompileAbi = abi;
        }
        console.log(`   Using Precompile Address: ${this.precompileAddress}`);
        return this;
    }

    /**
     * Set test name and description
     */
    withTestName(name: string): StakingTestBuilder {
        this.testName = name;
        console.log(`\n=== ${name} ===`);
        return this;
    }

    /**
     * Set test configuration
     */
    withConfiguration(config: any): StakingTestBuilder {
        this.configuration = config;
        console.log(`   Test Configuration:`);
        Object.entries(config).forEach(([key, value]) => {
            console.log(`   ${key}: ${value}`);
        });
        return this;
    }

    /**
     * Set staking parameters.
     * For precompile mode, validatorAddress should be Cosmos bech32 format (e.g. kiivaloper1...).
     * If not provided, it will be auto-discovered from the REST API.
     */
    withStakingParameters(params: { stakingAmount?: string; validatorAddress?: string }): StakingTestBuilder {
        this.stakingAmount = params.stakingAmount ?? this.stakingAmount;
        this.validatorAddress = params.validatorAddress;
        console.log(`   Staking Parameters:`);
        console.log(`   Staking Amount: ${this.stakingAmount}`);
        console.log(`   Validator Address: ${this.validatorAddress ?? '(auto-discover from REST API)'}`);
        return this;
    }

    /**
     * Discover the first active validator's operator_address via Cosmos REST API.
     * Required for precompile mode if validatorAddress is not explicitly set.
     */
    async discoverValidator(): Promise<StakingTestBuilder> {
        if (this.validatorAddress) {
            console.log(`   Using provided validator: ${this.validatorAddress}`);
            return this;
        }

        if (!this.consensusClient) {
            throw new Error(
                'Consensus layer client required for validator discovery. Set validatorAddress manually or ensure Cosmos consensus is configured.'
            );
        }

        console.log(`\n   Discovering validators from Cosmos REST API...`);
        const response = await this.consensusClient.getStakingValidators();
        const validators = response.validators ?? [];

        if (validators.length === 0) {
            throw new Error('No validators found on chain');
        }

        // Pick the first bonded validator
        const bonded = validators.find((v: any) => v.status === 'BOND_STATUS_BONDED');
        const chosen = bonded ?? validators[0];
        this.validatorAddress = chosen.operator_address;

        console.log(`   Discovered validator: ${chosen.description?.moniker ?? 'Unknown'} (${this.validatorAddress})`);
        console.log(`   Tokens: ${chosen.tokens}, Status: ${chosen.status}`);

        return this;
    }

    /**
     * Prepare wallets for staking tests
     */
    async prepareWallets(count: number, fundingAmount: string = '1'): Promise<StakingTestBuilder> {
        console.log(`\n   Preparing ${count} wallets for staking workflow...`);

        const { wallets, fundingTransactions } = await this.blockchain.createAndFundWallets(count, fundingAmount);
        this.wallets = wallets;

        await this.blockchain.waitForTransactionConfirmations(fundingTransactions);

        console.log(`   Prepared ${this.wallets.length} wallets for staking workflow`);
        return this;
    }

    /**
     * Execute complete staking workflow test
     */
    async executeStakingWorkflow(): Promise<StakingTestBuilder> {
        console.log(`\n   Starting complete staking workflow test...`);
        this.startTime = Date.now();

        if (!this.validatorAddress) {
            await this.discoverValidator();
        }

        // Step 1: Record initial voting power
        await this.checkValidatorVotingPower('initial');

        // Step 2: Execute staking delegation
        await this.executeStakingStep();

        // Step 3: Wait for state to be committed before querying
        console.log(`\n   Step 3: Waiting for 2 blocks for state to settle...`);
        await this.blockchain.waitForBlocks(2, 3000);
        await this.checkValidatorVotingPower('after_stake');

        // Step 4: Wait for additional blocks
        console.log(`\n   Step 4: Waiting for 2 blocks...`);
        await this.blockchain.waitForBlocks(2, 3000);

        // Step 5: Execute unstaking/undelegation
        await this.executeUnstakingStep();

        // Step 6: Wait for state to be committed before querying
        console.log(`\n   Step 6: Waiting for 2 blocks for state to settle...`);
        await this.blockchain.waitForBlocks(2, 3000);
        await this.checkValidatorVotingPower('after_unstake');

        this.endTime = Date.now();
        return this;
    }

    /**
     * Execute only the delegation step (no unstaking, no voting power checks).
     * Useful for simple stake-only tests.
     */
    async executeDelegation(): Promise<StakingTestBuilder> {
        if (!this.validatorAddress) {
            await this.discoverValidator();
        }
        await this.executeStakingStep();
        return this;
    }

    /**
     * Execute staking delegation
     */
    private async executeStakingStep(): Promise<void> {
        console.log(`\n   Step 2: Executing staking delegation...`);

        const stakingResults = this.wallets.map(async (wallet, index) => {
            try {
                console.log(`   Wallet ${index + 1} delegating ${this.stakingAmount}...`);

                const stakingTx = await this.performStakingDelegation(wallet, this.stakingAmount);

                console.log(`   Wallet ${index + 1} staking successful: ${stakingTx.hash}`);
                return {
                    success: true,
                    hash: stakingTx.hash,
                    index,
                    stakingAmount: this.stakingAmount,
                    walletAddress: wallet.address,
                    step: 'staking',
                };
            } catch (error) {
                console.error(`   Wallet ${index + 1} staking failed: ${error}`);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    index,
                    stakingAmount: this.stakingAmount,
                    walletAddress: wallet.address,
                    step: 'staking',
                };
            }
        });

        const results = await Promise.all(stakingResults);
        this.testResults.push(...results);

        const successfulStaking = results.filter(r => r.success).length;
        console.log(`   Staking results: ${successfulStaking}/${this.wallets.length} successful`);
    }

    /**
     * Execute unstaking/withdrawal
     */
    private async executeUnstakingStep(): Promise<void> {
        console.log(`\n   Step 5: Executing unstaking/withdrawal...`);

        const unstakingResults = this.wallets.map(async (wallet, index) => {
            try {
                console.log(`   Wallet ${index + 1} unstaking ${this.stakingAmount}...`);

                const unstakingTx = await this.performStakingWithdrawal(wallet);

                console.log(`   Wallet ${index + 1} unstaking successful: ${unstakingTx.hash}`);
                return {
                    success: true,
                    hash: unstakingTx.hash,
                    index,
                    unstakingAmount: this.stakingAmount,
                    walletAddress: wallet.address,
                    step: 'unstaking',
                };
            } catch (error) {
                console.error(`   Wallet ${index + 1} unstaking failed: ${error}`);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    index,
                    unstakingAmount: this.stakingAmount,
                    walletAddress: wallet.address,
                    step: 'unstaking',
                };
            }
        });

        const results = await Promise.all(unstakingResults);
        this.testResults.push(...results);

        const successfulUnstaking = results.filter(r => r.success).length;
        console.log(`   Unstaking results: ${successfulUnstaking}/${this.wallets.length} successful`);
    }

    /**
     * Check validator voting power at different stages.
     * Tracks both raw tokens (bigint, precise) and human-readable voting power.
     */
    private async checkValidatorVotingPower(stage: string): Promise<void> {
        const stepNum = stage === 'initial' ? '1' : stage === 'after_stake' ? '3' : '6';
        console.log(`\n   Step ${stepNum}: Checking validator voting power (${stage})...`);

        try {
            const { votingPower, rawTokens } = await this.getValidatorVotingPowerDetailed();
            const expectedChangeWei = ethers.parseEther(this.stakingAmount);

            switch (stage) {
                case 'initial':
                    this.votingPowerBefore = votingPower;
                    this.tokensBefore = rawTokens;
                    console.log(`   Initial voting power: ${votingPower}`);
                    console.log(`   Initial raw tokens: ${rawTokens.toString()}`);
                    break;

                case 'after_stake': {
                    this.votingPowerAfterStake = votingPower;
                    this.tokensAfterStake = rawTokens;
                    const tokenIncrease = rawTokens - this.tokensBefore;
                    console.log(`   Voting power after staking: ${votingPower}`);
                    console.log(`   Raw tokens after staking: ${rawTokens.toString()}`);
                    console.log(
                        `   Token increase: ${ethers.formatEther(tokenIncrease)} (raw: ${tokenIncrease.toString()})`
                    );
                    console.log(`   Expected increase: ${this.stakingAmount} (raw: ${expectedChangeWei.toString()})`);

                    const stakeSuccessCount = this.testResults.filter(r => r.step === 'staking' && r.success).length;
                    const expectedTotal = expectedChangeWei * BigInt(stakeSuccessCount);
                    if (stakeSuccessCount > 0 && expectedTotal > 0n) {
                        const diff =
                            tokenIncrease > expectedTotal
                                ? tokenIncrease - expectedTotal
                                : expectedTotal - tokenIncrease;
                        const tolerance = expectedTotal / 100n;
                        const matched = diff <= tolerance;
                        console.log(
                            `   Delegation amount validation: ${matched ? 'PASS' : 'WARN'} (diff: ${ethers.formatEther(diff)})`
                        );
                    }
                    break;
                }

                case 'after_unstake': {
                    this.votingPowerAfterUnstake = votingPower;
                    this.tokensAfterUnstake = rawTokens;
                    const tokenDecrease = this.tokensAfterStake - rawTokens;
                    const netChange = rawTokens - this.tokensBefore;
                    console.log(`   Voting power after unstaking: ${votingPower}`);
                    console.log(`   Raw tokens after unstaking: ${rawTokens.toString()}`);
                    console.log(
                        `   Token decrease from peak: ${ethers.formatEther(tokenDecrease)} (raw: ${tokenDecrease.toString()})`
                    );
                    console.log(`   Expected decrease: ${this.stakingAmount} (raw: ${expectedChangeWei.toString()})`);
                    console.log(`   Net change from initial: ${ethers.formatEther(netChange)}`);

                    const unstakeSuccessCount = this.testResults.filter(
                        r => r.step === 'unstaking' && r.success
                    ).length;
                    const expectedUnstakeTotal = expectedChangeWei * BigInt(unstakeSuccessCount);
                    if (unstakeSuccessCount > 0 && expectedUnstakeTotal > 0n) {
                        const diff =
                            tokenDecrease > expectedUnstakeTotal
                                ? tokenDecrease - expectedUnstakeTotal
                                : expectedUnstakeTotal - tokenDecrease;
                        const tolerance = expectedUnstakeTotal / 100n;
                        const matched = diff <= tolerance;
                        console.log(
                            `   Undelegation amount validation: ${matched ? 'PASS' : 'WARN'} (diff: ${ethers.formatEther(diff)})`
                        );
                    }
                    break;
                }
            }
        } catch (error) {
            console.error(`   Failed to check voting power at ${stage}:`, error);
        }
    }

    private getStakingContract(wallet: ethers.Wallet): ethers.Contract {
        return new ethers.Contract(this.precompileAddress, this.precompileAbi, wallet);
    }

    private getStakingInterface(): ethers.Interface {
        return new ethers.Interface(this.precompileAbi);
    }

    private async performStakingDelegation(wallet: any, amount: string): Promise<any> {
        return this.performPrecompileDelegation(wallet, amount);
    }

    private async performStakingWithdrawal(wallet: any): Promise<any> {
        return this.performPrecompileUndelegation(wallet, this.stakingAmount);
    }

    private async getValidatorVotingPowerDetailed(): Promise<{ votingPower: number; rawTokens: bigint }> {
        return this.getValidatorVotingPowerFromRest();
    }

    // ========================================================================
    // Precompile mode: real EVM staking precompile calls
    // ========================================================================

    private async performPrecompileDelegation(wallet: ethers.Wallet, amount: string): Promise<any> {
        if (!this.validatorAddress) {
            throw new Error('Validator address (bech32) required for precompile delegation');
        }

        const contract = this.getStakingContract(wallet);
        const amountWei = ethers.parseEther(amount);

        console.log(
            `   Precompile delegate: delegator=${wallet.address}, validator=${this.validatorAddress}, amount=${amountWei.toString()}`
        );

        // delegate is NOT payable — the precompile debits `amount` from the delegator's
        // Cosmos bank balance via the staking keeper. Do NOT send msg.value.
        const tx = await contract.delegate(wallet.address, this.validatorAddress, amountWei, {
            gasLimit: 500000,
        });

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
            throw new Error(`Delegation tx reverted (status=${receipt?.status})`);
        }

        const delegateEvents = receipt.logs.filter(
            (log: any) => log.address?.toLowerCase() === this.precompileAddress.toLowerCase()
        );
        console.log(
            `   Delegation tx confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}, precompile logs: ${delegateEvents.length}`
        );

        // Verify delegation via precompile view call
        const delegation = await this.queryDelegation(wallet.address);
        if (delegation && delegation.amount > 0n) {
            console.log(
                `   Delegation verified: shares=${delegation.shares.toString()}, amount=${ethers.formatEther(delegation.amount)} ${delegation.denom}`
            );
        } else {
            console.warn(`   WARNING: delegation query returned no result — delegate may have failed silently`);
        }

        return receipt;
    }

    private async performPrecompileUndelegation(wallet: ethers.Wallet, amount: string): Promise<any> {
        if (!this.validatorAddress) {
            throw new Error('Validator address (bech32) required for precompile undelegation');
        }

        const contract = this.getStakingContract(wallet);
        const amountWei = ethers.parseEther(amount);

        console.log(
            `   Precompile undelegate: delegator=${wallet.address}, validator=${this.validatorAddress}, amount=${amountWei.toString()}`
        );

        const tx = await contract.undelegate(wallet.address, this.validatorAddress, amountWei, {
            gasLimit: 500000,
        });

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
            throw new Error(`Undelegation tx reverted (status=${receipt?.status})`);
        }

        const undelegateEvents = receipt.logs.filter(
            (log: any) => log.address?.toLowerCase() === this.precompileAddress.toLowerCase()
        );
        console.log(
            `   Undelegation tx confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}, precompile logs: ${undelegateEvents.length}`
        );
        return receipt;
    }

    /**
     * Query validator tokens (voting power) from Cosmos REST API.
     * Returns both the human-readable integer and the raw token bigint for precise comparison.
     */
    private async getValidatorVotingPowerFromRest(): Promise<{ votingPower: number; rawTokens: bigint }> {
        try {
            const client = this.consensusClient as CosmosConsensusClient;
            const response = await client.getStakingValidator(this.validatorAddress!);
            const validator = response.validator;

            if (!validator?.tokens) {
                console.log(`   Validator tokens not found, returning 0`);
                return { votingPower: 0, rawTokens: 0n };
            }

            const rawTokens = BigInt(validator.tokens);
            const votingPower = Number(rawTokens / BigInt(10 ** 18));

            console.log(
                `   REST query - Validator: ${validator.description?.moniker ?? 'Unknown'}, tokens: ${validator.tokens}, voting power: ${votingPower}`
            );
            return { votingPower, rawTokens };
        } catch (error) {
            console.error(`   Failed to query validator voting power from REST:`, error);
            return { votingPower: 0, rawTokens: 0n };
        }
    }

    /**
     * Query delegation info for a delegator via precompile view function
     */
    async queryDelegation(
        delegatorAddress: string,
        validatorAddr?: string
    ): Promise<{ shares: bigint; denom: string; amount: bigint } | null> {
        const valAddr = validatorAddr ?? this.validatorAddress;
        if (!valAddr) {
            throw new Error('Validator address required for delegation query');
        }

        try {
            const contract = new ethers.Contract(this.precompileAddress, this.precompileAbi, this.provider);
            const result = await contract.delegation(delegatorAddress, valAddr);
            return {
                shares: result.shares,
                denom: result.balance.denom,
                amount: result.balance.amount,
            };
        } catch {
            console.log(`   No delegation found for ${delegatorAddress} -> ${valAddr}`);
            return null;
        }
    }

    // ========================================================================
    // Results analysis and cleanup
    // ========================================================================

    /**
     * Analyze and report test results
     */
    analyzeResults(): StakingTestBuilder {
        const duration = this.endTime - this.startTime;
        const stakingResults = this.testResults.filter(r => r.step === 'staking');
        const unstakingResults = this.testResults.filter(r => r.step === 'unstaking');

        const successfulStaking = stakingResults.filter(r => r.success);
        const successfulUnstaking = unstakingResults.filter(r => r.success);

        console.log(`\n   Complete Staking Workflow Results Summary:`);
        console.log(`   Test: ${this.testName}`);
        console.log(`   Total duration: ${duration}ms (${(duration / 1000 / 60).toFixed(2)} minutes)`);
        console.log(`\n   Staking Operations:`);
        console.log(`   Successful staking: ${successfulStaking.length}/${stakingResults.length}`);
        if (stakingResults.length > 0) {
            console.log(
                `   Staking success rate: ${((successfulStaking.length / stakingResults.length) * 100).toFixed(2)}%`
            );
        }
        console.log(`   Total amount staked: ${successfulStaking.length * Number(this.stakingAmount)}`);

        console.log(`\n   Unstaking Operations:`);
        console.log(`   Successful unstaking: ${successfulUnstaking.length}/${unstakingResults.length}`);
        if (unstakingResults.length > 0) {
            console.log(
                `   Unstaking success rate: ${((successfulUnstaking.length / unstakingResults.length) * 100).toFixed(2)}%`
            );
        }

        console.log(`\n   Voting Power Analysis:`);
        console.log(`   Initial voting power: ${this.votingPowerBefore}`);
        console.log(
            `   After staking: ${this.votingPowerAfterStake} (+${this.votingPowerAfterStake - this.votingPowerBefore})`
        );
        console.log(
            `   After unstaking: ${this.votingPowerAfterUnstake} (${this.votingPowerAfterUnstake - this.votingPowerAfterStake})`
        );
        console.log(`   Net change: ${this.votingPowerAfterUnstake - this.votingPowerBefore}`);

        const tokenIncrease = this.tokensAfterStake - this.tokensBefore;
        const tokenDecrease = this.tokensAfterStake - this.tokensAfterUnstake;
        const expectedWei = ethers.parseEther(this.stakingAmount) * BigInt(successfulStaking.length);
        const expectedUnstakeWei = ethers.parseEther(this.stakingAmount) * BigInt(successfulUnstaking.length);

        console.log(`\n   Precise Token Validation:`);
        console.log(`   Tokens before: ${ethers.formatEther(this.tokensBefore)}`);
        console.log(`   Tokens after stake: ${ethers.formatEther(this.tokensAfterStake)}`);
        console.log(`   Tokens after unstake: ${ethers.formatEther(this.tokensAfterUnstake)}`);
        console.log(
            `   Increase from staking: ${ethers.formatEther(tokenIncrease)} (expected: ${ethers.formatEther(expectedWei)})`
        );
        console.log(
            `   Decrease from unstaking: ${ethers.formatEther(tokenDecrease)} (expected: ${ethers.formatEther(expectedUnstakeWei)})`
        );

        const stakingValid = tokenIncrease > 0n;
        const unstakingValid = tokenDecrease > 0n;
        console.log(
            `   Staking: ${stakingValid ? 'PASS' : 'FAIL'} - tokens increased by ${ethers.formatEther(tokenIncrease)}`
        );
        console.log(
            `   Unstaking: ${unstakingValid ? 'PASS' : 'FAIL'} - tokens decreased by ${ethers.formatEther(tokenDecrease)}`
        );

        return this;
    }

    /**
     * Clean up resources
     */
    async cleanup(): Promise<StakingTestBuilder> {
        console.log(`\n   Cleaning up staking workflow resources...`);

        await new Promise(resolve => setTimeout(resolve, 2000));

        if (this.provider) {
            try {
                this.provider.destroy();
                console.log(`   Provider cleanup completed`);
            } catch {
                console.log(`   Provider cleanup completed with warnings`);
            }
        }

        return this;
    }

    /**
     * Get test results
     */
    getResults(): any[] {
        return this.testResults;
    }

    /**
     * Get wallets
     */
    getWallets(): any[] {
        return this.wallets;
    }

    /**
     * Get the discovered/configured validator address
     */
    getValidatorAddress(): string | undefined {
        return this.validatorAddress;
    }

    /**
     * Get voting power recorded before staking
     */
    getVotingPowerBefore(): number {
        return this.votingPowerBefore;
    }

    /**
     * Get voting power recorded after staking
     */
    getVotingPowerAfterStake(): number {
        return this.votingPowerAfterStake;
    }

    /**
     * Get voting power recorded after unstaking
     */
    getVotingPowerAfterUnstake(): number {
        return this.votingPowerAfterUnstake;
    }

    /**
     * Get the consensus layer client (for direct REST queries in tests)
     */
    getConsensusClient(): IConsensusLayerClient | null {
        return this.consensusClient;
    }

    /**
     * Get raw tokens recorded at each stage (precise bigint values, no precision loss)
     */
    getTokensBefore(): bigint {
        return this.tokensBefore;
    }

    getTokensAfterStake(): bigint {
        return this.tokensAfterStake;
    }

    getTokensAfterUnstake(): bigint {
        return this.tokensAfterUnstake;
    }

    // ========================================================================
    // Public single-operation methods for granular tests
    // ========================================================================

    /**
     * Delegate a specific amount from a wallet to the configured (or specified) validator.
     * Returns the transaction receipt.
     */
    async delegateFrom(wallet: ethers.Wallet, amount: string, validatorAddr?: string): Promise<any> {
        const target = validatorAddr ?? this.validatorAddress;
        if (!target) {
            throw new Error('Validator address required');
        }
        const savedAddr = this.validatorAddress;
        this.validatorAddress = target;
        try {
            return await this.performPrecompileDelegation(wallet, amount);
        } finally {
            this.validatorAddress = savedAddr;
        }
    }

    /**
     * Undelegate a specific amount from a wallet.
     * Returns the transaction receipt.
     */
    async undelegateFrom(wallet: ethers.Wallet, amount: string, validatorAddr?: string): Promise<any> {
        const target = validatorAddr ?? this.validatorAddress;
        if (!target) {
            throw new Error('Validator address required');
        }
        const savedAddr = this.validatorAddress;
        this.validatorAddress = target;
        try {
            return await this.performPrecompileUndelegation(wallet, amount);
        } finally {
            this.validatorAddress = savedAddr;
        }
    }

    /**
     * Redelegate tokens from one validator to another via the precompile.
     */
    async redelegateFrom(
        wallet: ethers.Wallet,
        srcValidator: string,
        dstValidator: string,
        amount: string
    ): Promise<any> {
        const contract = this.getStakingContract(wallet);
        const amountWei = ethers.parseEther(amount);

        console.log(
            `   Precompile redelegate: delegator=${wallet.address}, src=${srcValidator}, dst=${dstValidator}, amount=${amountWei.toString()}`
        );

        const tx = await contract.redelegate(wallet.address, srcValidator, dstValidator, amountWei, {
            gasLimit: 500000,
        });

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
            throw new Error(`Redelegation tx reverted (status=${receipt?.status})`);
        }

        console.log(
            `   Redelegation tx confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`
        );
        return receipt;
    }

    /**
     * Cancel an unbonding delegation entry using its creation height.
     */
    async cancelUnbondingDelegationFrom(
        wallet: ethers.Wallet,
        amount: string,
        creationHeight: bigint | number | string,
        validatorAddr?: string
    ): Promise<any> {
        const target = validatorAddr ?? this.validatorAddress;
        if (!target) {
            throw new Error('Validator address required');
        }

        const contract = this.getStakingContract(wallet);
        const amountWei = ethers.parseEther(amount);
        const normalizedCreationHeight = BigInt(creationHeight.toString());

        console.log(
            `   Precompile cancelUnbondingDelegation: delegator=${wallet.address}, validator=${target}, amount=${amountWei.toString()}, creationHeight=${normalizedCreationHeight.toString()}`
        );

        const tx = await contract.cancelUnbondingDelegation(
            wallet.address,
            target,
            amountWei,
            normalizedCreationHeight,
            {
                gasLimit: 500000,
            }
        );

        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
            throw new Error(`Cancel unbonding tx reverted (status=${receipt?.status})`);
        }

        console.log(
            `   Cancel unbonding tx confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`
        );
        return receipt;
    }

    /**
     * Query unbonding delegation info via precompile view function.
     */
    async queryUnbondingDelegation(delegatorAddress: string, validatorAddr?: string): Promise<any | null> {
        const valAddr = validatorAddr ?? this.validatorAddress;
        if (!valAddr) {
            throw new Error('Validator address required');
        }

        try {
            const contract = new ethers.Contract(this.precompileAddress, this.precompileAbi, this.provider);
            const result = await contract.unbondingDelegation(delegatorAddress, valAddr);
            return result;
        } catch {
            console.log(`   No unbonding delegation found for ${delegatorAddress} -> ${valAddr}`);
            return null;
        }
    }

    /**
     * Query validator info via precompile view function.
     * NOTE: the precompile `validator(address)` expects the EVM address of the validator.
     */
    async queryValidatorViaPrecompile(validatorEvmAddress: string): Promise<any | null> {
        try {
            const contract = new ethers.Contract(this.precompileAddress, this.precompileAbi, this.provider);
            const result = await contract.validator(validatorEvmAddress);
            return result;
        } catch {
            console.log(`   No validator info found for ${validatorEvmAddress}`);
            return null;
        }
    }

    /**
     * Discover multiple bonded validators. Returns an array of operator_addresses.
     */
    async discoverMultipleValidators(count: number = 2): Promise<string[]> {
        if (!this.consensusClient) {
            throw new Error('Consensus layer client required for validator discovery');
        }

        const response = await this.consensusClient.getStakingValidators();
        const validators = response.validators ?? [];
        const bonded = validators.filter((v: any) => v.status === 'BOND_STATUS_BONDED');
        const chosen = bonded.length >= count ? bonded.slice(0, count) : validators.slice(0, count);

        if (chosen.length < count) {
            throw new Error(`Need ${count} validators but only found ${chosen.length}`);
        }

        const addresses = chosen.map((v: any) => v.operator_address);
        console.log(`   Discovered ${addresses.length} validators: ${addresses.join(', ')}`);
        return addresses;
    }

    /**
     * Query validator tokens (raw bigint) from REST API.
     */
    async getValidatorTokens(validatorAddr?: string): Promise<bigint> {
        const addr = validatorAddr ?? this.validatorAddress;
        if (!addr) {
            throw new Error('Validator address required');
        }
        const client = this.consensusClient as CosmosConsensusClient;
        const response = await client.getStakingValidator(addr);
        const tokens = response.validator?.tokens;
        return tokens ? BigInt(tokens) : 0n;
    }

    /**
     * Get the provider for direct balance queries in tests.
     */
    getProvider(): ethers.JsonRpcProvider {
        return this.provider;
    }

    /**
     * Get the blockchain instance for direct access in tests.
     */
    getBlockchain(): Blockchain {
        return this.blockchain;
    }

    /**
     * Decode staking-related precompile logs from a transaction receipt.
     */
    decodeStakingEvents(receipt: any): Array<{ name: string; args: any; log: any }> {
        const iface = this.getStakingInterface();
        const stakingLogs = receipt.logs.filter(
            (log: any) => log.address?.toLowerCase() === this.precompileAddress.toLowerCase()
        );

        const parsed: Array<{ name: string; args: any; log: any }> = [];
        for (const log of stakingLogs) {
            try {
                const decoded = iface.parseLog(log);
                parsed.push({ name: decoded?.name ?? 'unknown', args: decoded?.args, log });
            } catch {
                // Ignore logs not decodable by the staking ABI.
            }
        }

        return parsed;
    }

    // ========================================================================
}
