import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import path from 'path';
import chai from 'chai';
import { Blockchain } from '../../core/Blockchain';
import { AvalanchePlatformClient } from '../clients/avalanche-platform-client';

const { expect } = chai;
const execFile = promisify(execFileCallback);

const NAVAX_PER_AVAX = 1_000_000_000n;
const LEGACY_NAVAX_THRESHOLD = 1_000_000n;
const DEFAULT_VALIDATOR_BALANCE_AVAX = '0.1';
const DEFAULT_PCHAIN_FEE_BUFFER_NAVAX = 10_000_000n;
const DEFAULT_HEALTH_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_WAIT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_RESIDUAL_CLEANUP_TIMEOUT_MS = 240_000;

type AvaxAmountSource = 'avax' | 'legacy-navax';

export interface NormalizedAvaxAmount {
    raw: string;
    normalizedAvax: string;
    nAvax: bigint;
    source: AvaxAmountSource;
}

export function formatNAvaxAsAvax(value: bigint): string {
    const sign = value < 0 ? '-' : '';
    const absoluteValue = value < 0 ? -value : value;
    const whole = absoluteValue / NAVAX_PER_AVAX;
    const fractional = (absoluteValue % NAVAX_PER_AVAX).toString().padStart(9, '0').replace(/0+$/, '');

    return `${sign}${whole.toString()}${fractional ? `.${fractional}` : ''}`;
}

export function parseAvaxToNAvax(rawValue: string): bigint {
    const trimmed = rawValue.trim();
    const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) {
        throw new Error(`Invalid AVAX amount: ${rawValue}`);
    }

    const whole = BigInt(match[1]);
    const fractionalPart = match[2] ?? '';
    if (fractionalPart.length > 9) {
        throw new Error(`AVAX amount supports at most 9 decimal places: ${rawValue}`);
    }

    const paddedFractional = fractionalPart.padEnd(9, '0');
    return whole * NAVAX_PER_AVAX + BigInt(paddedFractional || '0');
}

export function normalizeConfiguredAvaxAmount(
    rawValue: string | undefined,
    defaultAvaxValue: string = DEFAULT_VALIDATOR_BALANCE_AVAX
): NormalizedAvaxAmount {
    const raw = (rawValue ?? defaultAvaxValue).trim();

    if (/^\d+$/.test(raw)) {
        const integerValue = BigInt(raw);
        if (integerValue >= LEGACY_NAVAX_THRESHOLD) {
            return {
                raw,
                normalizedAvax: formatNAvaxAsAvax(integerValue),
                nAvax: integerValue,
                source: 'legacy-navax',
            };
        }
    }

    const nAvax = parseAvaxToNAvax(raw);
    return {
        raw,
        normalizedAvax: formatNAvaxAsAvax(nAvax),
        nAvax,
        source: 'avax',
    };
}

export interface AvalancheDiscoveredNodeConfig {
    nodeId?: string;
    uri?: string;
    controlPlaneRpcUrl?: string;
    infoApiUrl?: string;
    healthApiUrl?: string;
    blsPublicKey?: string;
    blsProofOfPossession?: string;
}

export interface AvalancheValidatorLifecycleOptions {
    avalancheCliChainName: string;
    validatorManagementType?: string;
    subnetId?: string;
    blockchainId?: string;
    validatorManagerRpcEndpoint?: string;
    changeOwnerAddress?: string;
    validatorManagerOwner?: string;
    feePayerPChainAddress?: string;
    validatorLifecycle?: {
        feePayerMode?: 'stored-key' | 'ledger';
        feePayerStoredKey?: string | null;
        defaultBalance?: string;
        defaultWeight?: number;
        removeForce?: boolean;
        minRequiredPChainBalance?: string;
    };
    primaryNodes?: AvalancheDiscoveredNodeConfig[];
}

