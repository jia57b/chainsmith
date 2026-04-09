import chai from 'chai';
import {
    formatNAvaxAsAvax,
    normalizeConfiguredAvaxAmount,
    parseAvaxToNAvax,
} from '../AvalancheValidatorLifecycleTestBuilder';

const { expect } = chai;

describe('AvalancheValidatorLifecycleTestBuilder amount normalization', () => {
    it('treats legacy integer config values as nAVAX and converts them to AVAX for CLI usage', () => {
        const normalized = normalizeConfiguredAvaxAmount('100000000');

        expect(normalized.source).to.equal('legacy-navax');
        expect(normalized.nAvax).to.equal(100000000n);
        expect(normalized.normalizedAvax).to.equal('0.1');
    });

    it('preserves AVAX decimal strings for CLI usage', () => {
        const normalized = normalizeConfiguredAvaxAmount('0.125');

        expect(normalized.source).to.equal('avax');
        expect(normalized.nAvax).to.equal(125000000n);
        expect(normalized.normalizedAvax).to.equal('0.125');
    });

    it('treats small integer values as AVAX amounts', () => {
        const normalized = normalizeConfiguredAvaxAmount('20');

        expect(normalized.source).to.equal('avax');
        expect(normalized.nAvax).to.equal(20000000000n);
        expect(normalized.normalizedAvax).to.equal('20');
    });

    it('formats nAVAX values without losing precision', () => {
        expect(formatNAvaxAsAvax(110000000n)).to.equal('0.11');
        expect(parseAvaxToNAvax('0.11')).to.equal(110000000n);
    });
});
