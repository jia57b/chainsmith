import {
    IConsensusLayerClient,
    IClientConfig,
    NetworkInfo,
    BlockInfo,
    ValidatorInfo,
    TransactionResult,
} from '../types';
import axios from 'axios';

// Base paths for Cosmos SDK REST API (without prefix and version)
// Different chains may require different prefixes and versions:
// - evmos: prefix='/cosmos', version='v1beta1' → /cosmos/staking/v1beta1/validators
// - story: prefix='', version='' → /staking/validators
// Version is inserted dynamically by buildRestPath based on config
export const COSMOS_API_PATHS = {
    // Staking Module
    STAKING_VALIDATORS: '/staking/validators',
    STAKING_PARAMS: '/staking/params',
    STAKING_POOL: '/staking/pool',
    STAKING_DELEGATIONS: '/staking/delegations', // + /{delegator_addr}
    STAKING_VALIDATOR: '/staking/validators', // + /{validator_addr}
    STAKING_VALIDATOR_DELEGATIONS: '/staking/validators', // + /{validator_addr}/delegations
    STAKING_UNBONDING_DELEGATIONS: '/staking/delegators', // + /{delegator_addr}/unbonding_delegations
    STAKING_REDELEGATIONS: '/staking/delegators', // + /{delegator_addr}/redelegations
    STAKING_DELEGATOR_VALIDATORS: '/staking/delegators', // + /{delegator_addr}/validators

    // Slashing Module
    SLASHING_SIGNING_INFOS: '/slashing/signing_infos',
    SLASHING_PARAMS: '/slashing/params',

    // Mint Module
    MINT_PARAMS: '/mint/params',

    // Tendermint RPC - always available (no prefix needed)
    TENDERMINT_STATUS: '/status',
    TENDERMINT_BLOCK: '/block',
    TENDERMINT_VALIDATORS: '/validators',

    // Node Info
    NODE_INFO: '/base/tendermint/node_info',
};
export class CosmosConsensusClient implements IConsensusLayerClient {
    readonly config: IClientConfig;
    readonly restEndpoint: string;
    readonly rpcEndpoint: string;
    readonly pathPrefix: string;
    readonly apiVersion: string;

    constructor(
        config: IClientConfig,
        restEndpoint: string,
        rpcEndpoint?: string,
        pathPrefix?: string,
        apiVersion?: string
    ) {
        this.config = config;
        this.restEndpoint = restEndpoint;
        // RPC endpoint is typically on port 26657, while REST is on 1317
        // If RPC endpoint is not explicitly specified, derive it from the REST endpoint
        this.rpcEndpoint = rpcEndpoint ?? '';
        // Path prefix for REST API (e.g., '/cosmos' for evmos, '' for story)
        this.pathPrefix = pathPrefix ?? '';
        // API version for REST paths (e.g., 'v1beta1' for standard Cosmos SDK, '' for simplified)
        this.apiVersion = apiVersion ?? '';
    }

    /**
     * Build full REST API path with prefix and version
     * @param basePath Base path from COSMOS_API_PATHS (e.g., '/staking/validators')
     * @returns Full path with prefix and version applied
     *
     * Examples:
     * - story (prefix='', version=''): /staking/validators
     * - evmos (prefix='/cosmos', version='v1beta1'): /cosmos/staking/v1beta1/validators
     */
    private buildRestPath(basePath: string): string {
        if (!this.apiVersion) {
            return `${this.pathPrefix}${basePath}`;
        }
        // Insert version after module name: /staking/validators -> /staking/v1beta1/validators
        const parts = basePath.split('/').filter(p => p); // ['staking', 'validators']
        if (parts.length >= 2) {
            parts.splice(1, 0, this.apiVersion); // ['staking', 'v1beta1', 'validators']
        }
        return `${this.pathPrefix}/${parts.join('/')}`;
    }

