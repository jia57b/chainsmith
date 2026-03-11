import { BlockchainNode } from './BlockchainNode';
import {
    IBlockchain,
    IExecuteLayerClient,
    IConsensusLayerClient,
    IBlockchainNode,
    IWallet,
    NodeType,
    TransactionRequest,
    TransactionResult,
    EnvironmentSSHConfig,
    EnvironmentDockerConfig,
    ExecutionMethod,
    BlockchainType,
    Request,
    Response,
} from '../blockchain/types';
import { WalletFactory } from '../blockchain/factory';
import { ethers } from 'ethers';
import { Config, sleepMs } from '../utils/common';
import { validateSchema, formatValidationErrors } from '../utils/schema-validator';

export class Blockchain implements IBlockchain {
    readonly name: string;
    readonly chainId: string;
    readonly executeLayer: BlockchainType;
    readonly consensusLayer: BlockchainType;
    readonly chainType: BlockchainType;
    readonly nativeToken?: string;
    readonly addressPrefix?: string;

    // Public RPC URLs (complete URLs, no port appending needed)
    readonly executeLayerHttpRpcUrl: string;
    readonly consensusLayerRpcUrl?: string;
    readonly consensusLayerHttpRestApiUrl?: string;

    // IRuntimeTestConfig properties - mutable, test configuration may need dynamic adjustment
    public timeout?: number;

    // Node management - managed through dedicated methods
    public nodes: Array<IBlockchainNode> = [];

    // Wallet configuration - mutable, may need to switch wallets
    public founderWallet?: IWallet;

    // SSH configuration for remote operations
    public ssh?: EnvironmentSSHConfig;

    // Docker configuration for container operations
    public docker?: EnvironmentDockerConfig;

    // Execution method for node operations
    public executionMethod?: ExecutionMethod;

    private constructor(name: string, blockchainConfig: IBlockchain) {
        this.name = name;
        this.chainId = blockchainConfig.chainId;
        this.executeLayer = blockchainConfig.executeLayer;
        this.consensusLayer = blockchainConfig.consensusLayer;
        // chainType defaults to executeLayer (execution layer type typically represents the main chain type)
        this.chainType = blockchainConfig.chainType ?? blockchainConfig.executeLayer;
        this.nativeToken = blockchainConfig.nativeToken;
        this.addressPrefix = blockchainConfig.addressPrefix;

        // Initialize public RPC URLs
        this.executeLayerHttpRpcUrl = blockchainConfig.executeLayerHttpRpcUrl;
        this.consensusLayerRpcUrl = blockchainConfig.consensusLayerRpcUrl;
        this.consensusLayerHttpRestApiUrl = blockchainConfig.consensusLayerHttpRestApiUrl;

        // Initialize timeout from config
        this.timeout = blockchainConfig.timeout;

        // Initialize SSH config
        this.ssh = blockchainConfig.ssh;

        // Initialize Docker config
        this.docker = blockchainConfig.docker;

        // Initialize execution method (default to 'none' if not specified)
        this.executionMethod = blockchainConfig.executionMethod;
    }

    static connectNetworkFromConfigFile(name: string, blockchainConfig: IBlockchain): Blockchain {
        // check the config object has necessary fields
        if (
            !blockchainConfig?.chainId ||
            !blockchainConfig.executeLayer ||
            !blockchainConfig.consensusLayer ||
            !blockchainConfig.executeLayerHttpRpcUrl
        ) {
            throw new Error('Invalid blockchain configuration. Missing required fields.');
        }

        // Implementation for connecting to a network from a config file
        const instance = new Blockchain(name, blockchainConfig);

        // Set name on config for nodes (config from JSON doesn't have name field)
        blockchainConfig.name = name;

        // instance the node list if provided
        if (Array.isArray(blockchainConfig.nodes)) {
            for (const nodeCfg of blockchainConfig.nodes) {
                // Build complete node configuration
                // url: node's base URL (includes http://, excludes port)
                // ports: use node config if specified, otherwise BlockchainNode will use DEFAULT_PORTS
                // Note: null means "port explicitly not exposed", undefined means "use default"
                const nodeConfigNormalized = {
                    ...nodeCfg,
                    url: (nodeCfg as any).rpcUrl ?? nodeCfg.url,
                };

                const node = new BlockchainNode(nodeConfigNormalized as any, blockchainConfig);

                instance.addNode(node);
            }
        }

        //if the founderWallet is provided in blockchainConfig, new IWallet instance
        if (blockchainConfig.founderWallet) {
            instance.founderWallet = WalletFactory.createWalletFromConfig(
                blockchainConfig.executeLayer,
                blockchainConfig.founderWallet
            );
        }

        return instance;
    }

    /**
     * Test connectivity of all nodes
     * @param timeout Timeout in milliseconds, will be passed to each node's connection test
     */
    async testConnectivity(timeout?: number): Promise<Map<number, boolean>> {
        const results = new Map<number, boolean>();

        // Determine timeout to use: parameter > Blockchain's own timeout > none
        const finalTimeout = timeout ?? this.timeout;

        for (const node of this.nodes) {
            if (node.active) {
                const nodeTypeLabel = node.type === NodeType.BOOTNODE ? 'bootnode' : this.chainType;
                console.log(`Testing Node-${node.index} (${nodeTypeLabel})...`);
                try {
                    // If there is a determined timeout, pass it in, otherwise let node use its own default logic
                    const isConnected =
                        finalTimeout !== undefined
                            ? await (node as BlockchainNode).testConnection(finalTimeout)
                            : await (node as BlockchainNode).testConnection();

                    results.set(node.index, isConnected);

                    if (isConnected) {
                        console.log(`✅ Node-${node.index} (${nodeTypeLabel}): Connected`);
                    } else {
                        console.log(`❌ Node-${node.index} (${nodeTypeLabel}): Not connected`);
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);

                    // Handle nodes without any testable endpoints
                    if (errorMessage.includes('No RPC client initialized')) {
                        console.log(`⏭️  Node-${node.index} (${nodeTypeLabel}): Skipped (no testable endpoints)`);
                        // Don't add to results - node is not testable
                    } else {
                        results.set(node.index, false);
                        console.log(`❌ Node-${node.index} (${nodeTypeLabel}): Error - ${errorMessage}`);
                    }
                }
            } else {
                console.log(`⏭️  Node-${node.index} (${this.chainType}): Skipped (inactive)`);
            }
        }
        return results;
    }

