import chai from 'chai';
import { Blockchain } from '../../core/Blockchain';
import { IConsensusLayerClient } from '../types';

const { expect } = chai;

// ============================================================================
// COSMOS API TEST BUILDER - Using Blockchain object and consensus layer client
// ============================================================================
export class CosmosApiTestBuilder {
    private blockchain: Blockchain;
    private consensusClient: IConsensusLayerClient;
    private testResults: Map<string, any> = new Map();
    private validators: any[] = [];
    private supportedModules: string[];

    constructor(blockchain: Blockchain, supportedModules: string[] = []) {
        this.blockchain = blockchain;
        this.consensusClient = blockchain.getDefaultConsensusLayerClient();
        this.supportedModules = supportedModules;
    }

    private isModuleSupported(moduleName: string): boolean {
        return this.supportedModules.includes(moduleName);
    }

    /**
     * Initialize and test basic connectivity
     */
    async initialize(): Promise<CosmosApiTestBuilder> {
        console.log(`\n🔧 Cosmos API Test Configuration:`);
        console.log(`   REST Endpoint: ${this.consensusClient.restEndpoint}`);
        console.log(`   RPC Endpoint: ${this.consensusClient.rpcEndpoint}`);
        console.log(`   Chain ID: ${this.blockchain.chainId}`);

        // Test basic connectivity using RPC /health endpoint
        const connected = await this.consensusClient.isConnected();
        if (connected) {
            this.testResults.set('connectivity', { success: true });
            console.log(`   ✅ Consensus client connectivity confirmed`);
        } else {
            this.testResults.set('connectivity', { success: false, error: 'RPC health check failed' });
            console.log(`   ⚠️ Consensus client connectivity failed, continuing with available endpoints`);
        }

        return this;
    }

    /**
     * Test Staking Module APIs - Using default paths
     * Validates field-level structure of validators, params, and pool responses.
     */
    async testStakingModule(): Promise<CosmosApiTestBuilder> {
        if (!this.isModuleSupported('staking')) {
            console.log(`\n⏭️  Skipping Staking Module (not in supportedCosmosModules)`);
            return this;
        }
        console.log(`\n⚡ Testing Staking Module APIs (Default Paths)`);

        try {
            const validatorsResponse = await this.consensusClient.getStakingValidators();
            this.validators = this.extractValidatorsFromResponse(validatorsResponse);
            expect(this.validators).to.be.an('array').with.length.greaterThan(0);
            for (const v of this.validators) {
                expect(v).to.have.property('operator_address');
                expect(v).to.have.property('tokens');
                expect(v).to.have.property('status');
            }
            this.testResults.set('staking_validators_default', {
                success: true,
                count: this.validators.length,
            });
            console.log(`   ✅ Found ${this.validators.length} validators (default path)`);
            for (const [i, v] of this.validators.entries()) {
                console.log(
                    `     ${i + 1}. ${v.description?.moniker ?? 'Unknown'} (${v.operator_address}) - tokens: ${v.tokens}, status: ${v.status}`
                );
            }
        } catch (error: any) {
            this.testResults.set('staking_validators_default', { success: false, error: error.message });
            console.log(`   ❌ Staking validators query failed: ${error.message}`);
        }

        try {
            const paramsResponse = await this.consensusClient.getStakingParams();
            const params = this.extractParamsFromResponse(paramsResponse);
            expect(params).to.have.property('bond_denom');
            expect(params).to.have.property('unbonding_time');
            expect(params).to.have.property('max_validators');
            this.testResults.set('staking_params_default', { success: true, data: params });
            console.log(
                `   ✅ Staking parameters: bond_denom=${params.bond_denom}, unbonding_time=${params.unbonding_time}, max_validators=${params.max_validators}`
            );
        } catch (error: any) {
            this.testResults.set('staking_params_default', { success: false, error: error.message });
            console.log(`   ❌ Staking params query failed: ${error.message}`);
        }

        try {
            const poolResponse = await this.consensusClient.getStakingPool();
            const pool = this.extractPoolFromResponse(poolResponse);
            expect(pool).to.have.property('bonded_tokens');
            expect(pool).to.have.property('not_bonded_tokens');
            expect(BigInt(pool.bonded_tokens) > 0n).to.be.true;
            this.testResults.set('staking_pool_default', { success: true, data: pool });
            console.log(`   ✅ Staking pool: bonded=${pool.bonded_tokens}, not_bonded=${pool.not_bonded_tokens}`);
        } catch (error: any) {
            this.testResults.set('staking_pool_default', { success: false, error: error.message });
            console.log(`   ❌ Staking pool query failed: ${error.message}`);
        }

        return this;
    }

