import '../../setup';
import fs from 'fs';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { CosmosApiTestBuilder } from '../../src/blockchain/test-library';
import { Config } from '../../src/utils/common';
import path from 'path';

// Configuration
const configPath = path.join(__dirname, '../config.json');
const envName = Config.envName;

// Read supported Cosmos modules from chain config
const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const chainConfig = rawConfig[envName] || {};
const supportedModules: string[] = chainConfig.supportedCosmosModules || [];

// Shared setup: create a CosmosApiTestBuilder for each test
function createTestSuite(suiteTitle: string, testCases: (getBuilder: () => CosmosApiTestBuilder) => void) {
    describe(suiteTitle, () => {
        let testBuilder: CosmosApiTestBuilder;

        beforeEach(async () => {
            const runtimeManager = new RuntimeManager();
            await runtimeManager.connectToChainFromConfigFile(configPath, envName);
            const blockchain = runtimeManager.getChain(envName);
            if (!blockchain) {
                throw new Error(`Failed to connect to blockchain: ${envName}`);
            }
            testBuilder = new CosmosApiTestBuilder(blockchain, supportedModules);
        });

        afterEach(async () => {
            await testBuilder.cleanup();
        });

        testCases(() => testBuilder);
    });
}

// ============================================================================
// Test suite for all Cosmos SDK modules
// ============================================================================
createTestSuite('Cosmos API Tests', getBuilder => {
    it('should test all major Cosmos SDK modules', async function () {
        if (supportedModules.length === 0) {
            console.log(`\n⏭️  No Cosmos modules declared for ${envName}, skipping Cosmos API tests`);
            this.skip();
        }
        await getBuilder()
            .initialize()
            .then(b => b.testStakingModule())
            .then(b => b.testSlashingModule())
            .then(b => b.testMintModule())
            .then(b => b.assertResults())
            .then(b => b.generateReport());
    });

    it('should test staking module, validator detail, and delegation chain', async function () {
        if (!supportedModules.includes('staking')) {
            console.log(`\n⏭️  Staking module not supported for ${envName}, skipping staking delegation tests`);
            this.skip();
        }
        await getBuilder()
            .initialize()
            .then(b => b.testStakingModule())
            .then(b => b.testValidatorDetail())
            .then(b => b.testValidatorDelegations())
            .then(b => b.assertResults())
            .then(b => b.generateReport());
    });
});
