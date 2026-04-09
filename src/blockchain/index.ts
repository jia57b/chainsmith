/**
 * Blockchain module exports
 */

// Core types and interfaces
export * from './types';

// Factory for creating clients
export { BlockchainFactory } from './factory';

// New client implementations (execute layer / consensus layer separation)
export { EVMExecuteClient } from './clients/evm-execute-client';
export { CosmosConsensusClient } from './clients/cosmos-consensus-client';
export { AvalanchePlatformClient } from './clients/avalanche-platform-client';

// Legacy client implementations (for backward compatibility - to be deprecated)
// export { EVMClient } from './clients/evm-client';
// export { CosmosClient } from './clients/cosmos-client';

// Other exports
export * from './transactions';
export * from './constants';

// Legacy exports - deprecated, will be removed in future versions
// export { TestManager } from './test-manager';
