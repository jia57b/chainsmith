import '../../setup';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import { RuntimeManager } from '../../src/core/RuntimeManager';
import { AvalancheValidatorLifecycleTestBuilder } from '../../src/blockchain/test-library';
import { Config } from '../../src/utils/common';

const configPath = path.join(__dirname, '../config.json');
const envName = Config.envName;
const defaultGhostManifestPath = path.join(
    process.cwd(),
    'chains',
    'avalanche-cli-local',
    'runtime',
    'ghost-validator',
    'ghost-validator-manifest.json'
);
const defaultGhostPrepareCommand = path.join(
    process.cwd(),
    'chains',
    'avalanche-cli-local',
    'prepare-ghost-validator.sh'
);
const defaultColdManifestPath = path.join(
    process.cwd(),
    'chains',
    'avalanche-cli-local',
    'runtime',
    'cold-validator',
    'cold-validator-manifest.json'
);
const defaultColdPrepareCommand = path.join(
    process.cwd(),
    'chains',
    'avalanche-cli-local',
    'prepare-cold-validator.sh'
);
const defaultColdCleanupCommand = path.join(
    process.cwd(),
    'chains',
    'avalanche-cli-local',
    'cleanup-cold-validator.sh'
);
const exec = promisify(execCallback);

const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const chainConfig = rawConfig[envName] || {};

function resolveGhostValidatorCandidate(): {
    nodeId?: string;
    blsPublicKey?: string;
    blsProofOfPossession?: string;
} {
    const configuredGhost = chainConfig.validatorLifecycle?.ghostValidator ?? {};
    const manifestPath =
        process.env.AVALANCHE_GHOST_VALIDATOR_MANIFEST ?? configuredGhost.manifestPath ?? defaultGhostManifestPath;
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) : {};
    return {
        nodeId: process.env.AVALANCHE_GHOST_VALIDATOR_NODE_ID ?? configuredGhost.nodeId ?? manifest.nodeId,
        blsPublicKey:
            process.env.AVALANCHE_GHOST_VALIDATOR_BLS_PUBLIC_KEY ??
            configuredGhost.blsPublicKey ??
            manifest.blsPublicKey,
        blsProofOfPossession:
            process.env.AVALANCHE_GHOST_VALIDATOR_BLS_PROOF_OF_POSSESSION ??
            configuredGhost.blsProofOfPossession ??
            manifest.blsProofOfPossession,
    };
}

function hasExplicitGhostValidatorIdentity(): boolean {
    const configuredGhost = chainConfig.validatorLifecycle?.ghostValidator ?? {};
    return Boolean(
        process.env.AVALANCHE_GHOST_VALIDATOR_NODE_ID ||
            configuredGhost.nodeId ||
            process.env.AVALANCHE_GHOST_VALIDATOR_BLS_PUBLIC_KEY ||
            configuredGhost.blsPublicKey ||
            process.env.AVALANCHE_GHOST_VALIDATOR_BLS_PROOF_OF_POSSESSION ||
            configuredGhost.blsProofOfPossession
    );
}

async function ensureGhostValidatorPrepared(): Promise<void> {
    if (hasExplicitGhostValidatorIdentity()) {
        return;
    }

    const prepareCommand = process.env.AVALANCHE_GHOST_VALIDATOR_PREPARE_COMMAND ?? defaultGhostPrepareCommand;
    console.log(`\n🛠️  Preparing ghost validator identity via: ${prepareCommand}`);
    await execShellCommand(prepareCommand);
}

function resolveColdJoinCandidate(): {
    nodeId?: string;
    uri?: string;
    healthApiUrl?: string;
    blsPublicKey?: string;
    blsProofOfPossession?: string;
    startCommand?: string;
    stopCommand?: string;
} {
    const configuredCandidate = chainConfig.validatorLifecycle?.coldJoinCandidate ?? {};
    const manifestPath =
        process.env.AVALANCHE_COLD_JOIN_MANIFEST ?? configuredCandidate.manifestPath ?? defaultColdManifestPath;
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) : {};
    return {
        nodeId: process.env.AVALANCHE_COLD_JOIN_NODE_ID ?? configuredCandidate.nodeId ?? manifest.nodeId,
        uri: process.env.AVALANCHE_COLD_JOIN_NODE_ENDPOINT ?? configuredCandidate.uri ?? manifest.uri,
        healthApiUrl:
            process.env.AVALANCHE_COLD_JOIN_HEALTH_API_URL ?? configuredCandidate.healthApiUrl ?? manifest.healthApiUrl,
        blsPublicKey:
            process.env.AVALANCHE_COLD_JOIN_BLS_PUBLIC_KEY ?? configuredCandidate.blsPublicKey ?? manifest.blsPublicKey,
        blsProofOfPossession:
            process.env.AVALANCHE_COLD_JOIN_BLS_PROOF_OF_POSSESSION ??
            configuredCandidate.blsProofOfPossession ??
            manifest.blsProofOfPossession,
        startCommand:
            process.env.AVALANCHE_COLD_JOIN_START_COMMAND ??
            configuredCandidate.startCommand ??
            defaultColdPrepareCommand,
        stopCommand:
            process.env.AVALANCHE_COLD_JOIN_STOP_COMMAND ??
            configuredCandidate.stopCommand ??
            defaultColdCleanupCommand,
    };
}

