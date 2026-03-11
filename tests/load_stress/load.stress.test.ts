import '../../setup';
import { ethers } from 'ethers';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { Blockchain } from '../../src/core/Blockchain';
import { LoadStressTestBuilder, LoadStressConfig } from '../../src/blockchain/test-library';
import { Config } from '../../src/utils/common';
import path from 'path';
import fs from 'fs';

// Configuration paths
const chainConfigPath = path.join(__dirname, '../config.json');
const loadStressConfigPath = path.join(__dirname, '../load-stress.config.json');
const envName = Config.envName;

// Load stress test configuration
interface LoadStressTestConfig {
    environments: {
        [key: string]: {
            createNewWallet: boolean;
            fundingAmount: string;
            testTransactionAmount: string;
            fundingBatchSize?: number;
            fundingBatchDelayMs?: number;
            wallets?: { privateKey: string }[];
        };
    };
    tests: {
        [key: string]: {
            name: string;
            description: string;
            sourceWalletCount: number;
            destWalletCount: number;
            timeout: number;
            batchSize?: number | number[];
            batchIntervalMs?: number;
            gasPricesGwei?: number[];
            testDuration?: number;
            targetTPS?: number;
        };
    };
}

function loadConfig(): LoadStressTestConfig {
    if (!fs.existsSync(loadStressConfigPath)) {
        throw new Error(
            `Load stress config not found: ${loadStressConfigPath}\n` +
                'Copy load-stress.config.example.json to load-stress.config.json and configure it.'
        );
    }
    return JSON.parse(fs.readFileSync(loadStressConfigPath, 'utf-8'));
}

function getEnvConfig(): LoadStressConfig {
    const config = loadConfig();
    const envConfig = config.environments[envName] || config.environments['local'];
    return {
        createNewWallet: envConfig.createNewWallet,
        fundingAmount: envConfig.fundingAmount,
        testTransactionAmount: envConfig.testTransactionAmount,
        fundingBatchSize: envConfig.fundingBatchSize,
        fundingBatchDelayMs: envConfig.fundingBatchDelayMs,
        wallets: envConfig.wallets,
    };
}

function getTestConfigFor(testName: string) {
    const config = loadConfig();
    const testConfig = config.tests[testName];
    if (!testConfig) {
        throw new Error(`Test configuration not found for: ${testName}`);
    }

    // Convert gasPricesGwei to wei (bigint)
    let gasPrices: bigint[] | undefined;
    if (testConfig.gasPricesGwei) {
        gasPrices = testConfig.gasPricesGwei.map(gwei => ethers.parseUnits(gwei.toString(), 'gwei'));
    }

    return {
        ...testConfig,
        gasPrices,
    };
}