export class AvalancheValidatorLifecycleTestBuilder {
    private blockchain: Blockchain;
    private client: AvalanchePlatformClient;
    private options: AvalancheValidatorLifecycleOptions;
    private results: Map<string, { success: boolean; data?: any; error?: string }> = new Map();
    private initialValidators: any[] = [];
    private candidatePrimaryNode: AvalancheDiscoveredNodeConfig | null = null;
    private candidateWasAdded = false;
    private candidateRemovalInitiated = false;

    constructor(blockchain: Blockchain, options: AvalancheValidatorLifecycleOptions) {
        this.blockchain = blockchain;
        this.options = options;

        const node = blockchain.getActiveNotBootNodes()[0];
        this.client = new AvalanchePlatformClient(
            {
                name: blockchain.name,
                timeout: blockchain.timeout,
                nativeToken: blockchain.nativeToken,
                addressPrefix: blockchain.addressPrefix,
            },
            {
                rpcEndpoint: node.controlPlaneRpcUrl ?? blockchain.controlPlaneRpcUrl,
                infoEndpoint: node.infoApiUrl ?? blockchain.infoApiUrl,
                healthEndpoint: node.healthApiUrl ?? blockchain.healthApiUrl,
            }
        );
    }

    async initialize(): Promise<AvalancheValidatorLifecycleTestBuilder> {
        const resolvedFeePayerPChainAddress = this.getResolvedFeePayerPChainAddress();

        console.log(`\n🔧 Avalanche Validator Lifecycle Test Configuration:`);
        console.log(`   Chain: ${this.blockchain.name}`);
        console.log(`   CLI Chain Name: ${this.options.avalancheCliChainName}`);
        console.log(`   Validator Management Type: ${this.options.validatorManagementType ?? 'unknown'}`);
        console.log(`   Subnet ID: ${this.options.subnetId ?? 'N/A'}`);
        console.log(`   Blockchain ID: ${this.options.blockchainId ?? 'N/A'}`);
        console.log(`   Validator Manager RPC: ${this.options.validatorManagerRpcEndpoint ?? 'N/A'}`);
        console.log(`   Change Owner Address: ${this.options.changeOwnerAddress ?? 'N/A'}`);
        console.log(`   Fee P-Chain Address: ${resolvedFeePayerPChainAddress ?? 'N/A'}`);
        console.log(`   Discovered Primary Nodes: ${this.options.primaryNodes?.length ?? 0}`);

        this.initialValidators = await this.client.getCurrentValidators(this.options.subnetId);
        await this.cleanupResidualPrimaryValidators();
        this.initialValidators = await this.client.getCurrentValidators(this.options.subnetId);
        console.log(`   Current Validator Count: ${this.initialValidators.length}`);

        return this;
    }

    private getResolvedFeePayerPChainAddress(): string | undefined {
        return this.options.feePayerPChainAddress ?? this.options.changeOwnerAddress;
    }

    private getNormalizedValidatorBalance(): NormalizedAvaxAmount {
        return normalizeConfiguredAvaxAmount(
            this.options.validatorLifecycle?.defaultBalance,
            DEFAULT_VALIDATOR_BALANCE_AVAX
        );
    }

    private getConfiguredMinimumRequiredPChainBalance(): NormalizedAvaxAmount {
        return normalizeConfiguredAvaxAmount(
            this.options.validatorLifecycle?.minRequiredPChainBalance,
            DEFAULT_VALIDATOR_BALANCE_AVAX
        );
    }

    private getEffectiveMinimumRequiredPChainBalance(): {
        configuredMinimum: NormalizedAvaxAmount;
        validatorBalance: NormalizedAvaxAmount;
        effectiveMinimumNAvax: bigint;
    } {
        const configuredMinimum = this.getConfiguredMinimumRequiredPChainBalance();
        const validatorBalance = this.getNormalizedValidatorBalance();
        const recommendedMinimum = validatorBalance.nAvax + DEFAULT_PCHAIN_FEE_BUFFER_NAVAX;
        const effectiveMinimumNAvax =
            configuredMinimum.nAvax > recommendedMinimum ? configuredMinimum.nAvax : recommendedMinimum;

        return {
            configuredMinimum,
            validatorBalance,
            effectiveMinimumNAvax,
        };
    }