    /**
     * Test Staking Delegation queries for a given delegator address
     */
    async testStakingDelegations(delegatorAddr: string): Promise<CosmosApiTestBuilder> {
        console.log(`\n🔗 Testing Staking Delegation APIs for ${delegatorAddr}`);

        try {
            const delegationsResponse = await this.consensusClient.getDelegatorDelegations(delegatorAddr);
            const delegations = delegationsResponse.delegation_responses ?? [];
            this.testResults.set('staking_delegator_delegations', {
                success: true,
                count: delegations.length,
                data: delegations,
            });
            console.log(`   ✅ Found ${delegations.length} delegations for delegator`);
        } catch (error: any) {
            this.testResults.set('staking_delegator_delegations', {
                success: false,
                error: error.message,
            });
            console.log(`   ❌ Delegator delegations query failed: ${error.message}`);
        }

        try {
            const unbondingResponse = await this.consensusClient.getDelegatorUnbondingDelegations(delegatorAddr);
            const unbonding = unbondingResponse.unbonding_responses ?? [];
            this.testResults.set('staking_unbonding_delegations', {
                success: true,
                count: unbonding.length,
                data: unbonding,
            });
            console.log(`   ✅ Found ${unbonding.length} unbonding delegations`);
        } catch (error: any) {
            this.testResults.set('staking_unbonding_delegations', {
                success: false,
                error: error.message,
            });
            console.log(`   ❌ Unbonding delegations query failed: ${error.message}`);
        }

        try {
            const redelegationsResponse = await this.consensusClient.getDelegatorRedelegations(delegatorAddr);
            const redelegations = redelegationsResponse.redelegation_responses ?? [];
            this.testResults.set('staking_redelegations', {
                success: true,
                count: redelegations.length,
                data: redelegations,
            });
            console.log(`   ✅ Found ${redelegations.length} redelegations`);
        } catch (error: any) {
            this.testResults.set('staking_redelegations', {
                success: false,
                error: error.message,
            });
            console.log(`   ❌ Redelegations query failed: ${error.message}`);
        }

        try {
            const validatorsResponse = await this.consensusClient.getDelegatorValidators(delegatorAddr);
            const delegatorValidators = validatorsResponse.validators ?? [];
            this.testResults.set('staking_delegator_validators', {
                success: true,
                count: delegatorValidators.length,
                data: delegatorValidators,
            });
            console.log(`   ✅ Delegator has ${delegatorValidators.length} validators`);
        } catch (error: any) {
            this.testResults.set('staking_delegator_validators', {
                success: false,
                error: error.message,
            });
            console.log(`   ❌ Delegator validators query failed: ${error.message}`);
        }

        return this;
    }

    /**
     * Get stored validators (populated after testStakingModule)
     */
    getValidators(): any[] {
        return this.validators;
    }

