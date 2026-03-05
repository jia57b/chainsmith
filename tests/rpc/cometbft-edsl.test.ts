import { expect } from 'chai';
import '../../setup';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { Blockchain } from '../../src/core/Blockchain';
import { CometBFTTestBuilder } from '../../src/blockchain/test-library';
import { IBlockchainNode } from '../../src/blockchain/types';
import { Config } from '../../src/utils/common';
import path from 'path';
import fs from 'fs';

// Configuration
const configPath = path.join(__dirname, '../config.json');
const envName = Config.envName;

// Load config synchronously to get node count for test generation
const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const envConfig = configData[envName];
const configuredNodes = envConfig?.nodes || [];
// Filter to get active nodes excluding bootnodes (bootnodes don't have Consensus RPC)
const activeNodeCount = configuredNodes.filter((n: any) => n.active && n.type !== 'bootnode').length;

// Test suite
describe('CometBFT RPC Tests', () => {
    let blockchain: Blockchain;
    let activeNodes: IBlockchainNode[] = [];

    before(async () => {
        // Initialize blockchain
        const runtimeManager = new RuntimeManager();
        await runtimeManager.connectToChainFromConfigFile(configPath, envName);
        const chain = runtimeManager.getChain(envName);
        if (!chain) {
            throw new Error(`Failed to connect to blockchain: ${envName}`);
        }
        blockchain = chain;

        // Get active nodes excluding bootnodes (bootnodes don't have Consensus RPC)
        activeNodes = blockchain.getActiveNotBootNodes();

        // Print environment summary
        console.log('\n' + '='.repeat(60));
        console.log('📋 TEST ENVIRONMENT SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Chain Name: ${blockchain.name}`);
        console.log(`   Chain ID: ${blockchain.chainId}`);
        console.log(`   Environment: ${envName}`);
        console.log(`   Consensus Layer: ${blockchain.consensusLayer}`);
        console.log(`   Consensus RPC URL: ${blockchain.consensusLayerRpcUrl}`);
        console.log('');
        console.log('   📡 Nodes Configuration:');
        console.log(`   Total Nodes: ${blockchain.nodes.length}`);
        console.log(`   Active Validators: ${activeNodes.length}`);
        console.log('');

        blockchain.nodes.forEach(node => {
            const status = node.active ? '✓' : '✗';
            const typeIcon = node.type === 'bootnode' ? '🔗' : '🖥️';
            const port = node.consensusLayerRpcPort ?? 'N/A';
            console.log(
                `   ${status} ${typeIcon} Node ${node.index}: ${node.url} (${node.type}, CometBFT port: ${port})`
            );
        });

        console.log('');
        console.log(`   💰 Founder Wallet: ${blockchain.founderWallet?.address ?? 'N/A'}`);
        console.log('='.repeat(60) + '\n');
    });

    // Test environment info
    describe('Test Environment', () => {
        it('should have active validator nodes', () => {
            expect(activeNodes.length).to.be.greaterThan(0, 'No active validator nodes found');
        });
    });

    // Generate tests for each active node
    describe('Per-Node RPC Tests', function () {
        // Loop through all active nodes (read from config at load time)
        for (let nodeSlot = 0; nodeSlot < activeNodeCount; nodeSlot++) {
            describe(`Node ${nodeSlot}`, function () {
                let testBuilder: CometBFTTestBuilder;
                let node: IBlockchainNode | undefined;

                before(async function () {
                    node = activeNodes[nodeSlot];
                    console.log(`\n🔍 Testing Node ${node.index}: ${node.url}`);

                    testBuilder = new CometBFTTestBuilder(blockchain, {
                        nodeIndex: node.index,
                    });
                    await testBuilder.initialize();
                });

                describe('RPC-03: Consensus layer general methods', function () {
                    it('validators', async () => testBuilder.testValidators());
                    it('status', async () => testBuilder.testStatus());
                    it('health', async () => testBuilder.testHealth());
                    // it('status (non-HTTPS)', async () => testBuilder.testStatusNonHttps());
                    it('net_info', async () => testBuilder.testNetInfo());
                    it('blockchain', async () => testBuilder.testBlockchain());
                    it('header', async () => testBuilder.testHeader());
                    it('block', async () => testBuilder.testBlock());
                    it('block_results', async () => testBuilder.testBlockResults());
                    it('commit', async () => testBuilder.testCommit());
                    // it('validators (non-HTTPS)', async () => testBuilder.testValidatorsNonHttps());
                    it('genesis', async () => testBuilder.testGenesis());
                    it('genesis_chunked', async () => testBuilder.testGenesisChunked());
                    it('dump_consensus_state', async () => testBuilder.testDumpConsensusState());
                    it('consensus_state', async () => testBuilder.testConsensusState());
                    it('consensus_params', async () => testBuilder.testConsensusParams());
                    it('unconfirmed_txs', async () => testBuilder.testUnconfirmedTxs());
                    it('num_unconfirmed_txs', async () => testBuilder.testNumUnconfirmedTxs());
                    it('abci_info', async () => testBuilder.testAbciInfo());
                    it('abci_query', async () => testBuilder.testAbciQuery());
                    it('header_by_hash', async () => testBuilder.testHeaderByHash());
                    it('block_by_hash', async () => testBuilder.testBlockByHash());
                    it('block_search', async () => testBuilder.testBlockSearch());
                });

                describe('RPC-04: Consensus layer transaction methods', function () {
                    it('broadcast_tx_sync', async () => testBuilder.testBroadcastTxSync());
                    it('broadcast_tx_async', async () => testBuilder.testBroadcastTxAsync());
                    it('broadcast_tx_commit', async () => testBuilder.testBroadcastTxCommit());
                    it('check_tx', async () => testBuilder.testCheckTx());
                });

                describe('RPC-05: Skipped tests (unsafe or under development)', function () {
                    it.skip('dial_seeds (requires unsafe mode)', async () => testBuilder.testDialSeeds());
                    it.skip('dial_peers (requires unsafe mode)', async () => testBuilder.testDialPeers());
                    it.skip('broadcast_evidence', async () => testBuilder.testBroadcastEvidence());
                    it.skip('tx_search', async () => testBuilder.testTxSearch());
                    it.skip('tx', async () => testBuilder.testTx());
                });
            });
        }
    });
});