    async verifyFeePayerBalance(): Promise<AvalancheValidatorLifecycleTestBuilder> {
        const feePayerPChainAddress = this.getResolvedFeePayerPChainAddress();
        const { configuredMinimum, validatorBalance, effectiveMinimumNAvax } =
            this.getEffectiveMinimumRequiredPChainBalance();

        if (!feePayerPChainAddress) {
            throw new Error('feePayerPChainAddress is required for validator lifecycle preflight');
        }

        const balanceResponse = await this.client.getBalance([feePayerPChainAddress]);

        console.log(`\n💰 Checking P-Chain fee payer balance...`);
        console.log(`   Address: ${feePayerPChainAddress}`);
        console.log(
            `   Requested validator balance: ${validatorBalance.normalizedAvax} AVAX (${validatorBalance.nAvax.toString()} nAVAX)`
        );
        console.log(`   Requested validator balance raw config: ${validatorBalance.raw} [${validatorBalance.source}]`);
        console.log(
            `   Configured minimum required: ${configuredMinimum.normalizedAvax} AVAX (${configuredMinimum.nAvax.toString()} nAVAX)`
        );
        console.log(
            `   Effective minimum required: ${formatNAvaxAsAvax(effectiveMinimumNAvax)} AVAX (${effectiveMinimumNAvax.toString()} nAVAX)`
        );
        console.log(
            `   Balance: ${balanceResponse.balance.toString()} nAVAX (~${formatNAvaxAsAvax(balanceResponse.balance)} AVAX)`
        );
        console.log(
            `   Unlocked: ${balanceResponse.unlocked.toString()} nAVAX (~${formatNAvaxAsAvax(balanceResponse.unlocked)} AVAX)`
        );
        console.log(
            `   Locked stakeable: ${balanceResponse.lockedStakeable.toString()} nAVAX (~${formatNAvaxAsAvax(balanceResponse.lockedStakeable)} AVAX)`
        );
        console.log(
            `   Locked not stakeable: ${balanceResponse.lockedNotStakeable.toString()} nAVAX (~${formatNAvaxAsAvax(balanceResponse.lockedNotStakeable)} AVAX)`
        );

        expect(
            balanceResponse.unlocked >= effectiveMinimumNAvax,
            `insufficient P-Chain unlocked balance for fee payer ${feePayerPChainAddress}: ` +
                `have ${balanceResponse.unlocked.toString()}, need at least ${effectiveMinimumNAvax.toString()}`
        ).to.equal(true);

        this.results.set('feePayerBalance', {
            success: true,
            data: {
                address: feePayerPChainAddress,
                balance: balanceResponse.balance.toString(),
                unlocked: balanceResponse.unlocked.toString(),
                lockedStakeable: balanceResponse.lockedStakeable.toString(),
                lockedNotStakeable: balanceResponse.lockedNotStakeable.toString(),
                requestedValidatorBalance: validatorBalance.normalizedAvax,
                requestedValidatorBalanceNAvax: validatorBalance.nAvax.toString(),
                requestedValidatorBalanceRaw: validatorBalance.raw,
                requestedValidatorBalanceSource: validatorBalance.source,
                configuredMinimumRequired: configuredMinimum.nAvax.toString(),
                minimumRequired: effectiveMinimumNAvax.toString(),
            },
        });

        return this;
    }

    selectCandidatePrimaryNode(): AvalancheValidatorLifecycleTestBuilder {
        const currentValidatorNodeIds = new Set(this.initialValidators.map((validator: any) => validator.nodeID));
        this.candidatePrimaryNode =
            (this.options.primaryNodes ?? []).find(node => node.nodeId && !currentValidatorNodeIds.has(node.nodeId)) ??
            null;

        expect(
            this.candidatePrimaryNode,
            'expected at least one discovered primary node not currently validating the L1'
        ).to.not.equal(null);

        console.log(
            `\n🎯 Selected candidate primary node: ${this.candidatePrimaryNode?.nodeId} (${this.candidatePrimaryNode?.uri})`
        );

        return this;
    }

