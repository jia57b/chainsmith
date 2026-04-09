import { BlockchainFactory } from '../blockchain/factory';
import {
    IBaseBlockchain,
    IExecuteLayerClient,
    IConsensusLayerClient,
    IBlockchainNode,
    INetworkConfig,
    IClientConfig,
    NodeType,
    TransactionRequest,
    TransactionResult,
    BlockchainType,
} from '../blockchain/types';
import { DEFAULT_PORTS } from '../blockchain/constants';

/**
 * Chain specification containing essential blockchain network properties
 * Used for blockchain client initialization and network identification
 */

export class BlockchainNode implements IBlockchainNode {
    readonly name: string = 'Unnamed Node';
    readonly index: number;
    readonly url: string;
    readonly executeLayerHttpRpcUrl?: string;
    readonly consensusLayerRpcUrl?: string;
    readonly consensusLayerHttpRestApiUrl?: string;
    readonly controlPlaneRpcUrl?: string;
    readonly infoApiUrl?: string;
    readonly healthApiUrl?: string;
    readonly type: NodeType;
    private _active: boolean;
    votingPower: number | undefined; // Mutable: validator voting power may be dynamically adjusted
    // Ports can be: number (exposed), null (explicitly not exposed), undefined uses default
    readonly executeLayerHttpRpcPort: number | null;
    readonly consensusLayerHttpRestApiPort: number | null;
    readonly consensusLayerRpcPort: number | null;
    readonly consensusLayerP2pCommPort: number | null;
    readonly blockchain: IBaseBlockchain;
    private executeLayerClient: IExecuteLayerClient | null = null;
    private consensusLayerClient: IConsensusLayerClient | null = null;

    constructor(nodeConfig: IBlockchainNode, blockchainConfig: IBaseBlockchain) {
        this.name = nodeConfig.type + '-' + nodeConfig.index.toString();
        this.index = nodeConfig.index;
        this.url = nodeConfig.url;
        this.executeLayerHttpRpcUrl = nodeConfig.executeLayerHttpRpcUrl;
        this.consensusLayerRpcUrl = nodeConfig.consensusLayerRpcUrl;
        this.consensusLayerHttpRestApiUrl = nodeConfig.consensusLayerHttpRestApiUrl;
        this.controlPlaneRpcUrl = nodeConfig.controlPlaneRpcUrl;
        this.infoApiUrl = nodeConfig.infoApiUrl;
        this.healthApiUrl = nodeConfig.healthApiUrl;
        this.type = nodeConfig.type;
        this._active = nodeConfig.active;
        this.votingPower = nodeConfig.votingPower ?? 0;
        // Preserve null values (explicitly not exposed), only use default if undefined
        this.executeLayerHttpRpcPort =
            nodeConfig.executeLayerHttpRpcPort !== undefined
                ? nodeConfig.executeLayerHttpRpcPort
                : DEFAULT_PORTS.EXECUTE_LAYER_HTTP_RPC;
        this.consensusLayerHttpRestApiPort =
            nodeConfig.consensusLayerHttpRestApiPort !== undefined
                ? nodeConfig.consensusLayerHttpRestApiPort
                : DEFAULT_PORTS.CONSENSUS_LAYER_HTTP_REST_API;
        this.consensusLayerRpcPort =
            nodeConfig.consensusLayerRpcPort !== undefined
                ? nodeConfig.consensusLayerRpcPort
                : DEFAULT_PORTS.CONSENSUS_LAYER_RPC;
        this.consensusLayerP2pCommPort =
            nodeConfig.consensusLayerP2pCommPort !== undefined
                ? nodeConfig.consensusLayerP2pCommPort
                : DEFAULT_PORTS.CONSENSUS_LAYER_P2P_COMM;

        this.blockchain = blockchainConfig;

        if (this._active) {
            // Create clients when a full URL override exists, or when legacy ports are exposed
            if (this.hasExecuteLayerRpcEndpoint()) {
                this.executeLayerClient = BlockchainFactory.createExecuteLayerClientFromNode(this);
            }
            if (this.hasConsensusRpcAndRestEndpoints()) {
                this.consensusLayerClient = BlockchainFactory.createConsensusLayerClientFromNode(this);
            }
        }
    }

    /**
     * Get node active status
     */
    get active(): boolean {
        return this._active;
    }

    /**
     * Set node active status
     * When node status changes, may need to reinitialize or cleanup client connections
     */
    set active(value: boolean) {
        if (this._active === value) {
            return; // Status unchanged, return directly
        }

        this._active = value;

        if (value && !this.executeLayerClient) {
            // Node activated but client not initialized, need to initialize client
            this.initializeClients();
        } else if (!value) {
            // Node deactivated, can optionally cleanup client connections (optional)
            this.cleanupClients();
        }
    }

