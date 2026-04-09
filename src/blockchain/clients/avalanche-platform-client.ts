import axios from 'axios';
import { IClientConfig, IControlPlaneClient, NetworkInfo, ValidatorInfo } from '../types';

interface AvalanchePlatformClientOptions {
    rpcEndpoint?: string;
    infoEndpoint?: string;
    healthEndpoint?: string;
}

export class AvalanchePlatformClient implements IControlPlaneClient {
    readonly config: IClientConfig;
    readonly rpcEndpoint?: string;
    readonly infoEndpoint?: string;
    readonly healthEndpoint?: string;

    constructor(config: IClientConfig, options: AvalanchePlatformClientOptions) {
        this.config = config;
        this.rpcEndpoint = options.rpcEndpoint;
        this.infoEndpoint = options.infoEndpoint;
        this.healthEndpoint = options.healthEndpoint;
    }

    async connect(): Promise<void> {
        // No persistent connection needed.
    }

    async disconnect(): Promise<void> {
        // No persistent connection needed.
    }

    async isConnected(): Promise<boolean> {
        try {
            if (this.healthEndpoint) {
                const health = await this.getHealth();
                return Boolean(health?.healthy);
            }

            if (this.infoEndpoint) {
                await this.callInfo('info.getNodeID');
                return true;
            }

            if (this.rpcEndpoint) {
                await this.callPlatform('platform.getHeight');
                return true;
            }

            return false;
        } catch {
            return false;
        }
    }

    async getNetworkInfo(): Promise<NetworkInfo> {
        const [networkIdResponse, networkNameResponse] = await Promise.all([
            this.callInfo('info.getNetworkID'),
            this.callInfo('info.getNetworkName'),
        ]);

        let blockHeight = 0;
        try {
            const heightResponse = await this.callPlatform('platform.getHeight');
            blockHeight = parseInt(String(heightResponse.height), 10);
        } catch {
            blockHeight = 0;
        }

        return {
            chainId: String(networkIdResponse.networkID),
            blockHeight,
            networkName: String(networkNameResponse.networkName ?? this.config.name),
        };
    }

    async getValidators(subnetId?: string): Promise<ValidatorInfo[]> {
        const response = await this.getCurrentValidators(subnetId);
        return response.map((validator: any) => ({
            address: validator.nodeID ?? validator.validationID ?? 'unknown',
            moniker: validator.nodeID ?? validator.validationID,
            votingPower: String(validator.weight ?? validator.stakeAmount ?? '0'),
            status: 'active',
        }));
    }

    async getHealth(): Promise<any> {
        if (!this.healthEndpoint) {
            throw new Error('Health endpoint is not configured');
        }

        const response = await axios.get(this.healthEndpoint, {
            timeout: 30000,
        });
        return response.data;
    }

    async getNodeID(): Promise<string> {
        const response = await this.callInfo('info.getNodeID');
        return String(response.nodeID);
    }

    async getPlatformHeight(): Promise<number> {
        const response = await this.callPlatform('platform.getHeight');
        return parseInt(String(response.height), 10);
    }

    async getCurrentValidators(subnetId?: string): Promise<any[]> {
        const params = subnetId ? { subnetID: subnetId } : {};
        const response = await this.callPlatform('platform.getCurrentValidators', params);
        return response.validators ?? [];
    }

    async getBalance(addresses: string[]): Promise<{
        balance: bigint;
        unlocked: bigint;
        lockedStakeable: bigint;
        lockedNotStakeable: bigint;
        utxoIDs: any[];
    }> {
        const response = await this.callPlatform('platform.getBalance', { addresses });
        return {
            balance: BigInt(response.balance ?? 0),
            unlocked: BigInt(response.unlocked ?? 0),
            lockedStakeable: BigInt(response.lockedStakeable ?? 0),
            lockedNotStakeable: BigInt(response.lockedNotStakeable ?? 0),
            utxoIDs: response.utxoIDs ?? [],
        };
    }

    async getBlockchains(): Promise<any[]> {
        const response = await this.callPlatform('platform.getBlockchains');
        return response.blockchains ?? [];
    }

    async getBlockchain(blockchainId: string): Promise<any | null> {
        const blockchains = await this.getBlockchains();
        return blockchains.find((blockchain: any) => blockchain.id === blockchainId) ?? null;
    }

    async getL1Status(
        blockchainId: string,
        subnetId?: string
    ): Promise<{
        exists: boolean;
        healthy: boolean;
        bootstrapped: boolean;
        validatorCount: number;
    }> {
        const [blockchain, health, validators] = await Promise.all([
            this.getBlockchain(blockchainId),
            this.getHealth(),
            this.getCurrentValidators(subnetId),
        ]);

        const bootstrappedCheck = health?.checks?.bootstrapped;
        const bootstrapped = Array.isArray(bootstrappedCheck?.message);

        return {
            exists: Boolean(blockchain),
            healthy: Boolean(health?.healthy),
            bootstrapped,
            validatorCount: validators.length,
        };
    }

    private async callPlatform(method: string, params: Record<string, any> = {}): Promise<any> {
        if (!this.rpcEndpoint) {
            throw new Error('Platform RPC endpoint is not configured');
        }
        return this.postJsonRpc(this.rpcEndpoint, method, params);
    }

    private async callInfo(method: string, params: Record<string, any> = {}): Promise<any> {
        if (!this.infoEndpoint) {
            throw new Error('Info endpoint is not configured');
        }
        return this.postJsonRpc(this.infoEndpoint, method, params);
    }

    private async postJsonRpc(endpoint: string, method: string, params: Record<string, any>): Promise<any> {
        const response = await axios.post(
            endpoint,
            {
                jsonrpc: '2.0',
                id: 1,
                method,
                params,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
            }
        );

        if (response.data?.error) {
            throw new Error(
                `Avalanche RPC error [${method}]: ${response.data.error.message ?? JSON.stringify(response.data.error)}`
            );
        }

        return response.data?.result ?? {};
    }
}
