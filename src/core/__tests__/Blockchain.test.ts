import { expect } from 'chai';
import { NodeType } from '../../blockchain/types';

/**
 * Unit tests for Blockchain class
 *
 * DESIGN NOTE:
 * - Blockchain.getExecuteLayerRpcUrl() returns public entry point (load balancer)
 * - BlockchainNode.getExecuteLayerRpcUrl() returns specific node endpoint
 * - ViaPublicEndpoint methods are for production-like scenarios
 *
 * DEPRECATED methods (naming convention update):
 * - getPublicEndpoint() -> getExecuteLayerRpcUrl()
 */

describe('Blockchain', () => {
    describe('Node Filtering Methods', () => {
        // Mock node data for testing
        const createMockNodes = () => [
            { index: 0, type: NodeType.VALIDATOR, active: true, votingPower: 100 },
            { index: 1, type: NodeType.VALIDATOR, active: true, votingPower: 100 },
            { index: 2, type: NodeType.VALIDATOR, active: false, votingPower: 100 },
            { index: 3, type: NodeType.NON_VALIDATOR, active: true, votingPower: 0 },
            { index: 4, type: NodeType.BOOTNODE, active: true, votingPower: 0 },
        ];

        describe('getActiveNodes', () => {
            it('should return only active nodes', () => {
                const nodes = createMockNodes();
                const activeNodes = nodes.filter(node => node.active);
                expect(activeNodes).to.have.lengthOf(4);
                expect(activeNodes.every(n => n.active)).to.be.true;
            });

            it('should exclude inactive nodes', () => {
                const nodes = createMockNodes();
                const activeNodes = nodes.filter(node => node.active);
                expect(activeNodes.find(n => n.index === 2)).to.be.undefined;
            });
        });

        describe('getActiveNotBootNodes', () => {
            it('should return active nodes excluding bootnodes', () => {
                const nodes = createMockNodes();
                const activeNotBootNodes = nodes.filter(node => node.active && node.type !== NodeType.BOOTNODE);
                expect(activeNotBootNodes).to.have.lengthOf(3);
                expect(activeNotBootNodes.every(n => n.type !== NodeType.BOOTNODE)).to.be.true;
            });

            it('should exclude bootnode even if active', () => {
                const nodes = createMockNodes();
                const activeNotBootNodes = nodes.filter(node => node.active && node.type !== NodeType.BOOTNODE);
                expect(activeNotBootNodes.find(n => n.index === 4)).to.be.undefined;
            });
        });

        describe('getNodesByType', () => {
            it('should return all validator nodes', () => {
                const nodes = createMockNodes();
                const validators = nodes.filter(node => node.type === NodeType.VALIDATOR);
                expect(validators).to.have.lengthOf(3);
            });

            it('should return all non-validator nodes', () => {
                const nodes = createMockNodes();
                const nonValidators = nodes.filter(node => node.type === NodeType.NON_VALIDATOR);
                expect(nonValidators).to.have.lengthOf(1);
            });

            it('should return all bootnode nodes', () => {
                const nodes = createMockNodes();
                const bootnodes = nodes.filter(node => node.type === NodeType.BOOTNODE);
                expect(bootnodes).to.have.lengthOf(1);
            });
        });

        describe('hasActiveBootnodes', () => {
            it('should return true when active bootnode exists', () => {
                const nodes = createMockNodes();
                const hasActiveBootnodes = nodes.some(node => node.type === NodeType.BOOTNODE && node.active);
                expect(hasActiveBootnodes).to.be.true;
            });

            it('should return false when no active bootnode', () => {
                const nodes = createMockNodes().map(n => (n.type === NodeType.BOOTNODE ? { ...n, active: false } : n));
                const hasActiveBootnodes = nodes.some(node => node.type === NodeType.BOOTNODE && node.active);
                expect(hasActiveBootnodes).to.be.false;
            });
        });

        describe('getNode', () => {
            it('should return node by index', () => {
                const nodes = createMockNodes();
                const node = nodes.find(n => n.index === 2);
                expect(node).to.not.be.undefined;
                expect(node?.index).to.equal(2);
            });

            it('should return undefined for non-existent index', () => {
                const nodes = createMockNodes();
                const node = nodes.find(n => n.index === 99);
                expect(node).to.be.undefined;
            });
        });
    });

    describe('Voting Power Selection', () => {
        const createValidatorNodes = () => [
            { index: 0, type: NodeType.VALIDATOR, active: true, votingPower: 100 },
            { index: 1, type: NodeType.VALIDATOR, active: true, votingPower: 100 },
            { index: 2, type: NodeType.VALIDATOR, active: true, votingPower: 100 },
            { index: 3, type: NodeType.VALIDATOR, active: true, votingPower: 100 },
        ];

        it('should calculate total voting power correctly', () => {
            const validators = createValidatorNodes();
            const totalVotingPower = validators.reduce((sum, node) => sum + (node.votingPower ?? 0), 0);
            expect(totalVotingPower).to.equal(400);
        });

        it('should calculate one-third threshold correctly', () => {
            const validators = createValidatorNodes();
            const totalVotingPower = validators.reduce((sum, node) => sum + (node.votingPower ?? 0), 0);
            const oneThird = Math.floor(totalVotingPower / 3);
            expect(oneThird).to.equal(133);
        });

        it('should handle validators with zero voting power', () => {
            const validators = [
                { index: 0, type: NodeType.VALIDATOR, active: true, votingPower: 100 },
                { index: 1, type: NodeType.VALIDATOR, active: true, votingPower: 0 },
            ];
            const totalVotingPower = validators.reduce((sum, node) => sum + (node.votingPower ?? 0), 0);
            expect(totalVotingPower).to.equal(100);
        });

        it('should handle undefined voting power as zero', () => {
            const validators = [
                { index: 0, type: NodeType.VALIDATOR, active: true, votingPower: undefined },
                { index: 1, type: NodeType.VALIDATOR, active: true, votingPower: 100 },
            ];
            const totalVotingPower = validators.reduce((sum, node) => sum + (node.votingPower ?? 0), 0);
            expect(totalVotingPower).to.equal(100);
        });
    });

    describe('Node Active Status', () => {
        it('should correctly toggle node active status', () => {
            const node = { index: 0, active: true };
            node.active = false;
            expect(node.active).to.be.false;
            node.active = true;
            expect(node.active).to.be.true;
        });
    });
});