    /**
     * Initialize client connections
     * Only creates clients if their ports are exposed (not null)
     */
    private initializeClients(): void {
        if (this.hasExecuteLayerRpcEndpoint()) {
            this.executeLayerClient = BlockchainFactory.createExecuteLayerClientFromNode(this);
        }
        if (this.hasConsensusRpcAndRestEndpoints()) {
            this.consensusLayerClient = BlockchainFactory.createConsensusLayerClientFromNode(this);
        }
    }

    private hasExecuteLayerRpcEndpoint(): boolean {
        return Boolean(this.executeLayerHttpRpcUrl) || this.executeLayerHttpRpcPort !== null;
    }

    private hasConsensusRpcAndRestEndpoints(): boolean {
        const hasFullRpcUrl = Boolean(this.consensusLayerRpcUrl);
        const hasFullRestUrl = Boolean(this.consensusLayerHttpRestApiUrl);
        return (
            (hasFullRpcUrl && hasFullRestUrl) ||
            (this.consensusLayerRpcPort !== null && this.consensusLayerHttpRestApiPort !== null)
        );
    }

    /**
     * Cleanup client connections
     */
    async cleanup(): Promise<void> {
        try {
            // Disconnect execute layer client connection
            if (this.executeLayerClient) {
                await this.executeLayerClient.disconnect();
                this.executeLayerClient = null;
            }
        } catch (error) {
            console.warn(
                `Error disconnecting execute layer client for node ${this.index}:`,
                error instanceof Error ? error.message : String(error)
            );
        }

        try {
            // Disconnect consensus layer client connection
            if (this.consensusLayerClient) {
                await this.consensusLayerClient.disconnect();
                this.consensusLayerClient = null;
            }
        } catch (error) {
            console.warn(
                `Error disconnecting consensus layer client for node ${this.index}:`,
                error instanceof Error ? error.message : String(error)
            );
        }

        console.log(`Node ${this.index} cleanup completed`);
    }

    /**
     * Cleanup client connections (private method for internal use)
     */
    private cleanupClients(): void {
        // Synchronous version of cleanup, only set to null
        this.executeLayerClient = null;
        this.consensusLayerClient = null;
    }