    // Private method: send RPC request to consensus layer
    private async makeRpcRequestPrivate(path: string, params: any = {}): Promise<any> {
        try {
            const url = `${this.rpcEndpoint}${path}`;
            const response = await axios.get(url, {
                params: params,
                timeout: 60000,
            });
            return response.data;
        } catch (error: any) {
            console.log(`CosmosConsensusClient RPC error for ${this.rpcEndpoint}${path}:`, {
                code: error.code,
                message: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
            });

            if (error.code === 'ECONNREFUSED') {
                throw new Error(`Connection refused to ${this.rpcEndpoint}`);
            }
            // Include response data in error message for better error handling
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- falsy error data should be treated as empty
            const errorData = error.response?.data?.error?.data || '';
            const errorMsg = errorData
                ? `Consensus RPC request failed: ${error.message} - ${errorData}`
                : `Consensus RPC request failed: ${error.message}`;
            throw new Error(errorMsg);
        }
    }

    // Public method: for Blockchain class to call
    async makeRpcRequest(path: string, params: any = {}): Promise<any> {
        return this.makeRpcRequestPrivate(path, params);
    }

    // Private method: send REST API request
    private async makeRestRequest(path: string): Promise<any> {
        try {
            const url = `${this.restEndpoint}${path}`;
            const response = await axios.get(url, {
                timeout: 60000,
            });
            return response.data;
        } catch (error: any) {
            console.log(`CosmosConsensusClient REST error for ${this.restEndpoint}${path}:`, {
                code: error.code,
                message: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
            });

            if (error.code === 'ECONNREFUSED') {
                throw new Error(`Connection refused to ${this.restEndpoint}`);
            }
            throw new Error(`Consensus REST request failed: ${error.message}`);
        }
    }

    // Connection management
    async isConnected(): Promise<boolean> {
        try {
            // Use a simple RPC call to test the connection
            await this.makeRpcRequestPrivate('/health', {});
            return true;
        } catch {
            return false;
        }
    }

    async connect(): Promise<void> {
        // Initialization work can be done here
    }

    async disconnect(): Promise<void> {
        // Cleanup work can be done here
    }

    // Network and consensus information
    async getNetworkInfo(): Promise<NetworkInfo> {
        const statusResponse = await this.makeRpcRequestPrivate('/status', {});

        return {
            chainId: statusResponse.result.node_info.network,
            blockHeight: parseInt(statusResponse.result.sync_info.latest_block_height),
            networkName: statusResponse.result.node_info.moniker,
            consensusVersion: statusResponse.result.node_info.version,
            validators: [], // Validator information can be obtained through additional calls
        };
    }

    async getBlockHeight(): Promise<number> {
        const response = await this.makeRpcRequestPrivate('/status', {});
        return parseInt(response.result.sync_info.latest_block_height);
    }

    async getBlock(height?: number): Promise<BlockInfo> {
        const query = height ? { height: height.toString() } : {};
        const response = await this.makeRpcRequestPrivate('/block', query);
        const block = response.result.block;

        return {
            hash: block.header.last_block_id.hash,
            number: parseInt(block.header.height),
            parentHash: block.header.last_block_id.hash,
            timestamp: new Date(block.header.time).getTime(),
            proposer: block.header.proposer_address,
            transactions: block.data.txs ?? [],
        };
    }

    async getValidators(): Promise<ValidatorInfo[]> {
        const response = await this.makeRpcRequestPrivate('/validators', {});
        const validators = response.result.validators;

        return validators.map((validator: any) => ({
            address: validator.address,
            moniker: validator.description?.moniker ?? 'Unknown',
            votingPower: validator.voting_power,
            status: validator.jailed ? 'jailed' : 'active',
            commission: validator.commission?.rate ?? '0',
        }));
    }

    // Transaction queries via consensus layer RPC (Cosmos architecture)
    async getTransaction(hash: string): Promise<TransactionResult | null> {
        try {
            // Use CosmosConsensusClient's own RPC endpoint to query transactions, ensuring the correct consensus layer RPC endpoint is used
            const response = await this.makeRpcRequestPrivate(`/tx?hash=0x${hash}`, {});

            if (response.result) {
                return {
                    hash: response.result.hash,
                    status: response.result.tx_result?.code === 0 ? 'success' : 'failed',
                    blockNumber: parseInt(response.result.height),
                    timestamp: new Date(response.result.timestamp).getTime(),
                    gasUsed: response.result.tx_result?.gas_used,
                    fee: response.result.tx_result?.fee,
                };
            }
            return null;
        } catch (error: any) {
            console.warn(`Failed to get transaction ${hash}:`, error.message);
            return null;
        }
    }

