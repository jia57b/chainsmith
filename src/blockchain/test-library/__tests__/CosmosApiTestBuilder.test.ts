import { expect } from 'chai';
import { CosmosApiTestBuilder } from '../CosmosApiTestBuilder';

describe('CosmosApiTestBuilder', () => {
    it('accepts validator detail wrapped in code/msg responses', async () => {
        const validator = {
            operator_address: '0x00a842dbd3d11176b4868dd753a552b8919d5a63',
            tokens: '1000000',
            status: 3,
            description: {
                moniker: '0x0FC41199CE588948861A8DA86D725A5A073AE91A',
            },
        };

        const consensusClient = {
            restEndpoint: 'http://localhost:21317',
            rpcEndpoint: 'http://localhost:36657',
            getStakingValidators() {
                return {
                    code: 200,
                    msg: {
                        validators: [validator],
                    },
                };
            },
            getStakingValidator() {
                return {
                    code: 200,
                    msg: {
                        validator,
                    },
                };
            },
            getStakingParams() {
                return {
                    params: {
                        bond_denom: 'stake',
                        unbonding_time: '10000000000',
                        max_validators: 32,
                    },
                };
            },
            getStakingPool() {
                return {
                    pool: {
                        bonded_tokens: '4000000',
                        not_bonded_tokens: '0',
                    },
                };
            },
        };

        const blockchain = {
            chainId: 1513,
            getDefaultConsensusLayerClient() {
                return consensusClient;
            },
        } as any;

        const builder = new CosmosApiTestBuilder(blockchain, ['staking', 'staking_delegation']);

        await builder.testStakingModule();
        await builder.testValidatorDetail();

        const result = builder.getTestResult('staking_validator_detail');
        expect(result.success).to.equal(true);
        expect(result.data.operator_address).to.equal(validator.operator_address);
        expect(result.data.tokens).to.equal(validator.tokens);
    });
});