function hasExplicitColdJoinCandidate(): boolean {
    const configuredCandidate = chainConfig.validatorLifecycle?.coldJoinCandidate ?? {};
    return Boolean(
        process.env.AVALANCHE_COLD_JOIN_NODE_ID ||
            configuredCandidate.nodeId ||
            process.env.AVALANCHE_COLD_JOIN_NODE_ENDPOINT ||
            configuredCandidate.uri ||
            process.env.AVALANCHE_COLD_JOIN_HEALTH_API_URL ||
            configuredCandidate.healthApiUrl
    );
}

async function ensureColdJoinCandidatePrepared(): Promise<void> {
    if (
        hasExplicitColdJoinCandidate() &&
        fs.existsSync(
            process.env.AVALANCHE_COLD_JOIN_MANIFEST ??
                chainConfig.validatorLifecycle?.coldJoinCandidate?.manifestPath ??
                defaultColdManifestPath
        )
    ) {
        return;
    }

    const prepareCommand = process.env.AVALANCHE_COLD_JOIN_PREPARE_COMMAND ?? defaultColdPrepareCommand;
    console.log(`\n🛠️  Preparing cold-join validator via: ${prepareCommand}`);
    await execShellCommand(prepareCommand);
}

async function execShellCommand(command: string | undefined): Promise<void> {
    if (!command) {
        return;
    }

    await exec(command, {
        cwd: process.cwd(),
        shell: process.env.SHELL || '/bin/zsh',
    });
}

async function waitForHttpHealthy(
    url: string,
    timeoutMs: number = 120000,
    pollIntervalMs: number = 3000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: string | null = null;

    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            const payload = await response.json();
            if (response.ok && payload?.healthy === true) {
                return;
            }
            lastError = `healthy=${String(payload?.healthy)} status=${response.status}`;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
        `Timed out waiting for ${url} to report healthy=true. Last result: ${lastError ?? 'unknown error'}`
    );
}