// Stress and Load Tests
describe('Stress and Load Tests', () => {
    let blockchain: Blockchain;
    let envConfig: LoadStressConfig;

    before(async () => {
        envConfig = getEnvConfig();

        const runtimeManager = new RuntimeManager();
        await runtimeManager.connectToChainFromConfigFile(chainConfigPath, envName);
        const chain = runtimeManager.getChain(envName);
        if (!chain) {
            throw new Error(`Failed to connect to blockchain: ${envName}`);
        }
        blockchain = chain;
    });

    describe('Stress-01: Concurrent Test', () => {
        it('should test multiple source wallets sending transactions to destination wallet concurrently', async function () {
            const testConfig = getTestConfigFor('stress01');
            this.timeout(testConfig.timeout);

            const sourceBuilder = new LoadStressTestBuilder(blockchain, envConfig)
                .withTestName('Concurrent Test')
                .withConfiguration({
                    'Create New Wallets': envConfig.createNewWallet,
                    'Source Wallets': testConfig.sourceWalletCount,
                    'Destination Wallets': testConfig.destWalletCount,
                    'Transaction Amount': envConfig.testTransactionAmount,
                    Timeout: `${testConfig.timeout / 1000 / 60} minutes`,
                });

            const destBuilder = new LoadStressTestBuilder(blockchain, envConfig);

            const sourceWallets = await sourceBuilder.prepareWallets(
                testConfig.sourceWalletCount,
                envConfig.createNewWallet,
                true
            );
            const destWallets = await destBuilder.prepareWallets(
                testConfig.destWalletCount,
                envConfig.createNewWallet,
                false
            );

            const destAddress = destWallets.getWallets()[0].address;

            await sourceWallets
                .executeConcurrentLoadTest(destAddress)
                .then(builder => builder.analyzeResults())
                .then(builder => builder.cleanup());
        });
    });

    describe('Stress-02: Batch Transaction Test', () => {
        it('should test batch transactions with different batch sizes', async function () {
            const testConfig = getTestConfigFor('stress02');
            this.timeout(testConfig.timeout);

            const sourceBuilder = new LoadStressTestBuilder(blockchain, envConfig)
                .withTestName('Batch Transaction Test')
                .withConfiguration({
                    'Create New Wallets': envConfig.createNewWallet,
                    'Source Wallets': testConfig.sourceWalletCount,
                    'Destination Wallets': testConfig.destWalletCount,
                    'Batch Sizes': Array.isArray(testConfig.batchSize)
                        ? testConfig.batchSize.join(', ')
                        : testConfig.batchSize || 'N/A',
                    Timeout: `${testConfig.timeout / 1000 / 60} minutes`,
                });

            const destBuilder = new LoadStressTestBuilder(blockchain, envConfig);

            const sourceWallets = await sourceBuilder.prepareWallets(
                testConfig.sourceWalletCount,
                envConfig.createNewWallet,
                true
            );
            const destWallets = await destBuilder.prepareWallets(
                testConfig.destWalletCount,
                envConfig.createNewWallet,
                false
            );

            const destAddress = destWallets.getWallets()[0].address;

            const batchSizeArray = Array.isArray(testConfig.batchSize)
                ? testConfig.batchSize
                : [testConfig.batchSize || 10];
            for (const batchSize of batchSizeArray) {
                await sourceWallets
                    .executeBatchTransactionTest(destAddress, batchSize)
                    .then(builder => builder.analyzeResults())
                    .then(builder => builder.cleanup());
            }
        });
    });

    describe('Stress-03: Gas Price Optimization Test', () => {
        it('should test transactions with optimized gas pricing', async function () {
            const testConfig = getTestConfigFor('stress03');
            this.timeout(testConfig.timeout);

            const sourceBuilder = new LoadStressTestBuilder(blockchain, envConfig)
                .withTestName('Gas Price Optimization Test')
                .withConfiguration({
                    'Create New Wallets': envConfig.createNewWallet,
                    'Source Wallets': testConfig.sourceWalletCount,
                    'Destination Wallets': testConfig.destWalletCount,
                    'Gas Prices': testConfig.gasPrices
                        ? testConfig.gasPrices.map((gp: bigint) => ethers.formatUnits(gp, 'gwei') + ' Gwei').join(', ')
                        : 'N/A',
                    Timeout: `${testConfig.timeout / 1000 / 60} minutes`,
                });

            const destBuilder = new LoadStressTestBuilder(blockchain, envConfig);

            const sourceWallets = await sourceBuilder.prepareWallets(
                testConfig.sourceWalletCount,
                envConfig.createNewWallet,
                true
            );
            const destWallets = await destBuilder.prepareWallets(
                testConfig.destWalletCount,
                envConfig.createNewWallet,
                false
            );

            const destAddress = destWallets.getWallets()[0].address;

            await sourceWallets
                .executeGasPriceOptimizationTest(destAddress, testConfig.gasPrices || [])
                .then(builder => builder.analyzeResults())
                .then(builder => builder.cleanup());
        });
    });

    describe('Load-01: Sustained Load Test', () => {
        it('should perform sustained load test', async function () {
            const testConfig = getTestConfigFor('load01');
            this.timeout(testConfig.timeout);

            const sourceBuilder = new LoadStressTestBuilder(blockchain, envConfig)
                .withTestName('Sustained Load Test')
                .withConfiguration({
                    'Create New Wallets': envConfig.createNewWallet,
                    'Source Wallets': testConfig.sourceWalletCount,
                    'Destination Wallets': testConfig.destWalletCount,
                    'Test Duration': `${testConfig.testDuration} minutes`,
                    'Batch Size': testConfig.batchSize || 10,
                    'Batch Interval': `${testConfig.batchIntervalMs || 500}ms`,
                    Timeout: `${testConfig.timeout / 1000 / 60} minutes`,
                });

            const destBuilder = new LoadStressTestBuilder(blockchain, envConfig);

            const sourceWallets = await sourceBuilder.prepareWallets(
                testConfig.sourceWalletCount,
                envConfig.createNewWallet,
                true
            );
            const destWallets = await destBuilder.prepareWallets(
                testConfig.destWalletCount,
                envConfig.createNewWallet,
                false
            );

            const destAddress = destWallets.getWallets()[0].address;

            await sourceWallets
                .executeSustainedLoadTest(
                    destAddress,
                    testConfig.testDuration || 1,
                    Array.isArray(testConfig.batchSize) ? testConfig.batchSize[0] : testConfig.batchSize || 10,
                    testConfig.batchIntervalMs || 500
                )
                .then(builder => builder.analyzeResults())
                .then(builder => builder.cleanup());
        });
    });
});
