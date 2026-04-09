import '../../setup';
import {
    logPerformanceExpect,
    recordPerformanceResults,
    assertPerformanceResults,
    analyzePerformanceResults,
    PerformanceExpectConfig,
    getPerformanceRunCount,
} from '../../src/utils/performance-utils';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { Blockchain } from '../../src/core/Blockchain';
import { PerformanceRunMetrics, PerformanceTestBuilder } from '../../src/blockchain/test-library';
import { Config } from '../../src/utils/common';
import path from 'path';
import fs from 'fs';

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
chai.use(chaiAsPromised);

// Configuration
const configPath = path.join(__dirname, '../config.json');
const envName = Config.envName;

// Performance Tests
describe('Performance Tests', () => {
    let blockchain: Blockchain;

    before(async () => {
        const runtimeManager = new RuntimeManager();
        await runtimeManager.connectToChainFromConfigFile(configPath, envName);
        const chain = runtimeManager.getChain(envName);
        if (!chain) {
            throw new Error(`Failed to connect to blockchain: ${envName}`);
        }
        blockchain = chain;

        const founderWallet = blockchain.createFounderEthersWallet();
        console.log(`\n🔧 Performance Test Configuration:`);
        console.log(`   Founder Wallet Address: ${founderWallet.address}`);
    });

    it('Run consecutive performance tests', async () => {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const performanceExpectations: PerformanceExpectConfig = configData.testConfig.performanceExpect;
        const totalRuns = getPerformanceRunCount(performanceExpectations);
        const results: Array<PerformanceRunMetrics | null> = [];

        console.log(`\n🔄 Running ${totalRuns} consecutive performance tests...`);
        console.log(`   Configured via: testConfig.performanceExpect.tokenTransfer.runs=${totalRuns}`);

        for (let i = 1; i <= totalRuns; i++) {
            console.log(`\n--- Run ${i}/${totalRuns} ---`);

            try {
                const builder = new PerformanceTestBuilder(blockchain);
                await builder.executeTokenTransfer();

                const metrics = builder.getMetrics();
                results.push(metrics);

                console.log(
                    `✅ Run ${i} completed: ${builder.getTimeTaken()}ms ` +
                        `(submission=${metrics?.submissionLatencyMs ?? 'n/a'}ms, ` +
                        `confirmation=${metrics?.confirmationLatencyMs ?? 'n/a'}ms)`
                );
            } catch (error) {
                console.error(`❌ Run ${i} failed:`, error);
                results.push(null); // Mark as failed
            }

            // Add a small delay between runs to avoid rate limiting
            if (i < totalRuns) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        logPerformanceExpect(performanceExpectations);

        // Analyze performance results
        const analysis = analyzePerformanceResults(results, performanceExpectations);

        // Record detailed results using analysis data
        recordPerformanceResults(results, analysis);

        // Assert performance results
        assertPerformanceResults(results, performanceExpectations);
    });
});