    selectGhostValidatorCandidate(candidate: AvalancheDiscoveredNodeConfig): AvalancheValidatorLifecycleTestBuilder {
        expect(candidate.nodeId, 'ghost validator candidate nodeId is required').to.be.a('string').and.not.empty;
        expect(candidate.blsPublicKey, 'ghost validator candidate blsPublicKey is required').to.be.a('string').and.not
            .empty;
        expect(candidate.blsProofOfPossession, 'ghost validator candidate blsProofOfPossession is required').to.be.a(
            'string'
        ).and.not.empty;

        this.candidatePrimaryNode = candidate;

        console.log(`\n👻 Selected ghost validator candidate: ${candidate.nodeId}`);
        return this;
    }

    selectConfiguredValidatorCandidate(
        candidate: AvalancheDiscoveredNodeConfig
    ): AvalancheValidatorLifecycleTestBuilder {
        expect(candidate.nodeId, 'configured validator candidate nodeId is required').to.be.a('string').and.not.empty;

        this.candidatePrimaryNode = candidate;

        console.log(
            `\n🧩 Selected configured validator candidate: ${candidate.nodeId} (${candidate.uri ?? 'no endpoint'})`
        );
        return this;
    }

    private async isCandidateCurrentlyValidator(): Promise<boolean> {
        if (!this.candidatePrimaryNode?.nodeId) {
            return false;
        }

        const validators = await this.client.getCurrentValidators(this.options.subnetId);
        return validators.some((validator: any) => validator.nodeID === this.candidatePrimaryNode?.nodeId);
    }

    private async waitForPlatformHealthy(
        timeoutMs: number = DEFAULT_HEALTH_WAIT_TIMEOUT_MS,
        pollIntervalMs: number = DEFAULT_HEALTH_WAIT_POLL_INTERVAL_MS
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        let lastError: string | null = null;

        while (Date.now() < deadline) {
            try {
                const health = await this.client.getHealth();
                if (health?.healthy === true) {
                    return;
                }
                lastError = `health API returned healthy=${String(health?.healthy)}`;
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }

            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error(`Timed out waiting for platform health. Last result: ${lastError ?? 'unknown error'}`);
    }

    private async waitForBlockchainVisible(
        timeoutMs: number = DEFAULT_HEALTH_WAIT_TIMEOUT_MS,
        pollIntervalMs: number = DEFAULT_HEALTH_WAIT_POLL_INTERVAL_MS
    ): Promise<void> {
        if (!this.options.blockchainId) {
            return;
        }

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const blockchain = await this.client.getBlockchain(this.options.blockchainId);
                if (blockchain) {
                    return;
                }
            } catch {
                // Retry until the deadline.
            }

            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error(`Timed out waiting for blockchain ${this.options.blockchainId} to become visible`);
    }

    private async waitForValidatorRemovedByNodeId(
        nodeId: string,
        timeoutMs: number = DEFAULT_RESIDUAL_CLEANUP_TIMEOUT_MS,
        pollIntervalMs: number = DEFAULT_HEALTH_WAIT_POLL_INTERVAL_MS
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const validators = await this.client.getCurrentValidators(this.options.subnetId);
            const found = validators.find((validator: any) => validator.nodeID === nodeId);
            if (!found) {
                return;
            }

            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error(`Timed out waiting for residual validator ${nodeId} to be removed`);
    }