    /**
     * Test node connectivity
     * Tries execute layer client first, then consensus layer client, then REST API as fallback.
     * @param timeout Timeout in milliseconds, if not provided uses timeout from blockchain config, defaults to 30000ms if neither exists
     */
    async testConnection(timeout?: number): Promise<boolean> {
        // Determine timeout: parameter > blockchain config > default value 30000
        const finalTimeout = timeout ?? this.blockchain.timeout ?? 30000;

        // Try execute layer client first (if available)
        if (this.executeLayerClient) {
            try {
                const connectionPromise = this.executeLayerClient.isConnected();
                const timeoutPromise = new Promise<boolean>((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`Connection test timed out after ${finalTimeout}ms`));
                    }, finalTimeout);
                });

                return await Promise.race([connectionPromise, timeoutPromise]);
            } catch {
                return false;
            }
        }

        // Try consensus layer client as fallback (if available)
        if (this.consensusLayerClient) {
            try {
                const connectionPromise = this.consensusLayerClient.isConnected();
                const timeoutPromise = new Promise<boolean>((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`Connection test timed out after ${finalTimeout}ms`));
                    }, finalTimeout);
                });

                return await Promise.race([connectionPromise, timeoutPromise]);
            } catch {
                return false;
            }
        }

        // Try REST API as final fallback (for bootnodes with only REST API)
        if (this.consensusLayerHttpRestApiPort !== null) {
            try {
                const restUrl = this.getConsensusLayerRestUrl();
                const connectionPromise = this.testRestApiConnection(restUrl);
                const timeoutPromise = new Promise<boolean>((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`REST API connection test timed out after ${finalTimeout}ms`));
                    }, finalTimeout);
                });

                return await Promise.race([connectionPromise, timeoutPromise]);
            } catch {
                return false;
            }
        }

        // No client available - node has no testable endpoints
        throw new Error('No RPC client initialized (neither execute layer, consensus layer, nor REST API)');
    }

    /**
     * Test REST API connectivity by calling node_info endpoint
     * @param restUrl The REST API base URL
     */
    private async testRestApiConnection(restUrl: string): Promise<boolean> {
        try {
            const response = await fetch(`${restUrl}/cosmos/base/tendermint/v1beta1/node_info`);
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Send transaction
     * @param request Transaction request
     * @param privateKey Private key
     */
    async sendTransaction(request: TransactionRequest, privateKey: string): Promise<TransactionResult> {
        if (!this.executeLayerClient) {
            throw new Error('Execute layer client not initialized');
        }

        return await this.executeLayerClient.sendTransaction(request, privateKey);
    }

    /**
     * Get block height
     */
    async getBlockHeight(): Promise<number> {
        if (this.consensusLayerClient) {
            return await this.consensusLayerClient.getBlockHeight();
        }

        if (this.executeLayerClient) {
            return await this.executeLayerClient.getBlockHeight();
        }

        throw new Error('Neither consensus layer client nor execute layer client is initialized');
    }

    /**
     * Get the base URL (without port) from the node URL
     */
    private getBaseUrl(): string {
        const urlPattern = /^(https?:\/\/[^:/]+)(:\d+)?(.*)$/;
        const match = this.url.match(urlPattern);
        return match ? match[1] : this.url;
    }

    /**
     * Get execute layer RPC URL (base url + port)
     * @throws Error if executeLayerHttpRpcPort is null (not exposed)
     */
    getExecuteLayerRpcUrl(): string {
        if (this.executeLayerHttpRpcUrl) {
            return this.executeLayerHttpRpcUrl;
        }
        if (this.executeLayerHttpRpcPort === null) {
            throw new Error(`Execute layer RPC port is not exposed on node ${this.name}`);
        }
        return `${this.getBaseUrl()}:${this.executeLayerHttpRpcPort}`;
    }

    /**
     * Get consensus layer RPC URL (base url + port)
     * @throws Error if consensusLayerRpcPort is null (not exposed)
     */
    getConsensusLayerRpcUrl(): string {
        if (this.consensusLayerRpcUrl) {
            return this.consensusLayerRpcUrl;
        }
        if (this.consensusLayerRpcPort === null) {
            throw new Error(`Consensus layer RPC port is not exposed on node ${this.name}`);
        }
        return `${this.getBaseUrl()}:${this.consensusLayerRpcPort}`;
    }

    /**
     * Get consensus layer REST API URL (base url + port)
     * @throws Error if consensusLayerHttpRestApiPort is null (not exposed)
     */
    getConsensusLayerRestUrl(): string {
        if (this.consensusLayerHttpRestApiUrl) {
            return this.consensusLayerHttpRestApiUrl;
        }
        if (this.consensusLayerHttpRestApiPort === null) {
            throw new Error(`Consensus layer REST API port is not exposed on node ${this.name}`);
        }
        return `${this.getBaseUrl()}:${this.consensusLayerHttpRestApiPort}`;
    }

    /**
     * Get network configuration
     */
    getNetworkConfig(): INetworkConfig {
        return {
            url: this.url,
            consensusLayerRpcUrl: this.consensusLayerRpcUrl,
            consensusLayerHttpRestApiUrl: this.consensusLayerHttpRestApiUrl,
            executeLayerHttpRpcUrl: this.executeLayerHttpRpcUrl,
            consensusLayerRpcPort: this.consensusLayerRpcPort,
            executeLayerHttpRpcPort: this.executeLayerHttpRpcPort,
            consensusLayerHttpRestApiPort: this.consensusLayerHttpRestApiPort,
        };
    }

    /**
     * Get client configuration
     */
    getClientConfig(): IClientConfig {
        return {
            name: this.blockchain.name,
            timeout: this.blockchain.timeout,
            nativeToken: this.blockchain.nativeToken,
            addressPrefix: this.blockchain.addressPrefix,
        };
    }

    /**
     * Get execute layer client
     * @returns Execute layer client instance
     */
    getExecuteLayerClient(): IExecuteLayerClient | null {
        return this.executeLayerClient;
    }

    /**
     * Get consensus layer client
     * @returns Consensus layer client instance
     */
    getConsensusLayerClient(): IConsensusLayerClient | null {
        return this.consensusLayerClient;
    }

    getClient(type: BlockchainType): IExecuteLayerClient | IConsensusLayerClient {
        if (type === this.blockchain.executeLayer) {
            if (!this.executeLayerClient) {
                throw new Error(`Execute layer client not initialized`);
            }
            return this.executeLayerClient;
        } else if (type === this.blockchain.consensusLayer) {
            if (!this.consensusLayerClient) {
                throw new Error(`Consensus layer client not initialized`);
            }
            return this.consensusLayerClient;
        }

        throw new Error(`Client for type ${type} not available`);
    }

    /**
     * Check node connection status
     * Uses the client's isConnected() method to replace deprecated isRpcConnected
     */
    async checkConnectivity(): Promise<{ evmConnected: boolean; consensusConnected: boolean }> {
        let evmConnected = false;
        let consensusConnected = false;

        try {
            if (this.executeLayerClient) {
                evmConnected = await this.executeLayerClient.isConnected();
            }
        } catch (error) {
            console.warn(`EVM connectivity check failed for node ${this.index}:`, error);
        }

        try {
            if (this.consensusLayerClient) {
                consensusConnected = await this.consensusLayerClient.isConnected();
            }
        } catch (error) {
            console.warn(`Consensus connectivity check failed for node ${this.index}:`, error);
        }

        return { evmConnected, consensusConnected };
    }

    /**
     * Execute RPC request and return response
     * Uses executeLayerClient's makeRpcCall method
     */
    async makeRpcRequest(request: any): Promise<{ response: any; error?: Error }> {
        try {
            if (!this.executeLayerClient) {
                throw new Error('Execute layer client not initialized');
            }
            const response = await (this.executeLayerClient as any).makeRpcCall(request);
            return { response };
        } catch (error) {
            return { response: null, error: error as Error };
        }
    }
}
