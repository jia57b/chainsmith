/**
 * EVM Execute Layer Client - Handles transaction execution and account operations
 * Encapsulates RPC calls internally, not exposing the RPC layer externally
 */

import {
    IExecuteLayerClient,
    IClientConfig,
    TransactionRequest,
    TransactionResult,
    AccountInfo,
    BlockInfo,
    NetworkInfo,
    Request,
    Response,
} from '../types';
import { ethers } from 'ethers';
import axios from 'axios';
import { validateSchema, formatValidationErrors } from '../../utils/schema-validator';

export class EVMExecuteClient implements IExecuteLayerClient {
    readonly config: IClientConfig;
    private rpcEndpoint: string;
    private provider: ethers.JsonRpcProvider;

    constructor(config: IClientConfig, rpcEndpoint: string) {
        this.config = config;
        this.rpcEndpoint = rpcEndpoint;
        this.provider = new ethers.JsonRpcProvider(rpcEndpoint);
    }
    getProvider() {
        return this.provider;
    }

    // Private method: Send RPC request to execution layer (EVM)
    private async makeRpcRequest(request: Request): Promise<Response> {
        try {
            const response = await axios.post(this.rpcEndpoint, request, {
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 60000,
            });
            return response.data;
        } catch (error: any) {
            console.log(`EVMExecuteClient RPC error for ${this.rpcEndpoint}:`, {
                code: error.code,
                message: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
            });

            if (error.code === 'ECONNREFUSED') {
                throw new Error(`Connection refused to ${this.rpcEndpoint}`);
            }
            throw new Error(`EVM RPC request failed: ${error.message}`);
        }
    }

