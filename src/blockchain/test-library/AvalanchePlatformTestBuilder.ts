import chai from 'chai';
import { Blockchain } from '../../core/Blockchain';
import { AvalanchePlatformClient } from '../clients/avalanche-platform-client';

const { expect } = chai;

export interface AvalanchePlatformTestOptions {
    nodeIndex?: number;
    subnetId?: string;
    blockchainId?: string;
    primaryNodes?: Array<{
        nodeId?: string;
        controlPlaneRpcUrl?: string;
        infoApiUrl?: string;
        healthApiUrl?: string;
        uri?: string;
    }>;
}

export class AvalanchePlatformTestBuilder {
    private blockchain: Blockchain;
    private client: AvalanchePlatformClient;
    private primaryNodeClients: Array<{ nodeId: string; client: AvalanchePlatformClient }> = [];
    private subnetId?: string;
    private blockchainId?: string;
    private results: Map<string, { success: boolean; data?: any; error?: string }> = new Map();

    constructor(blockchain: Blockchain, options: AvalanchePlatformTestOptions = {}) {
        this.blockchain = blockchain;
        this.subnetId = options.subnetId;
        this.blockchainId = options.blockchainId;

        const node =
            options.nodeIndex !== undefined
                ? blockchain.getNode(options.nodeIndex)
                : blockchain.getActiveNotBootNodes()[0];

        this.client = new AvalanchePlatformClient(
            {
                name: blockchain.name,
                timeout: blockchain.timeout,
                nativeToken: blockchain.nativeToken,
                addressPrefix: blockchain.addressPrefix,
            },
            {
                rpcEndpoint: node.controlPlaneRpcUrl ?? blockchain.controlPlaneRpcUrl,
                infoEndpoint: node.infoApiUrl ?? blockchain.infoApiUrl,
                healthEndpoint: node.healthApiUrl ?? blockchain.healthApiUrl,
            }
        );

        this.primaryNodeClients = (options.primaryNodes ?? [])
            .filter(nodeConfig => nodeConfig.controlPlaneRpcUrl ?? nodeConfig.infoApiUrl ?? nodeConfig.healthApiUrl)
            .map((nodeConfig, index) => ({
                nodeId: nodeConfig.nodeId ?? `primary-${index + 1}`,
                client: new AvalanchePlatformClient(
                    {
                        name: `${blockchain.name}-primary-${index + 1}`,
                        timeout: blockchain.timeout,
                        nativeToken: blockchain.nativeToken,
                        addressPrefix: blockchain.addressPrefix,
                    },
                    {
                        rpcEndpoint: nodeConfig.controlPlaneRpcUrl,
                        infoEndpoint: nodeConfig.infoApiUrl,
                        healthEndpoint: nodeConfig.healthApiUrl,
                    }
                ),
            }));
    }

    initialize(): Promise<AvalanchePlatformTestBuilder> {
        console.log(`\n🔧 Avalanche Platform Test Configuration:`);
        console.log(`   Chain: ${this.blockchain.name}`);
        console.log(`   Ecosystem: ${this.blockchain.ecosystem ?? 'unknown'}`);
        console.log(`   Control Plane: ${this.blockchain.controlPlane ?? 'unknown'}`);
        console.log(`   Subnet ID: ${this.subnetId ?? 'N/A'}`);
        console.log(`   Blockchain ID: ${this.blockchainId ?? 'N/A'}`);
        console.log(`   Platform RPC: ${this.client.rpcEndpoint ?? 'N/A'}`);
        console.log(`   Info API: ${this.client.infoEndpoint ?? 'N/A'}`);
        console.log(`   Health API: ${this.client.healthEndpoint ?? 'N/A'}`);
        console.log(`   Primary Nodes Tracked: ${this.primaryNodeClients.length}`);
        return Promise.resolve(this);
    }

    async testConnectivity(): Promise<AvalanchePlatformTestBuilder> {
        console.log(`\n🔗 Testing Avalanche platform connectivity...`);

        try {
            const connected = await this.client.isConnected();
            expect(connected).to.equal(true);
            this.results.set('connectivity', { success: true, data: { connected } });
            console.log(`   ✅ Control plane connectivity confirmed`);
        } catch (error: any) {
            this.results.set('connectivity', { success: false, error: error.message });
            throw error;
        }

        return this;
    }

