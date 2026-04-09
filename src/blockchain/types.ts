/**
 * Blockchain abstraction types and interfaces
 */

import { ethers } from 'ethers';
import type { EnvironmentSSHConfig, NodeSSHConfig } from '../infrastructure/nodes';
import type { EnvironmentDockerConfig, NodeDockerConfig } from '../infrastructure/docker';
// TODO: Add Cosmos SDK imports when implementing
// import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
// import { fromHex } from "@cosmjs/encoding";

export enum BlockchainType {
    EVM = 'evm',
    COSMOS = 'cosmos',
    SOLANA = 'solana',
    POLKADOT = 'polkadot',
}

// Execution method for node operations (start/stop)
export type ExecutionMethod = 'ssh' | 'docker' | 'none';
export type TransactionConfirmationStrategy = 'provider-wait' | 'receipt-polling';

export type { EnvironmentSSHConfig, NodeSSHConfig, EnvironmentDockerConfig, NodeDockerConfig };

export enum NodeType {
    VALIDATOR = 'validator',
    NON_VALIDATOR = 'non-validator',
    BOOTNODE = 'bootnode',
}

export enum PrivateKeySource {
    LOCAL = 'local',
    ENV = 'env',
}

export interface INetworkConfig {
    url: string;
    // Full URLs take precedence over host+port derivation when provided
    executeLayerHttpRpcUrl?: string;
    consensusLayerRpcUrl?: string;
    consensusLayerHttpRestApiUrl?: string;
    controlPlaneRpcUrl?: string;
    infoApiUrl?: string;
    healthApiUrl?: string;
    // Ports can be: number (exposed), null (explicitly not exposed), undefined (use default)
    executeLayerHttpRpcPort?: number | null;
    consensusLayerHttpRestApiPort?: number | null;
    consensusLayerRpcPort?: number | null;
    consensusLayerP2pCommPort?: number | null;
}

export interface IRuntimeTestConfig {
    timeout?: number;
    retries?: number;
}
export interface IBlockchainMeta {
    name: string;
    chainId: string;
    chainType: BlockchainType; // type == executeLayer for now
    executeLayer: BlockchainType;
    consensusLayer: BlockchainType;
    ecosystem?: string;
    controlPlane?: string;
    nativeToken?: string;
    addressPrefix?: string;
}

export interface IBaseBlockchain extends IBlockchainMeta, IRuntimeTestConfig {
    // Public RPC URLs (complete URLs, no port appending needed)
    executeLayerHttpRpcUrl: string;
    consensusLayerRpcUrl?: string;
    consensusLayerHttpRestApiUrl?: string;
    controlPlaneRpcUrl?: string;
    infoApiUrl?: string;
    healthApiUrl?: string;
    transactionConfirmationStrategy?: TransactionConfirmationStrategy;
    transactionConfirmationTimeoutMs?: number;
    transactionConfirmationPollIntervalMs?: number;
    // REST API path prefix for Cosmos SDK compatibility (e.g., '/cosmos' for evmos, '' for story)
    consensusRestApiPathPrefix?: string;
    // REST API version for Cosmos SDK (e.g., 'v1beta1' for standard Cosmos, '' for simplified paths)
    consensusRestApiVersion?: string;
    // Execution method for node operations (start/stop): 'ssh' | 'docker' | 'none'
    executionMethod?: ExecutionMethod;
    // SSH configuration for remote operations
    ssh?: EnvironmentSSHConfig;
    // Docker configuration for container operations
    docker?: EnvironmentDockerConfig;
}

export interface IBlockchain extends IBaseBlockchain {
    nodes: IBlockchainNode[];
    founderWallet?: IWallet;

    /**
     * Test connectivity for all nodes
     * @param timeout Timeout in milliseconds, will be passed to each node's connection test
     */
    testConnectivity(timeout?: number): Promise<Map<number, boolean>>;
}
export interface IBlockchainNode extends INetworkConfig {
    blockchain: IBaseBlockchain;
    index: number;
    type: NodeType;
    votingPower?: number;
    active: boolean;
    ssh?: NodeSSHConfig;
    docker?: NodeDockerConfig;