    private async cleanupResidualPrimaryValidators(): Promise<void> {
        const currentValidators = await this.client.getCurrentValidators(this.options.subnetId);
        const primaryNodeMap = new Map(
            (this.options.primaryNodes ?? []).filter(node => node.nodeId).map(node => [node.nodeId!, node])
        );
        const residualValidators = currentValidators.filter((validator: any) => primaryNodeMap.has(validator.nodeID));

        if (!residualValidators.length) {
            return;
        }

        console.log(
            `\n🧹 Found ${residualValidators.length} residual discovered primary validator(s) from a previous run. Cleaning up...`
        );

        for (const validator of residualValidators) {
            const node = primaryNodeMap.get(validator.nodeID);
            if (!node?.uri) {
                console.warn(
                    `   ⚠️ Residual validator ${validator.nodeID} has no known URI. Skipping automatic cleanup.`
                );
                continue;
            }

            console.log(`   Removing residual validator ${validator.nodeID} (${node.uri})...`);
            await this.waitForPlatformHealthy();
            await this.waitForBlockchainVisible();
            await this.verifyExecutionSmoke();

            const scriptPath = path.join(process.cwd(), 'chains', 'avalanche-cli-local', 'remove-validator.sh');
            const args = [
                '--chain-name',
                this.options.avalancheCliChainName,
                '--node-endpoint',
                node.uri,
                '--validator-manager-owner',
                this.options.validatorManagerOwner ?? '',
            ];

            args.push('--fee-payer-mode', this.options.validatorLifecycle?.feePayerMode ?? 'stored-key');
            if (this.options.validatorLifecycle?.feePayerMode !== 'ledger') {
                args.push('--fee-payer-stored-key', this.options.validatorLifecycle?.feePayerStoredKey ?? 'ewoq');
            }
            if (this.options.validatorLifecycle?.removeForce !== false) {
                args.push('--force');
            }

            await execFile(scriptPath, args);
            await this.waitForValidatorRemovedByNodeId(validator.nodeID);
            console.log(`   ✅ Residual validator ${validator.nodeID} removed`);
        }
    }

    async addValidator(): Promise<AvalancheValidatorLifecycleTestBuilder> {
        if (!this.candidatePrimaryNode?.uri && !this.candidatePrimaryNode?.nodeId) {
            throw new Error('Candidate validator is not selected');
        }
        if (!this.options.changeOwnerAddress) {
            throw new Error('changeOwnerAddress is required for PoA addValidator');
        }
        if (!this.options.validatorManagerRpcEndpoint) {
            throw new Error('validatorManagerRpcEndpoint is required for PoA addValidator');
        }
        if (!this.options.validatorManagerOwner) {
            throw new Error('validatorManagerOwner is required for PoA addValidator');
        }

        console.log(`\n➕ Adding validator ${this.candidatePrimaryNode.nodeId}...`);

        const scriptPath = path.join(process.cwd(), 'chains', 'avalanche-cli-local', 'add-validator.sh');
        const validatorBalance = this.getNormalizedValidatorBalance();
        const args = [
            '--chain-name',
            this.options.avalancheCliChainName,
            '--rpc',
            this.options.validatorManagerRpcEndpoint,
            '--remaining-balance-owner',
            this.options.changeOwnerAddress,
            '--disable-owner',
            this.options.changeOwnerAddress,
            '--validator-manager-owner',
            this.options.validatorManagerOwner,
            '--balance',
            validatorBalance.normalizedAvax,
            '--weight',
            String(this.options.validatorLifecycle?.defaultWeight ?? 20),
        ];

        if (this.candidatePrimaryNode.uri) {
            args.push('--node-endpoint', this.candidatePrimaryNode.uri);
        } else {
            args.push(
                '--node-id',
                this.candidatePrimaryNode.nodeId!,
                '--bls-public-key',
                this.candidatePrimaryNode.blsPublicKey!,
                '--bls-proof-of-possession',
                this.candidatePrimaryNode.blsProofOfPossession!
            );
        }

        console.log(
            `   Validator balance passed to CLI: ${validatorBalance.normalizedAvax} AVAX (raw config: ${validatorBalance.raw} [${validatorBalance.source}])`
        );

        args.push('--fee-payer-mode', this.options.validatorLifecycle?.feePayerMode ?? 'stored-key');
        if (this.options.validatorLifecycle?.feePayerMode !== 'ledger') {
            args.push('--fee-payer-stored-key', this.options.validatorLifecycle?.feePayerStoredKey ?? 'ewoq');
        }

        try {
            await execFile(scriptPath, args);
        } catch (error) {
            if (await this.isCandidateCurrentlyValidator()) {
                this.candidateWasAdded = true;
                console.warn(
                    `   ⚠️ Validator ${this.candidatePrimaryNode.nodeId} appears in the validator set even though add-validator exited with an error. Continuing with validation and cleanup.`
                );
                this.results.set('addValidatorCommand', {
                    success: true,
                    data: {
                        nodeId: this.candidatePrimaryNode.nodeId,
                        completedWithCliError: true,
                        cliError: error instanceof Error ? error.message : String(error),
                    },
                });
                return this;
            }
            throw error;
        }

        this.candidateWasAdded = true;
        this.results.set('addValidatorCommand', { success: true, data: { nodeId: this.candidatePrimaryNode.nodeId } });
        return this;
    }