    // Connection management
    async isConnected(): Promise<boolean> {
        try {
            // Use a simple RPC call to test the connection
            const request: Request = {
                jsonrpc: '2.0',
                method: 'net_version',
                params: [],
                id: 1,
            };
            await this.makeRpcRequest(request);
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

    // Account operations
    async getAccount(address: string): Promise<AccountInfo> {
        const balanceRequest: Request = {
            jsonrpc: '2.0',
            method: 'eth_getBalance',
            params: [address, 'latest'],
            id: 1,
        };

        const nonceRequest: Request = {
            jsonrpc: '2.0',
            method: 'eth_getTransactionCount',
            params: [address, 'latest'],
            id: 2,
        };

        const balanceResponse = await this.makeRpcRequest(balanceRequest);
        const nonceResponse = await this.makeRpcRequest(nonceRequest);

        return {
            address,
            balance: parseInt(balanceResponse.result, 16).toString(),
            nonce: parseInt(nonceResponse.result, 16),
        };
    }

    createAccount(_privateKey?: string): Promise<{ address: string; privateKey: string }> {
        // Account creation logic can be implemented here
        // Throwing an error for now as it requires specific implementation
        throw new Error('Account creation not implemented in EVMExecuteClient');
    }

    // Transaction operations
    async sendTransaction(request: TransactionRequest, privateKey: string): Promise<TransactionResult> {
        const { ethers } = await import('ethers');

        // Create provider and wallet
        const provider = new ethers.JsonRpcProvider(this.rpcEndpoint);
        const wallet = new ethers.Wallet(privateKey, provider);

        // Get nonce and gas price from the network
        const nonce = await provider.getTransactionCount(wallet.address, 'pending');
        const feeData = await provider.getFeeData();

        // Build transaction
        const tx: ethers.TransactionRequest = {
            to: request.to,
            value: request.amount ? BigInt(request.amount) : 0n,
            data: request.data ?? '0x',
            nonce: nonce,
            gasLimit: request.gasLimit ? BigInt(request.gasLimit) : 21000n,
        };

        // Set gas pricing (prefer EIP-1559 if available)
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            tx.maxFeePerGas = feeData.maxFeePerGas;
            tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
        } else {
            tx.gasPrice = request.gasPrice ? BigInt(request.gasPrice) : feeData.gasPrice;
        }

        // Send transaction using ethers (handles signing and sending)
        const txResponse = await wallet.sendTransaction(tx);

        return {
            hash: txResponse.hash,
            status: 'pending',
            gasUsed: '0',
            blockNumber: 0,
        };
    }

    async getTransaction(hash: string): Promise<TransactionResult | null> {
        const rpcRequest: Request = {
            jsonrpc: '2.0',
            method: 'eth_getTransactionByHash',
            params: [hash],
            id: 1,
        };

        const response = await this.makeRpcRequest(rpcRequest);
        const tx = response.result;

        if (!tx) {
            return null;
        }

        return {
            hash: tx.hash,
            status: tx.blockNumber ? 'success' : 'pending',
            gasUsed: tx.gas ?? '0',
            blockNumber: tx.blockNumber ? parseInt(tx.blockNumber, 16) : 0,
        };
    }

    async waitForTransaction(hash: string, confirmations: number = 1): Promise<TransactionResult> {
        // Wait for transaction confirmation logic
        let attempts = 0;
        const maxAttempts = 60; // Maximum 60 attempts, 1 second each

        while (attempts < maxAttempts) {
            const tx = await this.getTransaction(hash);
            if (tx?.status === 'success' && tx.blockNumber && tx.blockNumber > 0) {
                // Check confirmation count
                const blockRequest: Request = {
                    jsonrpc: '2.0',
                    method: 'eth_blockNumber',
                    params: [],
                    id: 1,
                };

                const blockResponse = await this.makeRpcRequest(blockRequest);
                const currentBlockNumber = parseInt(blockResponse.result, 16);
                const confirmationCount = currentBlockNumber - tx.blockNumber + 1;

                if (confirmationCount >= confirmations) {
                    return tx;
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }

        throw new Error(`Transaction ${hash} not confirmed after ${maxAttempts} attempts`);
    }

    async estimateGas(request: TransactionRequest): Promise<string> {
        const rpcRequest: Request = {
            jsonrpc: '2.0',
            method: 'eth_estimateGas',
            params: [
                {
                    to: request.to,
                    value: request.amount ? `0x${BigInt(request.amount).toString(16)}` : undefined,
                    data: request.data ?? undefined,
                },
            ],
            id: 1,
        };

        const response = await this.makeRpcRequest(rpcRequest);
        return parseInt(response.result, 16).toString();
    }

    // Block information - execution layer perspective (via provider)
    async getBlockHeight(): Promise<number> {
        const request: Request = {
            jsonrpc: '2.0',
            method: 'eth_blockNumber',
            params: [],
            id: 1,
        };

        const response = await this.makeRpcRequest(request);
        return parseInt(response.result, 16);
    }

    async getBlock(height?: number): Promise<BlockInfo> {
        const blockParam = height !== undefined ? `0x${height.toString(16)}` : 'latest';
        const request: Request = {
            jsonrpc: '2.0',
            method: 'eth_getBlockByNumber',
            params: [blockParam, true], // true to include transaction details
            id: 1,
        };

        const response = await this.makeRpcRequest(request);
        const block = response.result;

        if (!block) {
            throw new Error(`Block not found: ${height}`);
        }

        return {
            number: parseInt(block.number, 16),
            hash: block.hash ?? '',
            parentHash: block.parentHash ?? '',
            timestamp: parseInt(block.timestamp, 16),
            transactions: block.transactions.map((tx: any) => tx.hash ?? tx),
            gasLimit: parseInt(block.gasLimit, 16).toString(),
            gasUsed: block.gasUsed ? parseInt(block.gasUsed, 16).toString() : undefined,
        };
    }

    // Utility methods
    isValidAddress(address: string): boolean {
        return /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    formatAmount(amount: string): string {
        return (BigInt(amount) / BigInt(10 ** 18)).toString();
    }

    parseAmount(amount: string): string {
        return (BigInt(amount) * BigInt(10 ** 18)).toString();
    }

    async getNetworkInfo(): Promise<NetworkInfo> {
        try {
            const network = await this.provider.getNetwork();
            const blockHeight = await this.provider.getBlockNumber();

            return {
                chainId: network.chainId.toString(),
                blockHeight,
                networkName: network.name && network.name.toLowerCase() !== 'unknown' ? network.name : this.config.name,
            };
        } catch {
            throw new Error('Failed to get network info');
        }
    }

    /**
     * Public RPC call method for test compatibility.
     * Validates request params and response result against JSON Schemas when provided.
     *
     * - requestSchema validates `request.params`
     * - responseSchema validates `response.result` (the JSON-RPC result payload)
     */
    async makeRpcCall(request: Request, requestSchema?: any, responseSchema?: any): Promise<Response> {
        if (requestSchema && request.params) {
            const validation = validateSchema(request.params, requestSchema);
            if (!validation.valid) {
                console.warn(
                    `⚠️  EVM RPC request schema validation warning [${request.method}]:\n${formatValidationErrors(validation.errors)}`
                );
            }
        }

        const response = await this.makeRpcRequest(request);

        // Validate response.result against the schema unless the RPC returned an error
        const rpcResponse = response as any;
        if (responseSchema && !rpcResponse.error) {
            const validation = validateSchema(rpcResponse.result, responseSchema);
            if (!validation.valid) {
                const resultPreview = JSON.stringify(rpcResponse.result)?.substring(0, 500);
                const errorMsg =
                    `EVM RPC response schema validation failed [${request.method}]:\n` +
                    `${formatValidationErrors(validation.errors)}\n` +
                    `  Actual result: ${resultPreview}`;
                throw new Error(errorMsg);
            }
        }

        return response;
    }
}