    /**
     * Test single validator detail query via /staking/validators/{addr}.
     * Picks the first validator from cached list (requires testStakingModule() first).
     */
    async testValidatorDetail(): Promise<CosmosApiTestBuilder> {
        if (!this.isModuleSupported('staking_delegation')) {
            console.log(`\n⏭️  Skipping Validator Detail (not in supportedCosmosModules)`);
            return this;
        }
        if (this.validators.length === 0) {
            this.testResults.set('staking_validator_detail', {
                success: false,
                error: 'No validators available - call testStakingModule() first',
            });
            console.log(`   ⚠️ No validators available, skipping validator detail test`);
            return this;
        }

        const operatorAddr = this.validators[0].operator_address;
        console.log(`\n🔍 Testing Validator Detail for ${operatorAddr}`);

        try {
            const detailResponse = await this.consensusClient.getStakingValidator(operatorAddr);
            const detail = this.extractValidatorFromResponse(detailResponse);
            expect(detail).to.have.property('operator_address');
            expect(detail).to.have.property('tokens');
            expect(detail).to.have.property('status');
            this.testResults.set('staking_validator_detail', {
                success: true,
                data: {
                    moniker: detail?.description?.moniker,
                    tokens: detail?.tokens,
                    status: detail?.status,
                    operator_address: detail?.operator_address,
                },
            });
            console.log(
                `   ✅ Validator: ${detail?.description?.moniker ?? 'Unknown'}, tokens: ${detail?.tokens}, status: ${detail?.status}`
            );
        } catch (error: any) {
            this.testResults.set('staking_validator_detail', {
                success: false,
                error: error.message,
            });
            console.log(`   ❌ Validator detail query failed: ${error.message}`);
        }

        return this;
    }

    /**
     * Test validator delegations and delegator-side APIs:
     * 1. Pick the first validator from cached list (requires testStakingModule() first)
     * 2. Query the validator's delegation list to resolve a real delegator address
     * 3. Use that delegator address to query delegator-side APIs
     */
    async testValidatorDelegations(): Promise<CosmosApiTestBuilder> {
        if (!this.isModuleSupported('staking_delegation')) {
            console.log(`\n⏭️  Skipping Validator Delegations (not in supportedCosmosModules)`);
            return this;
        }
        if (this.validators.length === 0) {
            this.testResults.set('staking_validator_delegations', {
                success: false,
                error: 'No validators available - call testStakingModule() first',
            });
            console.log(`   ⚠️ No validators available, skipping delegation tests`);
            return this;
        }

        const operatorAddr = this.validators[0].operator_address;
        console.log(`\n🔗 Testing Validator Delegation APIs for ${operatorAddr}`);

        try {
            const valDelegations = await this.consensusClient.getValidatorDelegations(operatorAddr);
            const valDelegationList = valDelegations.delegation_responses ?? [];
            this.testResults.set('staking_validator_delegations', {
                success: true,
                count: valDelegationList.length,
            });
            console.log(`   ✅ Validator has ${valDelegationList.length} delegation(s)`);

            if (valDelegationList.length === 0) {
                console.log(`   ⚠️ No delegations found, skipping delegator queries`);
                return this;
            }

            const delegatorAddr = valDelegationList[0].delegation.delegator_address;
            console.log(`   Resolved delegator address: ${delegatorAddr}`);

            await this.testStakingDelegations(delegatorAddr);
        } catch (error: any) {
            this.testResults.set('staking_validator_delegations', {
                success: false,
                error: error.message,
            });
            console.log(`   ❌ Validator delegations query failed: ${error.message}`);
        }

        return this;
    }

    /**
     * Test Slashing Module APIs
     */
    async testSlashingModule(): Promise<CosmosApiTestBuilder> {
        if (!this.isModuleSupported('slashing')) {
            console.log(`\n⏭️  Skipping Slashing Module (not in supportedCosmosModules)`);
            return this;
        }
        console.log(`\n⚔️ Testing Slashing Module APIs`);

        try {
            const paramsResponse = await this.consensusClient.getSlashingParams();
            this.testResults.set('slashing_params', { success: true, data: paramsResponse });
            console.log(`   ✅ Slashing parameters retrieved`);
        } catch (error: any) {
            this.testResults.set('slashing_params', { success: false, error: error.message });
            console.log(`   ❌ Slashing params query failed: ${error.message}`);
        }

        return this;
    }