describe('Avalanche PoA Validator Lifecycle Tests', function () {
    this.timeout(420000);
    let testBuilder: AvalancheValidatorLifecycleTestBuilder;

    beforeEach(async function () {
        if (chainConfig.controlPlane !== 'avalanche-platform') {
            console.log(`\n⏭️  ${envName} is not configured for avalanche-platform, skipping tests`);
            this.skip();
        }

        if (chainConfig.validatorManagementType !== 'Proof Of Authority') {
            console.log(`\n⏭️  ${envName} is not a Proof Of Authority Avalanche L1, skipping PoA lifecycle tests`);
            this.skip();
        }

        const runtimeManager = new RuntimeManager();
        await runtimeManager.connectToChainFromConfigFile(configPath, envName);
        const blockchain = runtimeManager.getChain(envName);
        if (!blockchain) {
            throw new Error(`Failed to connect to blockchain: ${envName}`);
        }

        testBuilder = new AvalancheValidatorLifecycleTestBuilder(blockchain, {
            avalancheCliChainName: chainConfig.avalancheCliChainName || 'chainsmithavalanche',
            validatorManagementType: chainConfig.validatorManagementType,
            subnetId: chainConfig.subnetId,
            blockchainId: chainConfig.blockchainId,
            validatorManagerRpcEndpoint: chainConfig.validatorManagerRpcEndpoint || chainConfig.executeLayerHttpRpcUrl,
            changeOwnerAddress: chainConfig.changeOwnerAddress,
            validatorManagerOwner: chainConfig.validatorManagerOwner,
            feePayerPChainAddress: chainConfig.feePayerPChainAddress,
            validatorLifecycle: chainConfig.validatorLifecycle,
            primaryNodes: chainConfig.discoveredPrimaryNodes || [],
        });
    });

    afterEach(async function () {
        this.timeout(420000);
        if (testBuilder) {
            await testBuilder.cleanup();
        }
    });

    it('PoA Lifecycle: should add then remove a discovered primary node and keep the L1 healthy', async function () {
        this.timeout(420000);
        await testBuilder
            .initialize()
            .then(builder => builder.verifyFeePayerBalance())
            .then(builder => builder.selectCandidatePrimaryNode())
            .then(builder => builder.addValidator())
            .then(builder => builder.waitForValidatorAdded())
            .then(builder => builder.verifyPlatformHealthy())
            .then(builder => builder.verifyBlockchainVisibility())
            .then(builder => builder.verifyExecutionSmoke())
            .then(builder => builder.removeValidator())
            .then(builder => builder.waitForValidatorRemoved())
            .then(builder => builder.verifyPlatformHealthy())
            .then(builder => builder.verifyBlockchainVisibility())
            .then(builder => builder.verifyExecutionSmoke())
            .then(builder => builder.assertResults());
    });

    it('PoA Ghost Validator Registration: should register then remove a configured ghost validator without starting a new node process', async function () {
        this.timeout(420000);

        await ensureGhostValidatorPrepared();
        const ghostValidator = resolveGhostValidatorCandidate();
        if (!ghostValidator.nodeId || !ghostValidator.blsPublicKey || !ghostValidator.blsProofOfPossession) {
            console.log(`\n⏭️  No ghost validator identity configured, skipping ghost validator lifecycle test`);
            this.skip();
        }

        await testBuilder
            .initialize()
            .then(builder => builder.verifyFeePayerBalance())
            .then(builder =>
                builder.selectGhostValidatorCandidate({
                    nodeId: ghostValidator.nodeId,
                    blsPublicKey: ghostValidator.blsPublicKey,
                    blsProofOfPossession: ghostValidator.blsProofOfPossession,
                })
            )
            .then(builder => builder.addValidator())
            .then(builder => builder.waitForValidatorAdded())
            .then(builder => builder.verifyPlatformHealthy())
            .then(builder => builder.verifyBlockchainVisibility())
            .then(builder => builder.verifyExecutionSmoke())
            .then(builder => builder.removeValidator())
            .then(builder => builder.waitForValidatorRemoved())
            .then(builder => builder.verifyPlatformHealthy())
            .then(builder => builder.verifyBlockchainVisibility())
            .then(builder => builder.verifyExecutionSmoke())
            .then(builder => builder.assertResults());
    });

    it('PoA Onboarding: should cold-join a configured node process, add it to the L1, and remove it cleanly', async function () {
        this.timeout(600000);

        await ensureColdJoinCandidatePrepared();
        const coldJoinCandidate = resolveColdJoinCandidate();
        if (
            !coldJoinCandidate.nodeId ||
            !coldJoinCandidate.uri ||
            !coldJoinCandidate.healthApiUrl ||
            !coldJoinCandidate.startCommand ||
            !coldJoinCandidate.stopCommand
        ) {
            console.log(`\n⏭️  No cold-join candidate configured, skipping onboarding lifecycle test`);
            this.skip();
        }

        await execShellCommand(coldJoinCandidate.stopCommand).catch(() => undefined);

        try {
            await execShellCommand(coldJoinCandidate.startCommand);
            await waitForHttpHealthy(coldJoinCandidate.healthApiUrl!);

            await testBuilder
                .initialize()
                .then(builder => builder.verifyFeePayerBalance())
                .then(builder =>
                    builder.selectConfiguredValidatorCandidate({
                        nodeId: coldJoinCandidate.nodeId,
                        uri: coldJoinCandidate.uri,
                        healthApiUrl: coldJoinCandidate.healthApiUrl,
                        blsPublicKey: coldJoinCandidate.blsPublicKey,
                        blsProofOfPossession: coldJoinCandidate.blsProofOfPossession,
                    })
                )
                .then(builder => builder.addValidator())
                .then(builder => builder.waitForValidatorAdded())
                .then(builder => builder.verifyPlatformHealthy())
                .then(builder => builder.verifyBlockchainVisibility())
                .then(builder => builder.verifyExecutionSmoke())
                .then(builder => builder.removeValidator())
                .then(builder => builder.waitForValidatorRemoved())
                .then(builder => builder.verifyPlatformHealthy())
                .then(builder => builder.verifyBlockchainVisibility())
                .then(builder => builder.verifyExecutionSmoke())
                .then(builder => builder.assertResults());
        } finally {
            await execShellCommand(coldJoinCandidate.stopCommand).catch(() => undefined);
        }
    });
});