    /**
     * Send transaction (using default or specified node)
     */
    async sendTransaction(
        request: TransactionRequest,
        privateKey: string,
        nodeIndex?: number
    ): Promise<TransactionResult> {
        const node = nodeIndex !== undefined ? this.getNode(nodeIndex) : this.getActiveNotBootNodes()[0];

        return await node.sendTransaction(request, privateKey);
    }

    /**
     * Send simple transaction (convenience method)
     * Provides a simple interface similar to TransactionManager
     */
    async sendSimpleTransaction(
        to: string,
        value: string,
        privateKey: string,
        options?: {
            maxPriorityFeePerGas?: string | number;
            gasLimit?: string | number;
            gasPrice?: string | number;
            nodeIndex?: number;
        }
    ): Promise<TransactionResult> {
        // Convert ETH to wei
        const amountInWei = ethers.parseEther(value).toString();

        // Build TransactionRequest
        const request: TransactionRequest = {
            to,
            amount: amountInWei,
            gasLimit: options?.gasLimit,
            gasPrice: options?.gasPrice,
            maxPriorityFeePerGas: options?.maxPriorityFeePerGas,
        };

        // Call the existing sendTransaction method
        return this.sendTransaction(request, privateKey, options?.nodeIndex);
    }

    /**
     * Sign transaction
     * Provides functionality similar to the signTransaction function in transactions.ts
     */
    async signTransaction(tx: ethers.TransactionRequest, privateKey: string): Promise<string> {
        const wallet = new ethers.Wallet(privateKey);

        // Ensure transaction has correct chainId
        tx.chainId ??= this.chainId;

        return wallet.signTransaction(tx);
    }

    /**
     * Wait for blockchain to reach specified block height
     * Provides functionality similar to the waitForBlockNumber function in transactions.ts
     */
    async waitForBlockNumber(targetBlock: number, nodeIndex?: number): Promise<void> {
        let currentBlock = await this.getBlockHeight(nodeIndex);
        while (currentBlock < targetBlock) {
            await sleepMs(1000);
            currentBlock = await this.getBlockHeight(nodeIndex);
        }
    }

    /**
     * Wait for specified number of blocks to be mined
     * @param blockCount - Number of blocks to wait for
     * @param pollInterval - Polling interval in milliseconds, default 3000ms
     * @param nodeIndex - Optional node index
     */
    async waitForBlocks(blockCount: number, pollInterval: number = 3000, nodeIndex?: number): Promise<void> {
        const startBlock = await this.getBlockHeight(nodeIndex);
        const targetBlock = startBlock + blockCount;
        console.log(`⏳ Waiting for ${blockCount} blocks (current: ${startBlock}, target: ${targetBlock})...`);

        let currentBlock = startBlock;
        while (currentBlock < targetBlock) {
            await sleepMs(pollInterval);
            currentBlock = await this.getBlockHeight(nodeIndex);
        }
        console.log(`✅ Reached block ${currentBlock}`);
    }

    /**
     * Wait for transaction confirmation and return receipt
     * @param txHash - Transaction hash
     * @param timeout - Timeout in milliseconds, default 60000ms
     * @returns Transaction receipt, or null if timeout or failure
     */
    async waitForTransaction(
        txHash: string,
        timeout: number = 60000
    ): Promise<{ blockHash: string; blockNumber: number; status: number } | null> {
        if (this.executeLayer !== BlockchainType.EVM) {
            console.warn('waitForTransaction currently only supports EVM chains');
            return null;
        }

        try {
            const provider = this.getDefaultExecuteLayerClient().getProvider();
            const receipt = await provider.waitForTransaction(txHash, 1, timeout);
            if (receipt) {
                return {
                    blockHash: receipt.blockHash,
                    blockNumber: receipt.blockNumber,
                    status: receipt.status ?? 0,
                };
            }
            return null;
        } catch (error) {
            console.warn(`Failed to wait for transaction ${txHash}:`, error);
            return null;
        }
    }

    /**
     * Send transaction and wait for confirmation
     * @param to - Target address
     * @param value - Amount to send (ETH)
     * @param privateKey - Optional private key, defaults to founderWallet
     * @returns Transaction hash and block hash, or null if failed
     */
    async sendAndConfirm(
        to: string,
        value: string = '0.01',
        privateKey?: string
    ): Promise<{ txHash: string; blockHash: string; blockNumber: number } | null> {
        try {
            const tx = await this.sendSimpleTransaction(to, value, privateKey ?? this.founderWallet?.privateKey ?? '');
            if (!tx?.hash) {
                console.warn('Transaction failed: no hash returned');
                return null;
            }

            console.log(`📤 Transaction sent: ${tx.hash}`);
            const receipt = await this.waitForTransaction(tx.hash);
            if (receipt) {
                console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
                return {
                    txHash: tx.hash,
                    blockHash: receipt.blockHash,
                    blockNumber: receipt.blockNumber,
                };
            }
            return null;
        } catch (error) {
            console.warn('sendAndConfirm failed:', error);
            return null;
        }
    }

