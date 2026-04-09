import '../../setup';
import fs from 'fs';
import path from 'path';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { AvalanchePlatformTestBuilder } from '../../src/blockchain/test-library';
import { Config } from '../../src/utils/common';

const configPath = path.join(__dirname, '../config.json');
const envName = Config.envName;

const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const chainConfig = rawConfig[envName] || {};

describe('Avalanche Platform API Tests', () => {
    let testBuilder: AvalanchePlatformTestBuilder;

    beforeEach(async function () {
        if (chainConfig.controlPlane !== 'avalanche-platform') {
            console.log(`\n⏭️  ${envName} is not configured for avalanche-platform, skipping tests`);
            this.skip();
        }

        const runtimeManager = new RuntimeManager();
        await runtimeManager.connectToChainFromConfigFile(configPath, envName);
        const blockchain = runtimeManager.getChain(envName);
        if (!blockchain) {
            throw new Error(`Failed to connect to blockchain: ${envName}`);
        }

        testBuilder = new AvalanchePlatformTestBuilder(blockchain, {
            subnetId: chainConfig.subnetId,
            blockchainId: chainConfig.blockchainId,
            primaryNodes: chainConfig.discoveredPrimaryNodes || [],
        });
    });

    afterEach(async () => {
        if (testBuilder) {
            await testBuilder.cleanup();
        }
    });

    it('should validate Avalanche platform control plane for the configured L1', async () => {
        await testBuilder
            .initialize()
            .then(builder => builder.testConnectivity())
            .then(builder => builder.testHealth())
            .then(builder => builder.testNetworkInfo())
            .then(builder => builder.testPlatformHeight())
            .then(builder => builder.testCurrentValidators())
            .then(builder => builder.testBlockchainMetadata())
            .then(builder => builder.testL1Status())
            .then(builder => builder.testPrimaryNodeHealth())
            .then(builder => builder.testPrimaryNodeInfoConsistency())
            .then(builder => builder.testPrimaryNodePlatformHeightConsistency())
            .then(builder => builder.testBlockchainVisibilityAcrossPrimaryNodes())
            .then(builder => builder.assertResults());
    });
});