    async waitForValidatorAdded(
        timeoutMs: number = 180000,
        pollIntervalMs: number = 3000
    ): Promise<AvalancheValidatorLifecycleTestBuilder> {
        if (!this.candidatePrimaryNode?.nodeId) {
            throw new Error('Candidate primary node is not selected');
        }

        console.log(`\n⏳ Waiting for validator to appear in current validator set...`);
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const validators = await this.client.getCurrentValidators(this.options.subnetId);
            const found = validators.find((validator: any) => validator.nodeID === this.candidatePrimaryNode?.nodeId);
            if (found) {
                console.log(`   ✅ Validator ${this.candidatePrimaryNode.nodeId} is now in the validator set`);
                this.results.set('validatorAdded', {
                    success: true,
                    data: { validatorCount: validators.length, nodeId: this.candidatePrimaryNode.nodeId },
                });
                return this;
            }

            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error(`Timed out waiting for validator ${this.candidatePrimaryNode.nodeId} to be added`);
    }

    async removeValidator(): Promise<AvalancheValidatorLifecycleTestBuilder> {
        if (!this.candidatePrimaryNode?.uri && !this.candidatePrimaryNode?.nodeId) {
            throw new Error('Candidate validator is not selected');
        }
        if (!this.options.validatorManagerRpcEndpoint) {
            throw new Error('validatorManagerRpcEndpoint is required for PoA removeValidator');
        }
        if (!this.options.validatorManagerOwner) {
            throw new Error('validatorManagerOwner is required for PoA removeValidator');
        }

        console.log(`\n➖ Removing validator ${this.candidatePrimaryNode.nodeId}...`);
        console.log(`   Verifying execution health before validator removal...`);

        await this.verifyPlatformHealthy();
        await this.verifyBlockchainVisibility();
        await this.verifyExecutionSmoke();
        this.candidateRemovalInitiated = true;

        const scriptPath = path.join(process.cwd(), 'chains', 'avalanche-cli-local', 'remove-validator.sh');
        const args = [
            '--chain-name',
            this.options.avalancheCliChainName,
            '--validator-manager-owner',
            this.options.validatorManagerOwner,
        ];

        if (this.candidatePrimaryNode.uri) {
            args.push('--node-endpoint', this.candidatePrimaryNode.uri);
        } else {
            args.push('--node-id', this.candidatePrimaryNode.nodeId!);
        }

        args.push('--fee-payer-mode', this.options.validatorLifecycle?.feePayerMode ?? 'stored-key');
        if (this.options.validatorLifecycle?.feePayerMode !== 'ledger') {
            args.push('--fee-payer-stored-key', this.options.validatorLifecycle?.feePayerStoredKey ?? 'ewoq');
        }

        if (this.options.validatorLifecycle?.removeForce !== false) {
            args.push('--force');
        }

        try {
            await execFile(scriptPath, args);
        } catch (error) {
            if (!(await this.isCandidateCurrentlyValidator())) {
                this.candidateWasAdded = false;
                this.candidateRemovalInitiated = false;
                this.results.set('removeValidatorCommand', {
                    success: true,
                    data: {
                        nodeId: this.candidatePrimaryNode.nodeId,
                        completedWithCliError: true,
                        cliError: error instanceof Error ? error.message : String(error),
                    },
                });
                return this;
            }
            throw error;
        }

        this.results.set('removeValidatorCommand', {
            success: true,
            data: { nodeId: this.candidatePrimaryNode.nodeId },
        });
        return this;
    }