    /**
     * Test node connectivity
     * @param timeout Timeout in milliseconds, optional parameter
     */
    testConnection(timeout?: number): Promise<boolean>;

    /**
     * Send transaction
     * @param request Transaction request
     * @param privateKey Private key
     */
    sendTransaction(request: TransactionRequest, privateKey: string): Promise<TransactionResult>;

    /**
     * Get block height
     */
    getBlockHeight(): Promise<number>;

    /**
     * Get network configuration
     */
    getNetworkConfig(): INetworkConfig;

    /**
     * Get client configuration
     */
    getClientConfig(): IClientConfig;

    /**
     * Get execute layer client
     */
    getExecuteLayerClient(): IExecuteLayerClient | null;

    /**
     * Get consensus layer client
     */
    getConsensusLayerClient(): IConsensusLayerClient | null;

    getClient(type: BlockchainType): IExecuteLayerClient | IConsensusLayerClient;

    /**
     * Get execute layer RPC URL (base url + port)
     * @throws Error if port is not exposed (null)
     */
    getExecuteLayerRpcUrl(): string;

    /**
     * Get consensus layer RPC URL (base url + port)
     * @throws Error if port is not exposed (null)
     */
    getConsensusLayerRpcUrl(): string;

    /**
     * Get consensus layer REST API URL (base url + port)
     * @throws Error if port is not exposed (null)
     */
    getConsensusLayerRestUrl(): string;

    /**
     * Clean up node connections
     */
    cleanup(): Promise<void>;
}

export interface IClientConfig {
    name: string;
    timeout?: number;
    nativeToken?: string;
    addressPrefix?: string;
}
export interface TransactionRequest {
    from?: string;
    to: string;
    amount: string;
    memo?: string;
    gasLimit?: string | number;
    gasPrice?: string | number;
    maxFeePerGas?: string | number;
    maxPriorityFeePerGas?: string | number;
    nonce?: number;
    data?: string;
}

export interface TransactionResult {
    hash: string;
    blockNumber?: number;
    blockHash?: string;
    status: 'success' | 'failed' | 'pending';
    gasUsed?: string | number;
    fee?: string;
    confirmations?: number;
    timestamp?: number;
}

export interface BlockInfo {
    number: number;
    hash: string;
    parentHash?: string;
    timestamp: number;
    transactions: string[];
    gasLimit?: string;
    gasUsed?: string | undefined;
    proposer?: string;
}

export interface AccountInfo {
    address: string;
    balance: string;
    nonce?: number;
    sequence?: number; // For Cosmos chains
    accountNumber?: number; // For Cosmos chains
}

export interface NetworkInfo {
    chainId: string | number;
    blockHeight: number;
    networkName?: string;
    consensusVersion?: string;
    validators?: ValidatorInfo[];
}

export interface ValidatorInfo {
    address: string;
    moniker?: string;
    votingPower: string;
    status: string;
    commission?: string;
}

/**
 * Execute layer client interface - handles transaction execution and account operations
 */
export interface IExecuteLayerClient {
    readonly config: IClientConfig;

    // Connection management
    isConnected(): Promise<boolean>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;

    // Account operations
    getAccount(address: string): Promise<AccountInfo>;
    createAccount(privateKey?: string): Promise<{ address: string; privateKey: string }>;

    // Transaction operations
    sendTransaction(request: TransactionRequest, privateKey: string): Promise<TransactionResult>;
    getTransaction(hash: string): Promise<TransactionResult | null>;
    waitForTransaction(hash: string, confirmations?: number): Promise<TransactionResult>;
    estimateGas(request: TransactionRequest): Promise<string>;

    // Block information - execution layer perspective (via provider)
    getBlockHeight(): Promise<number>;
    getBlock(height?: number): Promise<BlockInfo>;

    // Utility methods
    isValidAddress(address: string): boolean;
    formatAmount(amount: string): string;
    parseAmount(amount: string): string;

    getNetworkInfo(): Promise<NetworkInfo>;

    // get provider(): any; // Returns the specific provider instance, type depends on blockchain type
    getProvider(): any;
}