    /**
     * Send unprotected transaction (without chainId)
     * Provides functionality similar to TransactionManager.sendUnprotectedTransaction
     */
    async sendUnprotectedTransaction(
        to: string = Config.account,
        value: string = '0.01',
        privateKey?: string,
        nodeIndex?: number
    ): Promise<ethers.TransactionResponse> {
        const wallet = new ethers.Wallet(privateKey ?? this.founderWallet?.privateKey ?? '');

        // Select endpoint based on nodeIndex
        let endpoint: string;
        if (nodeIndex !== undefined) {
            // Use specific node endpoint
            const node = this.getNode(nodeIndex);
            endpoint = node.getExecuteLayerRpcUrl();
        } else {
            // Use public endpoint (top-level URL)
            endpoint = this.getExecuteLayerRpcUrl();
        }

        const provider = new ethers.JsonRpcProvider(endpoint);
        const connectedWallet = wallet.connect(provider);

        const tx: ethers.TransactionRequest = {
            to,
            value: ethers.parseEther(value),
        };

        return await connectedWallet.sendTransaction(tx);
    }

    /**
     * Get block height
     */
    async getBlockHeight(nodeIndex?: number): Promise<number> {
        const node = nodeIndex !== undefined ? this.getNode(nodeIndex) : this.getActiveNotBootNodes()[0];

        return await node.getBlockHeight();
    }

    /**
     * Get active nodes
     */
    getActiveNodes(): IBlockchainNode[] {
        return this.nodes.filter(node => node.active);
    }

    getActiveNotBootNodes(): IBlockchainNode[] {
        return this.nodes.filter(node => node.active && node.type !== NodeType.BOOTNODE);
    }

    /**
     * Get nodes by node type
     */
    getNodesByType(nodeType: NodeType): IBlockchainNode[] {
        return this.nodes.filter(node => node.type === nodeType);
    }

    /**
     * Check if active bootnodes are configured
     */
    hasActiveBootnodes(): boolean {
        return this.nodes.some(node => node.type === NodeType.BOOTNODE && node.active);
    }

    /**
     * Get node by index
     */
    getNode(index: number): IBlockchainNode {
        const node = this.nodes.find(node => node.index === index);
        if (!node) {
            throw new Error(`Node with index ${index} not found`);
        }
        return node;
    }

    /**
     * Set node active status
     * @param index Node index
     * @param active Whether to activate
     */
    setNodeActive(index: number, active: boolean): void {
        const node = this.getNode(index) as BlockchainNode;
        node.active = active;
        console.log(`Node-${index} is now ${active ? 'active' : 'inactive'}`);
    }

    /**
     * Deactivate node (for testing consensus mechanism)
     * @param index Node index
     */
    deactivateNode(index: number): void {
        this.setNodeActive(index, false);
    }

    /**
     * Activate node
     * @param index Node index
     */
    activateNode(index: number): void {
        this.setNodeActive(index, true);
    }

    /**
     * Select validator nodes based on voting power
     * @param scenario Test scenario: less-than-one-third | exactly-one-third | more-than-one-third
     * @returns ValidatorSelectionResult
     */
    selectValidatorsByVotingPower(scenario: 'less-than-one-third' | 'exactly-one-third' | 'more-than-one-third'): {
        validators: number[];
        totalVotingPower: number;
        targetVotingPower: number;
        achievedVotingPower: number;
        scenarioDescription: string;
    } {
        // Get active validator nodes
        const activeValidators = this.getNodesByType(NodeType.VALIDATOR).filter(node => node.active);

        // Calculate total voting power
        const totalVotingPower = activeValidators.reduce((sum, node) => sum + (node.votingPower ?? 0), 0);

        // Calculate target voting power based on scenario
        let targetVotingPower: number;
        let scenarioDescription: string;

        switch (scenario) {
            case 'less-than-one-third':
                targetVotingPower = Math.floor((totalVotingPower - 1) / 3);
                scenarioDescription = `less than 1/3 (${targetVotingPower}/${totalVotingPower})`;
                break;
            case 'exactly-one-third':
                targetVotingPower = Math.floor(totalVotingPower / 3);
                scenarioDescription = `exactly 1/3 (${targetVotingPower}/${totalVotingPower})`;
                break;
            case 'more-than-one-third':
                targetVotingPower = Math.floor(totalVotingPower / 3) + 1;
                scenarioDescription = `more than 1/3 (${targetVotingPower}/${totalVotingPower})`;
                break;
            default:
                throw new Error(`Unsupported scenario: ${scenario}`);
        }

        const selectedValidators: number[] = [];
        let currentVotingPower = 0;

        // Sort by voting power (ascending)
        const sortedValidators = [...activeValidators].sort((a, b) => (a.votingPower ?? 0) - (b.votingPower ?? 0));

        switch (scenario) {
            case 'exactly-one-third': {
                // Find validator with voting power exactly equal to target
                const selectedValidator = sortedValidators.find(v => (v.votingPower ?? 0) === targetVotingPower);
                if (selectedValidator) {
                    selectedValidators.push(selectedValidator.index);
                    currentVotingPower = selectedValidator.votingPower ?? 0;
                }
                break;
            }

            case 'less-than-one-third': {
                // Find the largest validator that is less than or equal to target
                const selectedValidator = sortedValidators.filter(v => (v.votingPower ?? 0) <= targetVotingPower).pop();
                if (selectedValidator) {
                    selectedValidators.push(selectedValidator.index);
                    currentVotingPower = selectedValidator.votingPower ?? 0;
                }
                break;
            }

            case 'more-than-one-third': {
                // Accumulate validators until reaching or exceeding target voting power
                // Start accumulating from smallest to minimize over-selection
                for (const validator of sortedValidators) {
                    if (currentVotingPower >= targetVotingPower) {
                        break;
                    }
                    selectedValidators.push(validator.index);
                    currentVotingPower += validator.votingPower ?? 0;
                }
                break;
            }
        }

        return {
            validators: selectedValidators,
            totalVotingPower,
            targetVotingPower,
            achievedVotingPower: currentVotingPower,
            scenarioDescription,
        };
    }