    // Staking Module APIs - support custom paths
    async getStakingValidators(customPath?: string): Promise<any> {
        const path = customPath ?? this.buildRestPath(COSMOS_API_PATHS.STAKING_VALIDATORS);
        return await this.makeRestRequest(path);
    }

    async getStakingParams(customPath?: string): Promise<any> {
        const path = customPath ?? this.buildRestPath(COSMOS_API_PATHS.STAKING_PARAMS);
        return await this.makeRestRequest(path);
    }

    async getStakingPool(customPath?: string): Promise<any> {
        const path = customPath ?? this.buildRestPath(COSMOS_API_PATHS.STAKING_POOL);
        return await this.makeRestRequest(path);
    }

    async getStakingValidator(validatorAddr: string, customPath?: string): Promise<any> {
        const path = customPath ?? `${this.buildRestPath(COSMOS_API_PATHS.STAKING_VALIDATOR)}/${validatorAddr}`;
        return await this.makeRestRequest(path);
    }

    async getValidatorDelegations(validatorAddr: string, customPath?: string): Promise<any> {
        const path =
            customPath ??
            `${this.buildRestPath(COSMOS_API_PATHS.STAKING_VALIDATOR_DELEGATIONS)}/${validatorAddr}/delegations`;
        return await this.makeRestRequest(path);
    }

    async getDelegatorDelegations(delegatorAddr: string, customPath?: string): Promise<any> {
        const path = customPath ?? `${this.buildRestPath(COSMOS_API_PATHS.STAKING_DELEGATIONS)}/${delegatorAddr}`;
        return await this.makeRestRequest(path);
    }

    async getDelegatorUnbondingDelegations(delegatorAddr: string, customPath?: string): Promise<any> {
        const basePath = this.buildRestPath(COSMOS_API_PATHS.STAKING_UNBONDING_DELEGATIONS);
        const path = customPath ?? `${basePath}/${delegatorAddr}/unbonding_delegations`;
        return await this.makeRestRequest(path);
    }

    async getDelegatorRedelegations(delegatorAddr: string, customPath?: string): Promise<any> {
        const basePath = this.buildRestPath(COSMOS_API_PATHS.STAKING_REDELEGATIONS);
        const path = customPath ?? `${basePath}/${delegatorAddr}/redelegations`;
        return await this.makeRestRequest(path);
    }

    async getDelegatorValidators(delegatorAddr: string, customPath?: string): Promise<any> {
        const basePath = this.buildRestPath(COSMOS_API_PATHS.STAKING_DELEGATOR_VALIDATORS);
        const path = customPath ?? `${basePath}/${delegatorAddr}/validators`;
        return await this.makeRestRequest(path);
    }

    // Slashing Module APIs - support custom paths
    async getSlashingParams(customPath?: string): Promise<any> {
        const path = customPath ?? this.buildRestPath(COSMOS_API_PATHS.SLASHING_PARAMS);
        return await this.makeRestRequest(path);
    }

    async getSlashingSigningInfos(customPath?: string): Promise<any> {
        const path = customPath ?? this.buildRestPath(COSMOS_API_PATHS.SLASHING_SIGNING_INFOS);
        return await this.makeRestRequest(path);
    }

    // Mint Module APIs - support custom paths
    async getMintParams(customPath?: string): Promise<any> {
        const path = customPath ?? this.buildRestPath(COSMOS_API_PATHS.MINT_PARAMS);
        return await this.makeRestRequest(path);
    }

    // Node and Chain Information - support custom paths
    async getNodeInfo(customPath?: string): Promise<any> {
        const path = customPath ?? this.buildRestPath(COSMOS_API_PATHS.NODE_INFO);
        return await this.makeRestRequest(path);
    }
}