/**
 * Consensus layer client interface - handles consensus and network information
 */
export interface IConsensusLayerClient {
    readonly config: IClientConfig;
    readonly restEndpoint: string;
    readonly rpcEndpoint: string;

    // Connection management
    isConnected(): Promise<boolean>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;

    // Network and consensus information
    getNetworkInfo(): Promise<NetworkInfo>;
    getBlockHeight(): Promise<number>;
    getBlock(height?: number): Promise<BlockInfo>;
    getValidators(): Promise<ValidatorInfo[]>;

    // Transaction queries (for consensus layer transaction lookups like in Cosmos)
    getTransaction(hash: string): Promise<TransactionResult | null>;

    // Staking Module APIs - supports custom path
    getStakingValidators(customPath?: string): Promise<any>;
    getStakingParams(customPath?: string): Promise<any>;
    getStakingPool(customPath?: string): Promise<any>;
    getStakingValidator(validatorAddr: string, customPath?: string): Promise<any>;
    getValidatorDelegations(validatorAddr: string, customPath?: string): Promise<any>;
    getDelegatorDelegations(delegatorAddr: string, customPath?: string): Promise<any>;
    getDelegatorUnbondingDelegations(delegatorAddr: string, customPath?: string): Promise<any>;
    getDelegatorRedelegations(delegatorAddr: string, customPath?: string): Promise<any>;
    getDelegatorValidators(delegatorAddr: string, customPath?: string): Promise<any>;

    // Slashing Module APIs - supports custom path
    getSlashingParams(customPath?: string): Promise<any>;
    getSlashingSigningInfos(customPath?: string): Promise<any>;
    getSlashingSigningInfo(consAddress: string, customPath?: string): Promise<any>;

    // Mint Module APIs - supports custom path
    getMintParams(customPath?: string): Promise<any>;

    // Node and Chain Information - supports custom path
    getNodeInfo(customPath?: string): Promise<any>;

    // Auth / Tx APIs
    getAuthAccount(address: string, customPath?: string): Promise<any>;
    broadcastTx(txBytesBase64: string, mode?: string, customPath?: string): Promise<any>;
}

/**
 * Control plane client interface - handles platform/network-level metadata and health.
 * This is intentionally smaller than IConsensusLayerClient because not every ecosystem
 * exposes Cosmos/CometBFT-style consensus APIs.
 */
export interface IControlPlaneClient {
    readonly config: IClientConfig;
    readonly rpcEndpoint?: string;
    readonly infoEndpoint?: string;
    readonly healthEndpoint?: string;

    isConnected(): Promise<boolean>;
    connect(): Promise<void>;
    disconnect(): Promise<void>;

    getNetworkInfo(): Promise<NetworkInfo>;
    getValidators(...args: any[]): Promise<ValidatorInfo[]>;
}

/**
 * Abstract blockchain client interface - combines both layers for compatibility
 * Inherits from both layered interfaces, providing complete blockchain client functionality
 */
export interface IBlockchainClient extends IExecuteLayerClient, IConsensusLayerClient {
    // Since this inherits from both interfaces, all methods are already included
    // No need to repeat declarations, TypeScript will automatically merge the interfaces
}

/**
 * RPC request/response types
 */
export interface RpcRequest {
    method: string;
    params: any[];
    id?: number;
    jsonrpc?: string;
}

export interface RpcResponse<T = any> {
    result?: T;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
    id?: number;
    jsonrpc?: string;
}

// Legacy type aliases for backward compatibility
export type Request = RpcRequest;
export type Response = RpcResponse;

/**
 * Test configuration types
 */
export interface TestConfig {
    blockchains: IBlockchain[];
    defaultBlockchain?: string;
    timeout?: number;
    retries?: number;
    accounts?: {
        [key: string]: string; // name -> private key
    };
}

export interface IWallet {
    name: string;
    address: string;
    privateKey?: string;
    privateKeySource?: PrivateKeySource; // Only 'local' or 'env'
    mnemonic?: string;
    balance?: string;