    /**
     * Add node (protected method, for construction time)
     */
    private addNode(node: IBlockchainNode): void {
        this.nodes.push(node);
    }

    /**
     * Create test account
     * @param privateKey Optional private key, randomly generated if not provided
     * @returns Account information containing address and private key
     */
    createTestAccount(privateKey?: string): { address: string; privateKey: string } {
        try {
            // Create wallet based on execution layer type (current framework mainly supports EVM execution layer)
            const wallet = WalletFactory.createWallet(this.executeLayer, privateKey);

            // Ensure wallet has private key
            if (!wallet.privateKey) {
                throw new Error('Wallet creation failed: missing private key');
            }

            console.log(`Created test account for ${this.name} (${this.executeLayer}): ${wallet.address}`);

            return {
                address: wallet.address,
                privateKey: wallet.privateKey,
            };
        } catch (error) {
            throw new Error(`Failed to create test account for ${this.executeLayer}: ${error}`);
        }
    }

    /**
     * Create Ethereum wallet connected to provider
     * @param privateKey Optional private key, randomly generated if not provided
     * @returns ethers.Wallet connected to current blockchain provider
     */
    createEthersWallet(privateKey?: string): ethers.Wallet | ethers.HDNodeWallet {
        try {
            if (this.executeLayer !== BlockchainType.EVM) {
                throw new Error(`createEthersWallet requires EVM-compatible blockchain, got: ${this.executeLayer}`);
            }

            const provider = this.getDefaultExecuteLayerClient().getProvider();

            if (privateKey) {
                return new ethers.Wallet(privateKey, provider);
            } else {
                return ethers.Wallet.createRandom(provider);
            }
        } catch (error) {
            throw new Error(`Failed to create ethers wallet: ${error}`);
        }
    }

    /**
     * Create founder wallet connected to provider
     * @returns Founder ethers.Wallet connected to current blockchain provider
     */
    createFounderEthersWallet(): ethers.Wallet {
        try {
            if (this.executeLayer !== BlockchainType.EVM) {
                throw new Error(
                    `createFounderEthersWallet requires EVM-compatible blockchain, got: ${this.executeLayer}`
                );
            }

            if (!this.founderWallet?.privateKey) {
                throw new Error('Founder wallet private key is required');
            }

            return this.createEthersWallet(this.founderWallet.privateKey) as ethers.Wallet;
        } catch (error) {
            throw new Error(`Failed to create founder ethers wallet: ${error}`);
        }
    }

