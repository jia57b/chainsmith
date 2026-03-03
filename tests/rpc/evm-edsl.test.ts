import { expect } from 'chai';
import '../../setup';
import { sleep, Config } from '../../src/utils/common';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { Blockchain } from '../../src/core/Blockchain';
import { EVMRpcTestBuilder } from '../../src/blockchain/test-library';
import { IBlockchainNode } from '../../src/blockchain/types';
import path from 'path';
import fs from 'fs';

// Configuration
const configPath = path.join(__dirname, '../config.json');
const envName = Config.envName;

// Load config synchronously to get node count for test generation
const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const envConfig = configData[envName];
const configuredNodes = envConfig?.nodes || [];
// Filter to get active nodes excluding bootnodes (bootnodes don't have EVM RPC)
const activeNodeCount = configuredNodes.filter((n: any) => n.active && n.type !== 'bootnode').length;

// Shared state for transaction tests (send once, verify on all nodes)
let sharedTxHash: string | null = null;
let sharedBlockHash: string | null = null;

// Test suite
describe('EVM RPC Tests', () => {
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

        // Get active nodes excluding bootnodes (bootnodes don't have EVM RPC)
        activeNodes = blockchain.getActiveNotBootNodes();

        // Print environment summary
        console.log('\n' + '='.repeat(60));
        console.log('📋 TEST ENVIRONMENT SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Chain Name: ${blockchain.name}`);
        console.log(`   Chain ID: ${blockchain.chainId}`);
        console.log(`   Environment: ${envName}`);
        console.log(`   EVM RPC URL: ${blockchain.executeLayerHttpRpcUrl}`);
        console.log('');
        console.log('   📡 Nodes Configuration:');
        console.log(`   Total Nodes: ${blockchain.nodes.length}`);
        console.log(`   Active Validators: ${activeNodes.length}`);
        console.log('');

        blockchain.nodes.forEach(node => {
            const status = node.active ? '✓' : '✗';
            const typeIcon = node.type === 'bootnode' ? '🔗' : '🖥️';
            let nodeUrl = node.url;
            try {
                nodeUrl = node.getExecuteLayerRpcUrl();
            } catch {
                /* port not exposed */
            }
            console.log(`   ${status} ${typeIcon} Node ${node.index}: ${nodeUrl} (${node.type})`);
        });

        console.log('');
        console.log(`   💰 Founder Wallet: ${blockchain.founderWallet?.address ?? 'N/A'}`);
        console.log('='.repeat(60) + '\n');

        // Verify at least one node is connected
        const connected = await blockchain.getDefaultExecuteLayerClient().isConnected();
        expect(connected).to.be.true;

        // Deploy contract once (if needed) - will be shared across all node tests
        const testBuilder = await EVMRpcTestBuilder.withTestContract(blockchain, {
            contractAddress: Config.contractAddress,
        });
        console.log(`   📝 Contract Address: ${Config.contractAddress || 'Auto-deployed'}\n`);

        // Send a transaction once for RPC-02 tests (shared across all nodes)
        console.log('   📤 Sending shared transaction for RPC-02 tests...');
        try {
            const tx = await blockchain.sendSimpleTransaction(
                blockchain.founderWallet?.address ?? '0x742d35Cc6464BAae9078c6C1ABEF9e9a5B069C1D',
                '0.01',
                blockchain.founderWallet?.privateKey ?? ''
            );
            sharedTxHash = tx ? tx.hash : null;
            console.log(`   ✓ Transaction sent: ${sharedTxHash}`);

            // Wait for transaction to be mined
            let tryCount = 10;
            while (!sharedBlockHash && tryCount > 0) {
                await sleep(1);
                tryCount--;
                const txRequest = {
                    method: 'eth_getTransactionByHash',
                    params: [sharedTxHash],
                    id: 1,
                    jsonrpc: '2.0',
                };
                const rpcResponse = await blockchain.makeRpcCall(txRequest);
                sharedBlockHash = rpcResponse.result?.blockHash || null;
            }
            console.log(`   ✓ Block Hash: ${sharedBlockHash}\n`);
        } catch (error) {
            console.error('   ✗ Failed to send shared transaction:', error);
        }
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
                let testBuilder: EVMRpcTestBuilder;
                let node: IBlockchainNode | undefined;

                before(async function () {
                    node = activeNodes[nodeSlot];
                    console.log(`\n🔍 Testing Node ${node.index}: ${node.getExecuteLayerRpcUrl()}`);

                    testBuilder = await EVMRpcTestBuilder.withTestContract(blockchain, {
                        contractAddress: Config.contractAddress,
                        nodeIndex: node.index,
                    });
                });

                describe('RPC-01: EVM General Methods', function () {
                    it('web3_clientVersion', async () => testBuilder.testWeb3ClientVersion());
                    it('web3_sha3', async () => testBuilder.testWeb3Sha3());
                    it('net_listening', async () => testBuilder.testNetListening());
                    it('net_peerCount', async () => testBuilder.testNetPeerCount());
                    it('net_version', async () => testBuilder.testNetVersion());
                    it('eth_blockNumber', async () => testBuilder.testEthBlockNumber());
                    it('eth_chainId', async () => testBuilder.testEthChainId());
                    it('eth_estimateGas', async () => testBuilder.testEthEstimateGas());
                    it('eth_gasPrice', async () => testBuilder.testEthGasPrice());
                    it('eth_getBalance', async () => testBuilder.testEthGetBalance());
                    it('eth_getBlockByNumber', async () => testBuilder.testEthGetBlockByNumber());
                    it('eth_getBlockTransactionCountByNumber', async () =>
                        testBuilder.testEthGetBlockTransactionCountByNumber());
                    it('eth_getRawTransactionByBlockNumberAndIndex', async () =>
                        testBuilder.testEthGetRawTransactionByBlockNumberAndIndex());
                    it('eth_getTransactionByBlockNumberAndIndex', async () =>
                        testBuilder.testEthGetTransactionByBlockNumberAndIndex());
                    it('eth_getCode', async () => testBuilder.testEthGetCode());
                    it('eth_getFilterChanges', async () => testBuilder.testEthGetFilterChanges());
                    it('eth_getFilterLogs', async () => testBuilder.testEthGetFilterLogs());
                    it('eth_getLogs', async () => testBuilder.testEthGetLogs());
                    it('eth_getStorageAt', async () => testBuilder.testEthGetStorageAt());
                    it('eth_getTransactionCount', async () => testBuilder.testEthGetTransactionCount());
                    it('eth_getUncleCountByBlockNumber', async () => testBuilder.testEthGetUncleCountByBlockNumber());
                    it('eth_getUncleByBlockNumberAndIndex', async () =>
                        testBuilder.testEthGetUncleByBlockNumberAndIndex());
                    it('eth_newBlockFilter', async () => testBuilder.testEthNewBlockFilter());
                    it('eth_newFilter', async () => testBuilder.testEthNewFilter());
                    it('eth_newPendingTransactionFilter', async () => testBuilder.testEthNewPendingTransactionFilter());
                    it('eth_pendingTransactions', async () => testBuilder.testEthPendingTransactions());
                    it('eth_syncing', async () => testBuilder.testEthSyncing());
                    it('eth_uninstallFilter', async () => testBuilder.testEthUninstallFilter());
                });

                describe('RPC-02: EVM Transaction Related Methods', function () {
                    it('eth_call', async () => testBuilder.testEthCall());
                    it('eth_getBlockByHash', async () => testBuilder.testEthGetBlockByHash());
                    it('eth_getBlockTransactionCountByHash', async () =>
                        testBuilder.testEthGetBlockTransactionCountByHash());
                    it('eth_getRawTransactionByHash', async () =>
                        testBuilder.testEthGetRawTransactionByHash(sharedTxHash || undefined));
                    it('eth_getRawTransactionByBlockHashAndIndex', async () =>
                        testBuilder.testEthGetRawTransactionByBlockHashAndIndex(sharedBlockHash || undefined));
                    it('eth_getTransactionByBlockHashAndIndex', async () =>
                        testBuilder.testEthGetTransactionByBlockHashAndIndex(sharedBlockHash || undefined));
                    it('eth_getTransactionByHash', async () =>
                        testBuilder.testEthGetTransactionByHash(sharedTxHash || undefined));
                    it('eth_getTransactionReceipt', async () =>
                        testBuilder.testEthGetTransactionReceipt(sharedTxHash || undefined));
                    it('eth_getUncleByBlockHashAndIndex', async () =>
                        testBuilder.testEthGetUncleByBlockHashAndIndex(sharedBlockHash || undefined));
                    it('eth_getUncleCountByBlockHash', async () =>
                        testBuilder.testEthGetUncleCountByBlockHash(sharedBlockHash || undefined));
                    it('eth_sendRawTransaction', async () => testBuilder.testEthSendRawTransaction());
                });

                describe('RPC-05: Allow unprotected transactions', function () {
                    it('unprotected transaction', async () => testBuilder.testUnprotectedTransaction());
                });
            });
        }
    });
});
