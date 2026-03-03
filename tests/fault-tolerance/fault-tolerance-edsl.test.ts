import '../../setup';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { Blockchain } from '../../src/core/Blockchain';
import { FaultToleranceTestBuilder, FaultToleranceConfig } from '../../src/blockchain/test-library';
import { Config } from '../../src/utils/common';
import path from 'path';
import fs from 'fs';

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
chai.use(chaiAsPromised);

/**
 * IMPORTANT: Fault Tolerance Test Configuration
 *
 * BFT consensus requires >2/3 of voting power online for the network to progress.
 * You MUST adjust `networkShouldProgress` based on your validator count:
 *
 * | Validators | Stop 1 (%) | Stop 2 (%) | Network Halts When |
 * |------------|------------|------------|---------------------|
 * | 4          | 25%        | 50%        | Stop >= 2 (>= 34%)  |
 * | 5          | 20%        | 40%        | Stop >= 2 (>= 34%)  |
 * | 6          | 17%        | 33%        | Stop >= 2 (>= 34%)  |
 * | 7          | 14%        | 29%        | Stop >= 3 (>= 34%)  |
 *
 * Current config assumes 4 validators with equal voting power (1 each):
 * - Stop 0-1: Network continues (>= 75% online)
 * - Stop 2+:  Network halts (< 67% online)
 */

// Configuration
const configPath = path.join(__dirname, '../config.json');
const envName = Config.envName;

// Load fault tolerance config from config.json
const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const ftConfig: FaultToleranceConfig = configData.testConfig?.faultTolerance ?? {};

describe('Consensus Fault Tolerance Tests', () => {
    let testBuilder: FaultToleranceTestBuilder;

    before(async () => {
        const runtimeManager = new RuntimeManager();
        await runtimeManager.connectToChainFromConfigFile(configPath, envName);
        const blockchain = runtimeManager.getChain(envName);
        if (!blockchain) {
            throw new Error(`Failed to connect to blockchain: ${envName}`);
        }
        testBuilder = new FaultToleranceTestBuilder(blockchain, ftConfig);
        console.log(`\n🔧 Fault Tolerance Test Configuration:`);
        console.log(`   Timeout: ${ftConfig.timeout / 1000 / 60} minutes`);
        console.log(`   Wait for block: ${ftConfig.waitTimeForBlock / 1000}s`);
        console.log(`   Wait for service: ${ftConfig.waitTimeForService / 1000}s`);
        console.log(`   Wait long period: ${ftConfig.waitTimeLong / 1000 / 60} minutes`);
    });

    after(async () => {
        await testBuilder.cleanup();
    });

    it('Consensus-FaultTolerance-01: test stop less than 1/3 voting power', async function () {
        this.timeout(ftConfig.timeout);

        await testBuilder
            .withTestName('Fault Tolerance: Stop Less Than 1/3 Voting Power')
            .withConfiguration({
                'Target voting power': 'less than 1/3 of total',
                'Expected behavior': 'Network should progress',
                Timeout: `${ftConfig.timeout / 1000 / 60} minutes`,
            })
            .withFaultToleranceParameters({
                scenario: 'less-than-one-third',
                networkShouldProgress: true,
            })
            .initialize()
            .then(builder => builder.getValidatorsToStop())
            .then(builder => builder.stopValidators())
            .then(builder => builder.checkNetworkStatusAfterStop())
            .then(builder => builder.verifyStoppedValidatorsNotAccessible())
            .then(builder => builder.restartValidators())
            .then(builder => builder.checkNetworkStatusAfterRestart())
            .then(builder => builder.analyzeResults());
    });

    // This test is skipped because it is not possible to achieve exactly 1/3 voting power with the current validator set
    it.skip('Consensus-FaultTolerance-02: test stop exactly 1/3 voting power', async function () {
        this.timeout(ftConfig.timeout);

        // BFT requires >2/3 online to progress
        await testBuilder
            .withTestName('Fault Tolerance: Stop Exactly 1/3 Voting Power')
            .withConfiguration({
                'Target voting power': 'exactly 1/3 of total',
                'Expected behavior': 'Network should halt (exactly 2/3 remaining does not satisfy >2/3 threshold)',
                Timeout: `${ftConfig.timeout / 1000 / 60} minutes`,
            })
            .withFaultToleranceParameters({
                scenario: 'exactly-one-third',
                networkShouldProgress: false,
            })
            .initialize()
            .then(builder => builder.getValidatorsToStop())
            .then(builder => builder.stopValidators())
            .then(builder => builder.checkNetworkStatusAfterStop())
            .then(builder => builder.verifyStoppedValidatorsNotAccessible())
            .then(builder => builder.restartValidators())
            .then(builder => builder.checkNetworkStatusAfterRestart())
            .then(builder => builder.analyzeResults());
    });

    it('Consensus-FaultTolerance-03: test stop more than 1/3 voting power', async function () {
        this.timeout(ftConfig.timeout);

        await testBuilder
            .withTestName('Fault Tolerance: Stop More Than 1/3 Voting Power')
            .withConfiguration({
                'Target voting power': 'more than 1/3 of total',
                'Expected behavior': 'Network should halt',
                Timeout: `${ftConfig.timeout / 1000 / 60} minutes`,
            })
            .withFaultToleranceParameters({
                scenario: 'more-than-one-third',
                networkShouldProgress: false,
            })
            .initialize()
            .then(builder => builder.getValidatorsToStop())
            .then(builder => builder.stopValidators())
            .then(builder => builder.checkNetworkStatusAfterStop())
            .then(builder => builder.verifyStoppedValidatorsNotAccessible())
            .then(builder => builder.restartValidators())
            .then(builder => builder.checkNetworkStatusAfterRestart())
            .then(builder => builder.analyzeResults());
    });

    it(`Consensus-FaultTolerance-04: test stop less than 1/3 voting power and wait for long period`, async function () {
        this.timeout(ftConfig.timeout + ftConfig.waitTimeLong); // Extended timeout for long wait

        const waitMinutes = ftConfig.waitTimeLong / 1000 / 60;
        await testBuilder
            .withTestName(`Fault Tolerance: Stop Less Than 1/3 Voting Power and wait for ${waitMinutes} minutes`)
            .withConfiguration({
                'Target voting power': 'less than 1/3 of total',
                'Extended wait': `${waitMinutes} minutes`,
                'Expected behavior': 'Network should progress throughout',
                Timeout: `${(ftConfig.timeout + ftConfig.waitTimeLong) / 1000 / 60} minutes`,
            })
            .withFaultToleranceParameters({
                scenario: 'less-than-one-third',
                networkShouldProgress: true,
            })
            .initialize()
            .then(builder => builder.getValidatorsToStop())
            .then(builder => builder.stopValidators())
            .then(builder => builder.checkNetworkStatusAfterStop())
            .then(builder => builder.verifyStoppedValidatorsNotAccessible())
            .then(builder => builder.waitForLongPeriod())
            .then(builder => builder.restartValidators())
            .then(builder => builder.checkNetworkStatusAfterRestart())
            .then(builder => builder.analyzeResults());
    });
});