    sendTransaction?(request: TransactionRequest): Promise<TransactionResult>;
}

export interface BaseBlockchain {
    name: string;
    chainId: string;
    executeLayer: BlockchainType;
    consensusLayer: BlockchainType;
}

export class EVMWallet implements IWallet {
    name: string;
    address: string;
    privateKey?: string;
    privateKeySource?: PrivateKeySource;
    mnemonic?: string;
    balance?: string;
    private wallet: ethers.Wallet | ethers.HDNodeWallet | undefined;

    // Private constructor
    private constructor(
        name: string,
        address: string,
        privateKey: string,
        wallet: ethers.Wallet | ethers.HDNodeWallet,
        privateKeySource: PrivateKeySource = PrivateKeySource.LOCAL,
        mnemonic?: string,
        balance?: string
    ) {
        this.name = name;
        this.address = address;
        this.privateKey = privateKey;
        this.wallet = wallet;
        this.privateKeySource = privateKeySource;
        this.mnemonic = mnemonic;
        this.balance = balance;
    }

    // Static factory method to create from config
    static createFromCfg(cfg: IWallet): EVMWallet {
        // Validate privateKeySource
        if (cfg.privateKeySource && !Object.values(PrivateKeySource).includes(cfg.privateKeySource)) {
            throw new Error(`Invalid privateKeySource: ${cfg.privateKeySource}`);
        }

        let wallet: ethers.Wallet | ethers.HDNodeWallet;
        let privateKey: string;
        let address: string;

        // Handle different private key sources
        if (cfg.privateKeySource === PrivateKeySource.ENV) {
            const envKey = process.env['FOUNDER_WALLET_PK'];
            if (!envKey) {
                throw new Error('Environment variable FOUNDER_WALLET_PK is not set');
            }
            privateKey = envKey;
            wallet = new ethers.Wallet(envKey);
            address = wallet.address;
        } else if (cfg.privateKey) {
            // Use provided private key
            privateKey = cfg.privateKey;
            wallet = new ethers.Wallet(cfg.privateKey);
            address = wallet.address;
        } else {
            throw new Error('No private key provided in config');
        }

        return new EVMWallet(
            cfg.name,
            address,
            privateKey,
            wallet,
            cfg.privateKeySource ?? PrivateKeySource.LOCAL,
            cfg.mnemonic,
            cfg.balance
        );
    }

    // Static method to create random wallet
    static createRandom(privateKey?: string, mnemonic?: string): EVMWallet {
        let wallet: ethers.Wallet | ethers.HDNodeWallet;
        let finalPrivateKey: string;
        let finalMnemonic: string | undefined;

        if (privateKey) {
            // Create from provided private key
            wallet = new ethers.Wallet(privateKey);
            finalPrivateKey = privateKey;
            finalMnemonic = mnemonic;
        } else if (mnemonic) {
            // Create from provided mnemonic
            wallet = ethers.Wallet.fromPhrase(mnemonic);
            finalPrivateKey = wallet.privateKey;
            finalMnemonic = mnemonic;
        } else {
            // Create completely random wallet
            wallet = ethers.Wallet.createRandom();
            finalPrivateKey = wallet.privateKey;
            finalMnemonic = wallet.mnemonic?.phrase;
        }

        return new EVMWallet(
            'Random Wallet',
            wallet.address,
            finalPrivateKey,
            wallet,
            PrivateKeySource.LOCAL,
            finalMnemonic
        );
    }

    // Static method to create multiple random wallets
    static createRandoms(count: number): EVMWallet[] {
        const wallets: EVMWallet[] = [];
        for (let i = 0; i < count; i++) {
            const wallet = EVMWallet.createRandom();
            wallet.name = `Random Wallet ${i + 1}`;
            wallets.push(wallet);
        }
        return wallets;
    }
}

export class CosmosWallet implements IWallet {
    name: string;
    address: string;
    privateKey?: string;
    privateKeySource?: PrivateKeySource;
    mnemonic?: string;
    balance?: string;