    /**
     * Test Mint Module APIs
     */
    async testMintModule(): Promise<CosmosApiTestBuilder> {
        if (!this.isModuleSupported('mint')) {
            console.log(`\n⏭️  Skipping Mint Module (not in supportedCosmosModules)`);
            return this;
        }
        console.log(`\n🪙 Testing Mint Module APIs`);

        try {
            const paramsResponse = await this.consensusClient.getMintParams();
            this.testResults.set('mint_params', { success: true, data: paramsResponse });
            console.log(`   ✅ Mint parameters retrieved`);
        } catch (error: any) {
            this.testResults.set('mint_params', { success: false, error: error.message });
            console.log(`   ❌ Mint params query failed: ${error.message}`);
        }

        return this;
    }

    /**
     * Helper method: Extract validator information from response
     */
    private extractValidatorsFromResponse(response: any): any[] {
        if (response.code === 200 && response.msg) {
            return response.msg.validators ?? [];
        } else if (response.validators) {
            return response.validators;
        } else if (response.result?.validators) {
            return response.result.validators;
        }
        return [];
    }

    /**
     * Helper method: Extract single validator information from response
     */
    private extractValidatorFromResponse(response: any): any {
        if (response?.code === 200 && response?.msg?.validator) {
            return response.msg.validator;
        } else if (response?.code === 200 && response?.msg?.operator_address) {
            return response.msg;
        } else if (response?.validator) {
            return response.validator;
        } else if (response?.result?.validator) {
            return response.result.validator;
        } else if (response?.operator_address) {
            return response;
        }
        return response;
    }

    /**
     * Helper method: Extract parameter information from response
     */
    private extractParamsFromResponse(response: any): any {
        if (response.code === 200 && response.msg) {
            return response.msg.params;
        } else if (response.params) {
            return response.params;
        } else if (response.result?.params) {
            return response.result.params;
        }
        return response;
    }

    /**
     * Helper method: Extract pool information from response
     */
    private extractPoolFromResponse(response: any): any {
        if (response.code === 200 && response.msg) {
            return response.msg.pool;
        } else if (response.pool) {
            return response.pool;
        } else if (response.result?.pool) {
            return response.result.pool;
        }
        return response;
    }

    /**
     * Assert all test results
     */
    assertResults(): CosmosApiTestBuilder {
        console.log(`\n📊 Cosmos API Test Results:`);

        let successCount = 0;
        let totalCount = 0;
        const failedTests: string[] = [];

        for (const [testName, result] of this.testResults) {
            totalCount++;
            if (result.success) {
                successCount++;
                console.log(`   ✅ ${testName}: PASSED`);
            } else {
                failedTests.push(testName);
                console.log(`   ❌ ${testName}: FAILED - ${result.error}`);
            }
        }

        console.log(`\n📈 Summary: ${successCount}/${totalCount} tests passed`);

        expect(successCount).to.equal(totalCount, `All supported modules must pass. Failed: ${failedTests.join(', ')}`);

        return this;
    }

    /**
     * Generate detailed test report
     */
    generateReport(): CosmosApiTestBuilder {
        console.log(`\n📋 Detailed API Test Report:`);

        if (this.validators.length > 0) {
            console.log(`   Validators: ${this.validators.length} found`);
            this.validators.slice(0, 4).forEach((validator, index) => {
                console.log(
                    `     ${index + 1}. ${validator.description?.moniker ?? 'Unknown'} (${validator.operator_address})`
                );
            });
        }

        // Record successful module tests
        const successfulModules = Array.from(this.testResults.entries())
            .filter(([_, result]) => result.success)
            .map(([name, _]) => name);

        console.log(`   Successful Modules: ${successfulModules.join(', ')}`);

        return this;
    }

    /**
     * Get the result of a specific test
     */
    getTestResult(testName: string): any {
        return this.testResults.get(testName);
    }

    /**
     * Clean up resources
     */
    async cleanup(): Promise<void> {
        await Promise.resolve(); // Satisfy the await requirement for async method
        this.testResults.clear();
        this.validators = [];
    }
}