    /**
     * Send multiple transactions (avoid nonce conflicts)
     * @param transactions Transaction array containing to and value fields
     * @param fromWallet Optional sending wallet, uses founder wallet if not provided
     * @param priorityFeePerGas Optional priority fee
     * @returns Array of transaction results
     */
    async sendMultipleTransactions(
        transactions: Array<{ to: string; value: string }>,
        fromWallet?: ethers.Wallet | ethers.HDNodeWallet,
        priorityFeePerGas?: bigint
    ): Promise<any[]> {
        try {
            if (this.executeLayer !== BlockchainType.EVM) {
                throw new Error(
                    `sendMultipleTransactions requires EVM-compatible blockchain, got: ${this.executeLayer}`
                );
            }

            // Use provided wallet or default founder wallet
            const wallet = fromWallet ?? this.createFounderEthersWallet();
            const provider = this.getDefaultExecuteLayerClient().getProvider();

            // Get current nonce and gas information
            const baseNonce = await provider.getTransactionCount(wallet.address, 'pending');
            const feeData = await provider.getFeeData();

            const results: any[] = [];

            // Set incrementing nonce for each transaction
            for (let i = 0; i < transactions.length; i++) {
                const tx: ethers.TransactionRequest = {
                    to: transactions[i].to,
                    value: ethers.parseEther(transactions[i].value),
                    nonce: baseNonce + i,
                };

                // Set gas fees
                if (priorityFeePerGas) {
                    tx.maxPriorityFeePerGas = priorityFeePerGas;
                } else if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                    tx.maxFeePerGas = feeData.maxFeePerGas;
                    tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
                } else {
                    tx.gasPrice = feeData.gasPrice;
                }

                const result = await wallet.sendTransaction(tx);
                results.push(result);
            }

            return results;
        } catch (error) {
            throw new Error(`Failed to send multiple transactions: ${error}`);
        }
    }

    /**
     * Send multiple transactions in batches (batch-concurrent execution).
     * Transactions within each batch are sent concurrently via Promise.all,
     * but batches are executed sequentially with a configurable delay between them.
     * This balances speed and mempool compatibility across different chain architectures
     * (especially Cosmos SDK-based EVM chains that have strict nonce ordering).
     *
     * @param transactions Transaction array containing to and value fields
     * @param fromWallet Optional sending wallet, uses founder wallet if not provided
     * @param batchSize Number of transactions per batch (default 10)
     * @param batchDelayMs Delay between batches in ms (default 200)
     * @param priorityFeePerGas Optional priority fee
     * @returns Array of transaction results
     */
    async sendMultipleTransactionsBatched(
        transactions: Array<{ to: string; value: string }>,
        fromWallet?: ethers.Wallet | ethers.HDNodeWallet,
        batchSize: number = 10,
        batchDelayMs: number = 200,
        priorityFeePerGas?: bigint
    ): Promise<any[]> {
        try {
            if (this.executeLayer !== BlockchainType.EVM) {
                throw new Error(
                    `sendMultipleTransactionsBatched requires EVM-compatible blockchain, got: ${this.executeLayer}`
                );
            }

            const wallet = fromWallet ?? this.createFounderEthersWallet();
            const provider = this.getDefaultExecuteLayerClient().getProvider();

            const baseNonce = await provider.getTransactionCount(wallet.address, 'pending');
            const feeData = await provider.getFeeData();

            const allResults: any[] = [];
            const totalBatches = Math.ceil(transactions.length / batchSize);

            for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
                const start = batchIdx * batchSize;
                const end = Math.min(start + batchSize, transactions.length);
                const batch = transactions.slice(start, end);

                const txPromises = batch.map((transaction, i) => {
                    const globalIndex = start + i;
                    const tx: ethers.TransactionRequest = {
                        to: transaction.to,
                        value: ethers.parseEther(transaction.value),
                        nonce: baseNonce + globalIndex,
                    };

                    if (priorityFeePerGas) {
                        tx.maxPriorityFeePerGas = priorityFeePerGas;
                    } else if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                        tx.maxFeePerGas = feeData.maxFeePerGas;
                        tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
                    } else {
                        tx.gasPrice = feeData.gasPrice;
                    }

                    return wallet.sendTransaction(tx);
                });

                const batchResults = await Promise.all(txPromises);
                allResults.push(...batchResults);

                if (batchIdx < totalBatches - 1 && batchDelayMs > 0) {
                    await sleepMs(batchDelayMs);
                }
            }

            return allResults;
        } catch (error) {
            throw new Error(`Failed to send multiple transactions in batches: ${error}`);
        }
    }

    /**
     * Send multiple transactions concurrently (parallel execution)
     * All transactions are sent simultaneously using Promise.all
     * This can result in multiple transactions being included in the same block
     *
     * @param transactions Transaction array containing to and value fields
     * @param fromWallet Optional sending wallet, uses founder wallet if not provided
     * @param priorityFeePerGas Optional priority fee
     * @returns Array of transaction results
     */
    async sendMultipleTransactionsConcurrent(
        transactions: Array<{ to: string; value: string }>,
        fromWallet?: ethers.Wallet | ethers.HDNodeWallet,
        priorityFeePerGas?: bigint
    ): Promise<any[]> {
        try {
            if (this.executeLayer !== BlockchainType.EVM) {
                throw new Error(
                    `sendMultipleTransactionsConcurrent requires EVM-compatible blockchain, got: ${this.executeLayer}`
                );
            }

            // Use provided wallet or default founder wallet
            const wallet = fromWallet ?? this.createFounderEthersWallet();
            const provider = this.getDefaultExecuteLayerClient().getProvider();

            // Get current nonce and gas information
            const baseNonce = await provider.getTransactionCount(wallet.address, 'pending');
            const feeData = await provider.getFeeData();

            // Build all transaction promises concurrently
            const txPromises = transactions.map((transaction, i) => {
                const tx: ethers.TransactionRequest = {
                    to: transaction.to,
                    value: ethers.parseEther(transaction.value),
                    nonce: baseNonce + i, // Pre-assign incrementing nonce
                };

                // Set gas fees
                if (priorityFeePerGas) {
                    tx.maxPriorityFeePerGas = priorityFeePerGas;
                } else if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                    tx.maxFeePerGas = feeData.maxFeePerGas;
                    tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
                } else {
                    tx.gasPrice = feeData.gasPrice;
                }

                return wallet.sendTransaction(tx);
            });

            // Execute all transactions concurrently
            const results = await Promise.all(txPromises);

            return results;
        } catch (error) {
            throw new Error(`Failed to send multiple transactions concurrently: ${error}`);
        }
    }

    /**
     * Create and fund multiple wallets
     * @param count - Number of wallets to create
     * @param fundingAmount - Amount to fund each wallet (ETH), default '0.1'
     * @param fromWallet - Optional source wallet, defaults to founderWallet
     * @returns Array of created wallets and funding transactions
     */
    async createAndFundWallets(
        count: number,
        fundingAmount: string = '0.1',
        fromWallet?: ethers.Wallet | ethers.HDNodeWallet
    ): Promise<{
        wallets: (ethers.Wallet | ethers.HDNodeWallet)[];
        fundingTransactions: Array<{ wallet: ethers.Wallet | ethers.HDNodeWallet; tx: any; index: number }>;
    }> {
        console.log(`   Generating ${count} new wallets...`);

        // Create wallets
        const wallets: (ethers.Wallet | ethers.HDNodeWallet)[] = Array.from({ length: count }, (_, i) => {
            const wallet = this.createWallet();
            console.log(`   Generated wallet ${i + 1}: ${wallet.address}`);
            return wallet;
        });

        console.log(`   ✅ Generated ${wallets.length} wallets`);

        // Fund wallets
        console.log(`   🚀 Funding wallets with ${fundingAmount} ETH...`);
        const fundingTransactions: Array<{ wallet: ethers.Wallet | ethers.HDNodeWallet; tx: any; index: number }> = [];

        try {
            const transactions = wallets.map(wallet => ({
                to: wallet.address,
                value: fundingAmount,
            }));

            const sourceWallet = fromWallet ?? this.createFounderEthersWallet();
            const results = await this.sendMultipleTransactions(transactions, sourceWallet);

            results.forEach((tx: any, index) => {
                if (tx) {
                    console.log(`   📤 Funded wallet ${index + 1}: ${wallets[index].address} -> Hash: ${tx?.hash}`);
                    fundingTransactions.push({
                        wallet: wallets[index],
                        tx,
                        index: index + 1,
                    });
                }
            });
        } catch (error) {
            console.error(`   ❌ Failed to fund wallets in batch:`, error);
        }

        return { wallets, fundingTransactions };
    }

    /**
     * Wait for multiple transaction confirmations
     * @param transactions - Transaction array [{tx: {hash}, index}]
     * @param timeout - Timeout in milliseconds, default 60000
     * @returns Array of confirmation results
     */
    async waitForTransactionConfirmations(
        transactions: Array<{ tx: { hash: string }; index: number }>,
        timeout: number = 60000
    ): Promise<Array<{ success: boolean; index: number; blockNumber?: number; error?: any }>> {
        if (transactions.length === 0) {
            return [];
        }

        console.log(`   ⏳ Waiting for ${transactions.length} transactions to be confirmed...`);

        const provider = this.getDefaultExecuteLayerClient().getProvider();
        const confirmationPromises = transactions.map(async funding => {
            try {
                const receipt = await provider.waitForTransaction(funding.tx.hash, 1, timeout);
                console.log(`   ✅ Transaction ${funding.index} confirmed in block: ${receipt?.blockNumber}`);
                return {
                    success: true,
                    index: funding.index,
                    blockNumber: receipt?.blockNumber,
                };
            } catch (error) {
                console.error(`   ❌ Transaction ${funding.index} failed:`, error);
                return { success: false, index: funding.index, error };
            }
        });

        const results = await Promise.all(confirmationPromises);
        const successCount = results.filter(r => r.success).length;
        console.log(`   ✅ ${successCount}/${transactions.length} transactions confirmed`);

        return results;
    }

    /**
     * Print environment summary information
     * @param envName - Optional environment name
     */
    printEnvironmentSummary(envName?: string): void {
        console.log('\n' + '='.repeat(60));
        console.log('📋 TEST ENVIRONMENT SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Chain Name: ${this.name}`);
        console.log(`   Chain ID: ${this.chainId}`);
        if (envName) {
            console.log(`   Environment: ${envName}`);
        }
        if (this.consensusLayer) {
            console.log(`   Consensus Layer: ${this.consensusLayer}`);
        }
        console.log(`   EVM RPC URL: ${this.executeLayerHttpRpcUrl}`);
        console.log('');
        console.log('   📡 Nodes Configuration:');
        console.log(`   Total Nodes: ${this.nodes.length}`);
        console.log(`   Active Nodes: ${this.getActiveNodes().length}`);
        console.log('');

        this.nodes.forEach(node => {
            const status = node.active ? '✓' : '✗';
            const typeIcon = node.type === 'bootnode' ? '🔗' : '🖥️';
            const portInfo = node.consensusLayerRpcPort ? `, CometBFT port: ${node.consensusLayerRpcPort}` : '';
            console.log(`   ${status} ${typeIcon} Node ${node.index}: ${node.url} (${node.type}${portInfo})`);
        });

        console.log('');
        console.log(`   💰 Founder Wallet: ${this.founderWallet?.address ?? 'N/A'}`);
        console.log('='.repeat(60) + '\n');
    }

    // ============================================
    // Public RPC URL Methods
    // For production environments or scenarios where specific nodes don't matter
    // ============================================

    /**
     * Get public EVM RPC URL (execution layer)
     * @returns Complete EVM RPC URL
     */
    getExecuteLayerRpcUrl(): string {
        return this.executeLayerHttpRpcUrl;
    }

    /**
     * Get public CometBFT RPC URL (consensus layer)
     * @returns Complete consensus layer RPC URL, or throws if not configured
     */
    getConsensusLayerRpcUrl(): string {
        if (!this.consensusLayerRpcUrl) {
            throw new Error('Consensus layer RPC URL is not configured');
        }
        return this.consensusLayerRpcUrl;
    }

    /**
     * Get public Cosmos REST API URL (consensus layer)
     * @returns Complete REST API URL, or throws if not configured
     */
    getConsensusLayerRestUrl(): string {
        if (!this.consensusLayerHttpRestApiUrl) {
            throw new Error('Consensus layer REST API URL is not configured');
        }
        return this.consensusLayerHttpRestApiUrl;
    }

    /**
     * @deprecated Use getExecuteLayerRpcUrl() instead
     */
    getPublicEndpoint(): string {
        return this.getExecuteLayerRpcUrl();
    }

    /**
     * Send simple transaction via public endpoint
     * Uses top-level config URL and port, does not depend on nodes array
     * @param to - Destination address
     * @param value - Amount (ETH)
     * @param privateKey - Optional, defaults to founderWallet
     * @returns Transaction result
     */
    async sendSimpleTransactionViaPublicEndpoint(
        to: string,
        value: string,
        privateKey?: string
    ): Promise<TransactionResult> {
        const endpoint = this.getPublicEndpoint();
        const provider = new ethers.JsonRpcProvider(endpoint);
        const wallet = new ethers.Wallet(privateKey ?? this.founderWallet?.privateKey ?? '', provider);

        const tx = await wallet.sendTransaction({
            to,
            value: ethers.parseEther(value),
        });

        return {
            hash: tx.hash,
            status: 'pending',
            gasUsed: '0',
            blockNumber: 0,
        };
    }

    /**
     * Send full transaction via public endpoint
     * @param request - Transaction request
     * @param privateKey - Private key
     * @returns Transaction result
     */
    async sendTransactionViaPublicEndpoint(
        request: TransactionRequest,
        privateKey: string
    ): Promise<TransactionResult> {
        const endpoint = this.getPublicEndpoint();
        const provider = new ethers.JsonRpcProvider(endpoint);
        const wallet = new ethers.Wallet(privateKey, provider);

        const tx: ethers.TransactionRequest = {
            to: request.to,
            value: request.amount ? BigInt(request.amount) : undefined,
            data: request.data,
            gasLimit: request.gasLimit ? BigInt(request.gasLimit.toString()) : undefined,
            gasPrice: request.gasPrice ? BigInt(request.gasPrice.toString()) : undefined,
        };

        const result = await wallet.sendTransaction(tx);

        return {
            hash: result.hash,
            status: 'pending',
            gasUsed: '0',
            blockNumber: 0,
        };
    }

    /**
     * Create wallet connected to current blockchain provider
     * @param privateKey Optional private key, randomly generated if not provided
     * @returns Wallet connected to current blockchain provider
     */
    createWallet(privateKey?: string): ethers.Wallet | ethers.HDNodeWallet {
        try {
            if (this.executeLayer !== BlockchainType.EVM) {
                throw new Error(`createWallet requires EVM-compatible blockchain, got: ${this.executeLayer}`);
            }

            return this.createEthersWallet(privateKey);
        } catch (error) {
            throw new Error(`Failed to create wallet: ${error}`);
        }
    }

    /**
     * Create wallet connected to public endpoint (load balancer)
     * @param privateKey - Optional private key, generates random if not provided
     * @returns Wallet connected to public endpoint provider
     */
    createWalletViaPublicEndpoint(privateKey?: string): ethers.Wallet | ethers.HDNodeWallet {
        try {
            if (this.executeLayer !== BlockchainType.EVM) {
                throw new Error(
                    `createWalletViaPublicEndpoint requires EVM-compatible blockchain, got: ${this.executeLayer}`
                );
            }

            const endpoint = this.getPublicEndpoint();
            const provider = new ethers.JsonRpcProvider(endpoint);

            if (privateKey) {
                return new ethers.Wallet(privateKey, provider);
            } else {
                return ethers.Wallet.createRandom(provider);
            }
        } catch (error) {
            throw new Error(`Failed to create wallet via public endpoint: ${error}`);
        }
    }

    /**
     * Get wallet balance
     * @param walletAddress Wallet address, uses founder wallet address if not provided
     * @param blockNumber Optional block number, defaults to 'latest'
     * @returns Formatted ETH balance string
     */
    async getWalletBalance(walletAddress?: string, blockNumber?: number): Promise<string> {
        try {
            if (this.executeLayer !== BlockchainType.EVM) {
                throw new Error(`getWalletBalance requires EVM-compatible blockchain, got: ${this.executeLayer}`);
            }

            const provider = this.getDefaultExecuteLayerClient().getProvider();
            const address = walletAddress ?? this.founderWallet?.address;

            if (!address) {
                throw new Error('Wallet address is required');
            }

            const block = blockNumber ?? 'latest';
            const balance = await provider.getBalance(address, block);
            const formattedBalance = ethers.formatEther(balance);

            return formattedBalance;
        } catch (error) {
            throw new Error(`Failed to get wallet balance: ${error}`);
        }
    }

    getExecuteLayerClient(nodeIndex?: number): IExecuteLayerClient {
        if (nodeIndex !== undefined) {
            const node = this.getNode(nodeIndex);
            if (!node.active) {
                throw new Error(`Node ${nodeIndex} is not active`);
            }
            const client = node.getExecuteLayerClient();
            if (!client) {
                throw new Error(`No client available for node index: ${nodeIndex}`);
            }
            return client;
        } else {
            // Return the first active non-bootnode's client by default
            const nodes = this.getActiveNotBootNodes();
            if (nodes.length === 0) {
                throw new Error(`No active nodes available for blockchain: ${this.name}`);
            }
            const node = nodes[0];
            const client = node.getExecuteLayerClient();
            if (!client) {
                throw new Error(`No client available for the first active node of blockchain: ${this.name}`);
            }
            return client;
        }
    }

    getDefaultExecuteLayerClient(): IExecuteLayerClient {
        // Return the first active non-bootnode's execution layer client by default
        const nodes = this.getActiveNotBootNodes();
        if (nodes.length === 0) {
            throw new Error(`No active nodes available for blockchain: ${this.name}`);
        }
        const node = nodes[0];
        const client = node.getExecuteLayerClient();
        if (!client) {
            throw new Error(`No execute layer client available for the first active node of blockchain: ${this.name}`);
        }
        return client;
    }

    getDefaultConsensusLayerClient(): IConsensusLayerClient {
        // Return the first active non-bootnode's consensus layer client by default
        const nodes = this.getActiveNotBootNodes();
        if (nodes.length === 0) {
            throw new Error(`No active nodes available for blockchain: ${this.name}`);
        }
        const node = nodes[0];
        const client = node.getConsensusLayerClient();
        if (!client) {
            throw new Error(
                `No consensus layer client available for the first active node of blockchain: ${this.name}`
            );
        }
        return client;
    }

    /**
     * Get network information
     * @returns Network information, or error information if retrieval fails
     */
    async getNetworkInfo(): Promise<any> {
        try {
            const client = this.getDefaultConsensusLayerClient();
            const info = await client.getNetworkInfo();
            return info;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(`Failed to get network info for ${this.name}: ${errorMessage}`);
            return { error: errorMessage };
        }
    }

    /**
     * Validate address format
     * @param address Address to validate
     * @returns Whether the address is valid
     */
    validateAddress(address: string): boolean {
        try {
            const client = this.getDefaultExecuteLayerClient();
            return client.isValidAddress(address);
        } catch (error) {
            console.warn(`Address validation failed: ${error}`);
            return false;
        }
    }

    /**
     * Clean up all node connections
     */
    async cleanup(): Promise<void> {
        for (const node of this.nodes) {
            try {
                await node.cleanup();
            } catch (error) {
                console.warn(
                    `Error during cleanup for node ${node.index}:`,
                    error instanceof Error ? error.message : String(error)
                );
            }
        }

        // Clear nodes array
        this.nodes.length = 0;
        console.log(`Cleanup completed for blockchain: ${this.name}`);
    }

    createTransactionRequest(account: string): TransactionRequest {
        if (this.executeLayer === BlockchainType.EVM) {
            // Amount should be in wei for EVM chains
            const amountInWei = ethers.parseEther('0.01').toString();
            return {
                to: account,
                amount: amountInWei,
                memo: `Test transaction from ${this.name}`,
            };
        } else if (this.executeLayer === BlockchainType.COSMOS) {
            return {
                to: 'cosmos1example123456789abcdefghijk',
                amount: '0.1',
                memo: `Test transaction from ${this.name}`,
            };
        } else {
            throw new Error(`Unsupported blockchain type: ${this.executeLayer}`);
        }
    }

    /**
     * Execute RPC call through execute layer client
     * @param request The RPC request
     * @param requestSchema Optional request schema for validation
     * @param responseSchema Optional response schema for validation
     * @param nodeIndex Optional node index, defaults to first node
     * @returns RPC response
     */
    async makeRpcCall(
        request: Request,
        requestSchema?: any,
        responseSchema?: any,
        nodeIndex?: number
    ): Promise<Response> {
        const client = this.getExecuteLayerClient(nodeIndex);

        // Check if client has makeRpcCall method (for EVMExecuteClient)
        if (typeof (client as any).makeRpcCall === 'function') {
            return await (client as any).makeRpcCall(request, requestSchema, responseSchema);
        }

        throw new Error(`makeRpcCall is not supported by the current execute layer client`);
    }

    /**
     * Execute consensus RPC call through consensus layer client
     * @param path The RPC path (e.g., '/status', '/validators')
     * @param params The RPC parameters
     * @param paramsSchema Optional request schema for validation
     * @param responseSchema Optional response schema for validation
     * @param _responseCheckFrom Optional response check path
     * @param nodeIndex Optional node index, defaults to first active node
     * @returns RPC response
     */
    async makeConsensusRpcCall(
        path: string,
        params: any = {},
        paramsSchema?: any,
        responseSchema?: any,
        responseCheckFrom: string = '',
        nodeIndex?: number
    ): Promise<any> {
        const node = nodeIndex !== undefined ? this.getNode(nodeIndex) : this.getActiveNotBootNodes()[0];
        const consensusClient = node.getConsensusLayerClient();

        if (!consensusClient) {
            throw new Error('Consensus layer client not initialized');
        }

        if (paramsSchema) {
            const validation = validateSchema(params, paramsSchema);
            if (!validation.valid) {
                console.warn(
                    `⚠️  Consensus RPC request schema validation warning [${path}]:\n${formatValidationErrors(validation.errors)}`
                );
            }
        }

        if (typeof (consensusClient as any).makeRpcRequest !== 'function') {
            throw new Error(`makeRpcRequest is not supported by the current consensus layer client`);
        }

        const response = await (consensusClient as any).makeRpcRequest(path, params);

        if (responseSchema) {
            // When responseCheckFrom is specified (e.g. 'result.header'), validate
            // only that sub-path; otherwise validate the full response envelope.
            let target = response;
            if (responseCheckFrom) {
                for (const key of responseCheckFrom.split('.')) {
                    target = target?.[key];
                }
            }

            const validation = validateSchema(target, responseSchema);
            if (!validation.valid) {
                const preview = JSON.stringify(response)?.substring(0, 500);
                const errorMsg =
                    `Consensus RPC response schema validation failed [${path}]:\n` +
                    `${formatValidationErrors(validation.errors)}\n` +
                    `  Actual response: ${preview}`;
                throw new Error(errorMsg);
            }
        }

        return response;
    }

    /**
     * Check connection status of specified nodes (via node's own method)
     * @param nodeIps Node IP list, supports pure IP or full URL format
     */
    async checkNodesConnectivity(
        nodeIps: string[]
    ): Promise<Map<string, { evmConnected: boolean; consensusConnected: boolean }>> {
        const results = new Map();

        for (const ip of nodeIps) {
            // Extract pure IP for matching (supports passing pure IP or full URL)
            const inputIp = ip.replace(/^https?:\/\//, '');

            // Find corresponding node instance
            const node = this.nodes.find(n => {
                const nodeIp = n.url.replace(/^https?:\/\//, '');
                return nodeIp === inputIp;
            }) as BlockchainNode;

            if (node) {
                // Use node's own method to check connectivity
                const connectivity = await node.checkConnectivity();
                results.set(ip, connectivity);
            } else {
                // Node not in list, return unable to connect
                console.warn(`Node ${ip} not found in blockchain nodes list`);
                results.set(ip, { evmConnected: false, consensusConnected: false });
            }
        }

        return results;
    }

    /**
     * Get RPC responses from multiple nodes (via node's own method)
     */
    async getMultipleNodeResponses(
        request: Request,
        nodeIndices?: number[]
    ): Promise<Array<{ nodeIndex: number; response: any; error?: Error }>> {
        const targetNodes = nodeIndices ? nodeIndices.map(i => this.getNode(i)) : this.getActiveNotBootNodes();

        const results = await Promise.allSettled(
            targetNodes.map(async node => {
                // Use node's own method to execute RPC request
                const result = await (node as BlockchainNode).makeRpcRequest(request);
                return {
                    nodeIndex: node.index,
                    response: result.response,
                    error: result.error,
                };
            })
        );

        return results.map(result =>
            result.status === 'fulfilled' ? result.value : { nodeIndex: -1, response: null, error: result.reason }
        );
    }
}