    async testHealth(): Promise<AvalanchePlatformTestBuilder> {
        console.log(`\n❤️ Testing Avalanche node health...`);

        try {
            const health = await this.client.getHealth();
            expect(health?.healthy).to.equal(true);
            this.results.set('health', { success: true, data: health });
            console.log(`   ✅ Health API reports healthy=true`);
        } catch (error: any) {
            this.results.set('health', { success: false, error: error.message });
            throw error;
        }

        return this;
    }

    async testNetworkInfo(): Promise<AvalanchePlatformTestBuilder> {
        console.log(`\n🌐 Testing Avalanche network info...`);

        try {
            const info = await this.client.getNetworkInfo();
            expect(info.chainId).to.not.equal('');
            this.results.set('networkInfo', { success: true, data: info });
            console.log(`   ✅ Network ID: ${info.chainId}`);
            console.log(`   ✅ Network Name: ${info.networkName ?? 'unknown'}`);
            console.log(`   ✅ Platform Height: ${info.blockHeight}`);
        } catch (error: any) {
            this.results.set('networkInfo', { success: false, error: error.message });
            throw error;
        }

        return this;
    }

    async testPlatformHeight(): Promise<AvalanchePlatformTestBuilder> {
        console.log(`\n📦 Testing P-Chain height...`);

        try {
            const height = await this.client.getPlatformHeight();
            expect(height).to.be.greaterThanOrEqual(0);
            this.results.set('platformHeight', { success: true, data: { height } });
            console.log(`   ✅ P-Chain height: ${height}`);
        } catch (error: any) {
            this.results.set('platformHeight', { success: false, error: error.message });
            throw error;
        }

        return this;
    }

    async testCurrentValidators(): Promise<AvalanchePlatformTestBuilder> {
        console.log(`\n👥 Testing current validators...`);

        try {
            const validators = await this.client.getCurrentValidators(this.subnetId);
            expect(validators).to.be.an('array');
            this.results.set('validators', { success: true, data: { count: validators.length, validators } });
            console.log(`   ✅ Current validators: ${validators.length}`);
        } catch (error: any) {
            this.results.set('validators', { success: false, error: error.message });
            throw error;
        }

        return this;
    }

    async testBlockchainMetadata(): Promise<AvalanchePlatformTestBuilder> {
        if (!this.blockchainId) {
            console.log(`\n⏭️  No blockchainId provided, skipping blockchain metadata test`);
            return this;
        }

        console.log(`\n🧾 Testing blockchain metadata...`);

        try {
            const blockchain = await this.client.getBlockchain(this.blockchainId);
            expect(blockchain).to.not.equal(null);
            this.results.set('blockchainMetadata', { success: true, data: blockchain });
            console.log(`   ✅ Blockchain metadata found for ${this.blockchainId}`);
        } catch (error: any) {
            this.results.set('blockchainMetadata', { success: false, error: error.message });
            throw error;
        }

        return this;
    }

    async testL1Status(): Promise<AvalanchePlatformTestBuilder> {
        if (!this.blockchainId) {
            console.log(`\n⏭️  No blockchainId provided, skipping L1 status test`);
            return this;
        }

        console.log(`\n🚦 Testing L1 status...`);

        try {
            const status = await this.client.getL1Status(this.blockchainId, this.subnetId);
            expect(status.exists).to.equal(true);
            expect(status.healthy).to.equal(true);
            expect(status.bootstrapped).to.equal(true);
            this.results.set('l1Status', { success: true, data: status });
            console.log(
                `   ✅ exists=${status.exists}, healthy=${status.healthy}, bootstrapped=${status.bootstrapped}, validators=${status.validatorCount}`
            );
        } catch (error: any) {
            this.results.set('l1Status', { success: false, error: error.message });
            throw error;
        }

        return this;
    }

    async testPrimaryNodeHealth(): Promise<AvalanchePlatformTestBuilder> {
        if (this.primaryNodeClients.length === 0) {
            console.log(`\n⏭️  No discovered primary nodes provided, skipping primary node health checks`);
            return this;
        }

        console.log(`\n❤️ Testing primary node health...`);
        const results = [];

        for (const { nodeId, client } of this.primaryNodeClients) {
            const health = await client.getHealth();
            expect(health?.healthy, `${nodeId} should report healthy=true`).to.equal(true);
            console.log(`   ✅ ${nodeId}: healthy=true`);
            results.push({ nodeId, healthy: true });
        }

        this.results.set('primaryNodeHealth', { success: true, data: results });
        return this;
    }