    // Private constructor
    private constructor(
        name: string,
        address: string,
        privateKey: string,
        privateKeySource: PrivateKeySource = PrivateKeySource.LOCAL,
        mnemonic?: string,
        balance?: string
    ) {
        this.name = name;
        this.address = address;
        this.privateKey = privateKey;
        this.privateKeySource = privateKeySource;
        this.mnemonic = mnemonic;
        this.balance = balance;
    }

    // Static factory method to create from config
    static createFromCfg(cfg: IWallet): CosmosWallet {
        // Validate privateKeySource
        if (cfg.privateKeySource && !Object.values(PrivateKeySource).includes(cfg.privateKeySource)) {
            throw new Error(`Invalid privateKeySource: ${cfg.privateKeySource}`);
        }

        let privateKey: string;
        let address: string;

        // Handle different private key sources
        if (cfg.privateKeySource === PrivateKeySource.ENV) {
            const envKey = process.env['COSMOS_FOUNDER_WALLET_PK'];
            if (!envKey) {
                throw new Error('Environment variable COSMOS_FOUNDER_WALLET_PK is not set');
            }
            privateKey = envKey;
            // TODO: Derive address from private key using Cosmos SDK
            address = cfg.address || 'cosmos1...'; // Placeholder until Cosmos SDK integration
        } else if (cfg.privateKey) {
            // Use provided private key
            privateKey = cfg.privateKey;
            // TODO: Derive address from private key using Cosmos SDK
            address = cfg.address || 'cosmos1...'; // Placeholder until Cosmos SDK integration
        } else {
            throw new Error('No private key provided in config');
        }

        return new CosmosWallet(
            cfg.name,
            address,
            privateKey,
            cfg.privateKeySource ?? PrivateKeySource.LOCAL,
            cfg.mnemonic,
            cfg.balance
        );
    }

    // Static method to create random wallet
    static createRandom(privateKey?: string, mnemonic?: string): CosmosWallet {
        let finalPrivateKey: string;
        let finalMnemonic: string | undefined;
        let address: string;

        if (privateKey) {
            // Create from provided private key
            finalPrivateKey = privateKey;
            finalMnemonic = mnemonic;
            // TODO: Use @cosmjs/proto-signing to derive address
            // const wallet = await DirectSecp256k1HdWallet.fromKey(fromHex(privateKey), "cosmos");
            // const [account] = await wallet.getAccounts();
            // address = account.address;
            address = 'cosmos1...'; // Placeholder until Cosmos SDK integration
        } else if (mnemonic) {
            // Create from provided mnemonic
            // TODO: Use @cosmjs/proto-signing to generate from mnemonic
            // const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "cosmos" });
            // const [account] = await wallet.getAccounts();
            // finalPrivateKey = await wallet.getPrivateKey(account.address);
            // address = account.address;
            finalPrivateKey = 'generated_from_mnemonic'; // Placeholder
            finalMnemonic = mnemonic;
            address = 'cosmos1...'; // Placeholder until Cosmos SDK integration
        } else {
            // Create completely random wallet
            // TODO: Use @cosmjs/proto-signing to generate random wallet
            // const wallet = await DirectSecp256k1HdWallet.generate(24, { prefix: "cosmos" });
            // const [account] = await wallet.getAccounts();
            // finalPrivateKey = await wallet.getPrivateKey(account.address);
            // finalMnemonic = wallet.mnemonic;
            // address = account.address;
            finalPrivateKey = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15); // Placeholder
            finalMnemonic = 'generated random mnemonic'; // Placeholder
            address = 'cosmos1...'; // Placeholder until Cosmos SDK integration
        }

        return new CosmosWallet(
            'Random Cosmos Wallet',
            address,
            finalPrivateKey,
            PrivateKeySource.LOCAL,
            finalMnemonic
        );
    }

    // Static method to create multiple random wallets
    static createRandoms(count: number): CosmosWallet[] {
        const wallets: CosmosWallet[] = [];
        for (let i = 0; i < count; i++) {
            const wallet = CosmosWallet.createRandom();
            wallet.name = `Random Cosmos Wallet ${i + 1}`;
            wallets.push(wallet);
        }
        return wallets;
    }
}
