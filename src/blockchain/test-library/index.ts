// Test Library - Builder Classes
//
// This module provides builder classes for creating fluent, chainable test scenarios
// across different blockchain operations and consensus mechanisms.

export { StakingTestBuilder } from './StakingTestBuilder';
export { FaultToleranceTestBuilder, type FaultToleranceConfig } from './FaultToleranceTestBuilder';
export { LoadStressTestBuilder, LoadStressConfig } from './LoadStressTestBuilder';
export { ConsensusTestBuilder } from './ConsensusTestBuilder';
export { CosmosApiTestBuilder } from './CosmosApiTestBuilder';
export { AvalanchePlatformTestBuilder, type AvalanchePlatformTestOptions } from './AvalanchePlatformTestBuilder';
export {
    AvalancheValidatorLifecycleTestBuilder,
    type AvalancheValidatorLifecycleOptions,
    type AvalancheDiscoveredNodeConfig,
} from './AvalancheValidatorLifecycleTestBuilder';
// export { AvalanchePoSStakingTestBuilder, type AvalanchePoSStakingOptions } from './AvalanchePoSStakingTestBuilder';

export { PerformanceTestBuilder, type PerformanceRunMetrics } from './PerformanceTestBuilder';
export { RewardsTestBuilder } from './RewardsTestBuilder';
export { CometBFTTestBuilder } from './CometBFTTestBuilder';
export { EVMRpcTestBuilder } from './EVMRpcTestBuilder';
// export { SlashingTestBuilder } from './SlashingTestBuilder';
// export { CosmovisorUpgradeObserver } from './upgrade/CosmovisorUpgradeObserver';
// export { UpgradeTestOrchestrator } from './upgrade/UpgradeTestOrchestrator';
// export type { UpgradeObservationConfig, UpgradeInfo, BlockResumeResult } from './upgrade/types';
// export type {
//     UpgradeAuthority,
//     ScheduledUpgradePlan,
//     UpgradeTriggerStrategy,
// } from './upgrade/strategies/UpgradeTriggerStrategy';
// export type {
//     PostUpgradeVerificationContext,
//     PostUpgradeVerificationStrategy,
// } from './upgrade/strategies/PostUpgradeVerificationStrategy';
// export { MezoAuthorityResolver } from './upgrade/adapters/mezo/MezoAuthorityResolver';
// export type { MezoAuthorityResolverConfig } from './upgrade/adapters/mezo/MezoAuthorityResolver';
// export { MezoUpgradeTrigger } from './upgrade/adapters/mezo/MezoUpgradeTrigger';
// export type { MezoUpgradeTriggerConfig } from './upgrade/adapters/mezo/MezoUpgradeTrigger';
// export { MezoPostUpgradeVerification } from './upgrade/adapters/mezo/MezoPostUpgradeVerification';
// export type { MezoPostUpgradeVerificationConfig } from './upgrade/adapters/mezo/MezoPostUpgradeVerification';
// export { XrplEvmGovUpgradeTrigger } from './upgrade/adapters/xrplevm/XrplEvmGovUpgradeTrigger';
// export type { XrplEvmGovUpgradeTriggerConfig } from './upgrade/adapters/xrplevm/XrplEvmGovUpgradeTrigger';
// export { XrplEvmPostUpgradeVerification } from './upgrade/adapters/xrplevm/XrplEvmPostUpgradeVerification';
// export type { XrplEvmPostUpgradeVerificationConfig } from './upgrade/adapters/xrplevm/XrplEvmPostUpgradeVerification';