    async testPrimaryNodeInfoConsistency(): Promise<AvalanchePlatformTestBuilder> {
        if (this.primaryNodeClients.length === 0) {
            console.log(`\n⏭️  No discovered primary nodes provided, skipping primary node info consistency`);
            return this;
        }

        console.log(`\n🧭 Testing primary node info consistency...`);
        const infos = [];

        for (const { nodeId, client } of this.primaryNodeClients) {
            const [resolvedNodeId, networkInfo] = await Promise.all([client.getNodeID(), client.getNetworkInfo()]);
            expect(resolvedNodeId).to.not.equal('');
            infos.push({
                nodeId,
                resolvedNodeId,
                networkId: String(networkInfo.chainId),
                networkName: networkInfo.networkName ?? '',
            });
            console.log(
                `   ✅ ${nodeId}: resolvedNodeId=${resolvedNodeId}, networkId=${networkInfo.chainId}, networkName=${networkInfo.networkName ?? 'unknown'}`
            );
        }

        const networkIds = [...new Set(infos.map(info => info.networkId))];
        const networkNames = [...new Set(infos.map(info => info.networkName))];
        expect(networkIds.length, 'all primary nodes should report the same network ID').to.equal(1);
        expect(networkNames.length, 'all primary nodes should report the same network name').to.equal(1);

        this.results.set('primaryNodeInfoConsistency', {
            success: true,
            data: { infos, networkId: networkIds[0], networkName: networkNames[0] },
        });
        return this;
    }

    async testPrimaryNodePlatformHeightConsistency(maxDrift: number = 1): Promise<AvalanchePlatformTestBuilder> {
        if (this.primaryNodeClients.length === 0) {
            console.log(`\n⏭️  No discovered primary nodes provided, skipping primary node height consistency`);
            return this;
        }

        console.log(`\n📦 Testing primary node P-Chain height consistency...`);
        const heights = [];

        for (const { nodeId, client } of this.primaryNodeClients) {
            const height = await client.getPlatformHeight();
            heights.push({ nodeId, height });
            console.log(`   ✅ ${nodeId}: P-height=${height}`);
        }

        const numericHeights = heights.map(item => item.height);
        const minHeight = Math.min(...numericHeights);
        const maxHeight = Math.max(...numericHeights);
        expect(maxHeight - minHeight, `primary node P-heights should not drift by more than ${maxDrift}`).to.be.at.most(
            maxDrift
        );

        this.results.set('primaryNodePlatformHeightConsistency', {
            success: true,
            data: { heights, minHeight, maxHeight, maxDrift },
        });
        return this;
    }

    async testBlockchainVisibilityAcrossPrimaryNodes(): Promise<AvalanchePlatformTestBuilder> {
        if (!this.blockchainId) {
            console.log(`\n⏭️  No blockchainId provided, skipping blockchain visibility across primary nodes`);
            return this;
        }
        if (this.primaryNodeClients.length === 0) {
            console.log(
                `\n⏭️  No discovered primary nodes provided, skipping blockchain visibility across primary nodes`
            );
            return this;
        }

        console.log(`\n🛰️ Testing blockchain visibility across primary nodes...`);
        const visibility = [];

        for (const { nodeId, client } of this.primaryNodeClients) {
            const blockchain = await client.getBlockchain(this.blockchainId);
            expect(blockchain, `${nodeId} should see blockchain ${this.blockchainId}`).to.not.equal(null);
            console.log(`   ✅ ${nodeId}: blockchain visible`);
            visibility.push({ nodeId, visible: true });
        }

        this.results.set('primaryNodeBlockchainVisibility', { success: true, data: visibility });
        return this;
    }

    assertResults(): AvalanchePlatformTestBuilder {
        for (const [name, result] of this.results) {
            expect(result.success, `${name} should succeed: ${result.error ?? 'unknown error'}`).to.equal(true);
        }
        return this;
    }

    async cleanup(): Promise<void> {
        await this.blockchain.cleanup();
    }
}