    async waitForValidatorRemoved(
        timeoutMs: number = 180000,
        pollIntervalMs: number = 3000
    ): Promise<AvalancheValidatorLifecycleTestBuilder> {
        if (!this.candidatePrimaryNode?.nodeId) {
            throw new Error('Candidate primary node is not selected');
        }

        console.log(`\n⏳ Waiting for validator to disappear from current validator set...`);
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const validators = await this.client.getCurrentValidators(this.options.subnetId);
            const found = validators.find((validator: any) => validator.nodeID === this.candidatePrimaryNode?.nodeId);
            if (!found) {
                console.log(
                    `   ✅ Validator ${this.candidatePrimaryNode.nodeId} has been removed from the validator set`
                );
                this.results.set('validatorRemoved', {
                    success: true,
                    data: { validatorCount: validators.length, nodeId: this.candidatePrimaryNode.nodeId },
                });
                this.candidateWasAdded = false;
                this.candidateRemovalInitiated = false;
                return this;
            }

            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        throw new Error(`Timed out waiting for validator ${this.candidatePrimaryNode.nodeId} to be removed`);
    }

    async verifyPlatformHealthy(): Promise<AvalancheValidatorLifecycleTestBuilder> {
        await this.waitForPlatformHealthy();
        this.results.set('platformHealthy', { success: true, data: { healthy: true } });
        console.log(`\n✅ Platform health remains healthy after lifecycle operation`);
        return this;
    }

    async verifyBlockchainVisibility(): Promise<AvalancheValidatorLifecycleTestBuilder> {
        if (!this.options.blockchainId) {
            console.log(`\n⏭️  No blockchainId provided, skipping blockchain visibility check`);
            return this;
        }

        await this.waitForBlockchainVisible();
        this.results.set('blockchainVisible', { success: true, data: { blockchainId: this.options.blockchainId } });
        console.log(`\n✅ Blockchain ${this.options.blockchainId} remains visible`);
        return this;
    }

    async verifyExecutionSmoke(): Promise<AvalancheValidatorLifecycleTestBuilder> {
        const founderAddress = this.blockchain.founderWallet?.address;
        expect(founderAddress, 'founder wallet address is required').to.be.a('string').and.not.empty;

        const result = await this.blockchain.sendAndConfirm(founderAddress!, '0.001');
        expect(result).to.not.equal(null);
        this.results.set('executionSmoke', { success: true, data: result });
        console.log(`\n✅ Execution smoke transaction confirmed in block ${result?.blockNumber}`);
        return this;
    }

    assertResults(): AvalancheValidatorLifecycleTestBuilder {
        for (const [name, result] of this.results) {
            expect(result.success, `${name} should succeed: ${result.error ?? 'unknown error'}`).to.equal(true);
        }
        return this;
    }

    async cleanup(): Promise<void> {
        const candidateNeedsCleanup =
            this.candidateWasAdded ||
            (!!this.candidatePrimaryNode?.nodeId && (await this.isCandidateCurrentlyValidator()));

        if (candidateNeedsCleanup) {
            try {
                this.candidateWasAdded = true;
                if (!this.candidateRemovalInitiated) {
                    await this.removeValidator();
                } else {
                    console.log(
                        `   Cleanup detected an in-flight validator removal. Waiting for validator to disappear...`
                    );
                }
                await this.waitForValidatorRemoved();
            } catch (error) {
                console.warn(
                    `Failed to cleanup added validator: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

        await this.blockchain.cleanup();
    }
}
