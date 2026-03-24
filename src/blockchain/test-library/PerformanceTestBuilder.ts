import { Config } from '../../utils/common';
import { Blockchain } from '../../core/Blockchain';

// Performance Test Builder
export class PerformanceTestBuilder {
    private blockchain: Blockchain;
    private timeTaken: number = 0;

    constructor(blockchain: Blockchain) {
        this.blockchain = blockchain;
    }

    /**
     * Execute token transfer and measure performance
     *
     * This method sends a transaction and measures the time taken
     * for the operation to complete.
     *
     * @returns Promise<PerformanceTestBuilder> for fluent chaining
     */
    async executeTokenTransfer(): Promise<PerformanceTestBuilder> {
        const startTime = Date.now();

        try {
            // Use founder wallet private key for transaction via public endpoint
            const privateKey = this.blockchain.founderWallet?.privateKey ?? Config.founderWalletPrivateKey;
            const founderAddress = this.blockchain.founderWallet?.address ?? '';

            const transaction = await this.blockchain.sendSimpleTransactionViaPublicEndpoint(
                founderAddress,
                '0.1',
                privateKey
            );

            if (!transaction.hash) {
                throw new Error('Transaction hash was not returned');
            }

            const receipt = await this.blockchain.waitForTransaction(transaction.hash);
            if (!receipt || receipt.status !== 1) {
                throw new Error('Transaction was not confirmed on-chain');
            }

            const endTime = Date.now();
            this.timeTaken = endTime - startTime;

            console.log(`Transaction completed in ${this.timeTaken}ms`);
        } catch (error) {
            console.error('Transaction failed:', error);
            throw error;
        }

        return this;
    }

    /**
     * Get the current time taken for the operation
     *
     * @returns number - The time taken in milliseconds
     */
    getTimeTaken(): number {
        return this.timeTaken;
    }
}
