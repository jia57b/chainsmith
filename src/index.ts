/**
 * Main entry point for chain-tests utilities
 * Provides a unified interface to all testing utilities
 */

// Common utilities
export * from './utils/common';
export * from './utils/test-helpers';

// RPC types (legacy exports from blockchain/types)

// Blockchain operations
export * from './blockchain/transactions';
export * from './blockchain/types';
export * from './blockchain/factory';

// New client implementations (execute layer / consensus layer separation)
export { EVMExecuteClient } from './blockchain/clients/evm-execute-client';
export { CosmosConsensusClient } from './blockchain/clients/cosmos-consensus-client';
export { AvalanchePlatformClient } from './blockchain/clients/avalanche-platform-client';
// export { AvalanchePoSStakingTestBuilder } from './blockchain/test-library/AvalanchePoSStakingTestBuilder';

// Infrastructure management
export * from './infrastructure/nodes';

// Re-export commonly used items with cleaner names
export { Config } from './utils/common';

export { assertNodesDisconnected, assertConsistentNodeResponses, wait } from './utils/test-helpers';

export { TransactionManager, sendTransaction } from './blockchain/transactions';

export { BlockchainFactory } from './blockchain/factory';

export { NodeManager, SSHManager, getNodeIpList, extractHost, extractHostFromUrl } from './infrastructure/nodes';

export type {
    NodeConfig,
    NodeSSHConfig,
    ServiceConfig,
    EnvironmentSSHConfig,
    ValidatorSelectionResult,
} from './infrastructure/nodes';

// Legacy exports - deprecated, will be removed in future versions
// export { TestManager, createTestManagerFromEnv } from './blockchain/test-manager';
// export * from './blockchain/clients/evm-client';
// export * from './blockchain/clients/cosmos-client';
