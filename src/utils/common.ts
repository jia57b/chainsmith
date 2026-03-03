import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Common utility functions used across the application
 */

/**
 * Sleep for a specified number of seconds
 * @param second - Number of seconds to sleep
 * @returns Promise that resolves after the specified time
 */
export function sleep(second: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, second * 1000));
}

/**
 * Sleep for a specified number of milliseconds
 * @param ms - Number of milliseconds to sleep
 * @returns Promise that resolves after the specified time
 */
export function sleepMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Remove specific nodes from an endpoint array
 * @param endpointArray - Array of endpoint URLs
 * @param stopNodeArray - Array of node IPs to remove
 * @returns Filtered array with specified nodes removed
 */
export function removeNode(endpointArray: Array<string>, stopNodeArray: Array<string>): Array<string> {
    return endpointArray.filter(endpoint => {
        // Check if the endpoint should be removed
        const match = endpoint.match(/http:\/\/([^:/]+)/);
        const ip = match ? match[1] : endpoint;
        return !stopNodeArray.includes(ip); // Only include endpoints that should not be removed
    });
}

/**
 * Unified configuration for the application
 *
 * Note: Chain-specific configuration (rpcUrl, chainId, nodes) should be obtained
 * from the Blockchain instance, not from this class. Use RuntimeManager to load
 * chain configuration from tests/config.json.
 */
export class Config {
    // ============================================
    // Environment Name
    // ============================================

    /**
     * Get the current target environment name
     * Used to select which environment config to load from config.json
     */
    static get envName(): string {
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string ENV should use fallback
        return process.env.CHAIN_ENV || 'local';
    }

    /**
     * @deprecated Use Config.envName instead
     */
    static get devnetVersion(): string {
        return this.envName;
    }

    // ============================================
    // Sensitive Data (env takes priority over config.json)
    // Priority logic should be handled by Blockchain/RuntimeManager
    // ============================================

    /**
     * Get founder wallet private key from env
     * Caller should check if empty and fallback to config.json
     */
    static get founderWalletPrivateKey(): string {
        return process.env.WALLET_PRIVATE_KEY as string;
    }

    /**
     * Get SSH private key from environment variable
     * @param keyRef - Environment variable name (default: SSH_KEY)
     */
    static getSSHKey(keyRef: string = 'SSH_KEY'): string {
        return process.env[keyRef] as string;
    }

    // ============================================
    // Other Environment Variables
    // ============================================

    static get account(): string {
        return process.env.ACCOUNT_ADDR as string;
    }

    static get contractAddress(): string {
        return process.env.CONTRACT_ADDRESS as string;
    }

    static get topic(): string {
        return process.env.TOPIC as string;
    }

    // Test configuration constants
    static readonly test = {
        // Wait times (in milliseconds)
        waitTime: 5,
        waitTimeForBlock: 10000,
        waitTimeForTx: 20000,
        waitTimeForService: 45000, // Start validator service
        waitTimeForBlockSync: 15000, // Block sync

        // Common RPC requests
        blockNumRequest: {
            jsonrpc: '2.0',
            method: 'eth_blockNumber',
            params: [],
            id: 1,
        },

        // Port configurations
        ports: {
            p2p: 26656,
            rpc: 26657,
            evmRpc: 8545,
        },
    };
}
