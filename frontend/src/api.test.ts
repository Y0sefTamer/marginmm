import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, decodeAgentProposal, decodeFill, decodeMakerAction, decodeQuote, decodeState } from './api';
import { fillFixture, proposalFixture, quoteFixture, stateFixture } from './test/fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('API response boundary', () => {
  it('accepts the exact local-fork state, quote, fill and paid proposal contracts', () => {
    expect(decodeState(stateFixture)).toEqual(stateFixture);
    expect(decodeQuote(quoteFixture)).toEqual(quoteFixture);
    expect(decodeFill(fillFixture)).toEqual(fillFixture);
    expect(decodeAgentProposal(proposalFixture)).toEqual(proposalFixture);
  });

  it('rejects numeric financial values, public chain ids and policy/state contradictions', () => {
    expect(() => decodeState({})).toThrow();
    expect(() => decodeState({ ...stateFixture, collateral: { weth: 10, usdc: '100' } })).toThrow();
    expect(() => decodeState({ ...stateFixture, chain: { ...stateFixture.chain, id: '1' } })).toThrow();
    expect(() => decodeState({ ...stateFixture, chain: { ...stateFixture.chain, timestamp: 0 } })).toThrow();
    expect(() => decodeState({
      ...stateFixture,
      chain: { ...stateFixture.chain, timestamp: stateFixture.chain.timestamp + 1 },
    })).toThrow();
    expect(() => decodeState({ ...stateFixture, ready: false })).toThrow();
    expect(() => decodeState({ ...stateFixture, policy: { ...stateFixture.policy, shockBps: 0 } })).toThrow();
    expect(() => decodeState({ ...stateFixture, policy: { ...stateFixture.policy, marketRegime: 4 } })).toThrow();
    expect(() => decodeState({ ...stateFixture, policy: { ...stateFixture.policy, policyVersion: 0x1_0000_0000 } })).toThrow();
    expect(() => decodeState({ ...stateFixture, policy: { ...stateFixture.policy, validUntil: stateFixture.policy.issuedAt + 21_601 } })).toThrow();
    expect(() => decodeQuote({ ...quoteFixture, policyVersion: 0x1_0000_0000 })).toThrow();
    expect(() => decodeFill({ ...fillFixture, policyVersion: 0x1_0000_0000 })).toThrow();
    expect(() => decodeAgentProposal({
      ...proposalFixture, calibration: { ...proposalFixture.calibration!, policyVersion: 0x1_0000_0000 },
    })).toThrow();
    expect(() => decodeAgentProposal({
      ...proposalFixture,
      calibration: { ...proposalFixture.calibration!, evidenceBlockFrom: 25_913_341 },
    })).toThrow();
  });

  it('permits no StressHF only before a signed policy exists', () => {
    const missing = {
      ...stateFixture, stressHF: null, ready: false,
      policy: {
        ...stateFixture.policy, state: 'missing', enabled: false, hardFloorStressHF: '0',
        policyVersion: 0, revision: '0', shockBps: 0, marketRegime: 0, modelVersion: 0,
        issuedAt: 0, validUntil: 0, secondsRemaining: 0,
        evidenceBlockFrom: 0, evidenceBlockTo: 0, evidenceHash: null,
      },
    };
    expect(decodeState(missing).stressHF).toBeNull();
    expect(() => decodeState({ ...stateFixture, stressHF: null })).toThrow();
  });

  it('rejects over-input, inconsistent qMax/partial flags and below-floor ready quotes', () => {
    expect(() => decodeQuote({ ...quoteFixture, actualAmountIn: '6' })).toThrow();
    expect(() => decodeQuote({ ...quoteFixture, qMax: '1' })).toThrow();
    expect(() => decodeQuote({ ...quoteFixture, partialFill: false })).toThrow();
    expect(() => decodeQuote({ ...quoteFixture, stressHFAfter: '1.09' })).toThrow();
    expect(() => decodeQuote({ ...quoteFixture, finalAmountOut: '0', qMax: '0' })).toThrow();
  });

  it('requires canonical Maker action fields and a real confirmed transaction hash', () => {
    expect(() => decodeMakerAction({ ...proposalFixture.approval, chainId: '1' })).toThrow();
    expect(() => decodeMakerAction({ ...proposalFixture.approval, value: '1' })).toThrow();
    expect(() => decodeFill({ ...fillFixture, baseAmountOut: '7400' })).toThrow();
    expect(() => decodeFill({ ...fillFixture, transactionHash: '0xfake' })).toThrow();
  });
});

describe('HTTP requests', () => {
  it('posts exact-in and minimum-output decimal strings without numeric conversion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(quoteFixture)));
    vi.stubGlobal('fetch', fetchMock);
    await api.quote('weth-in', '5.000000000000000001', '1.000001');
    expect(fetchMock).toHaveBeenCalledWith('/api/quote', expect.objectContaining({
      method: 'POST',
      body: '{"direction":"weth-in","maxAmountIn":"5.000000000000000001","minAmountOut":"1.000001"}',
      credentials: 'same-origin',
    }));
  });

  it('maps expected rejection codes without exposing backend internals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'QUOTE_EXPIRED', message: 'SECRET internal stack' } }), { status: 409 },
    )));
    await expect(api.fill(quoteFixture.quoteId)).rejects.toThrow('This quote expired.');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'AGENT_UNAVAILABLE', message: 'SECRET internal stack' } }), { status: 503 },
    )));
    await expect(api.agent('11111111-1111-4111-8111-111111111111', '1.10', false))
      .rejects.toThrow('pre-payment checks');
  });

  it('does not retry an uncertain mutation', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Network failure'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.fill(quoteFixture.quoteId)).rejects.toThrow('outcome is unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts the caller-owned Agent idempotency key unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(proposalFixture)));
    vi.stubGlobal('fetch', fetchMock);
    const requestId = '11111111-1111-4111-8111-111111111111';
    await api.agent(requestId, '1.10', false);
    expect(fetchMock).toHaveBeenCalledWith('/api/agent', expect.objectContaining({
      body: `{"requestId":"${requestId}","hardFloor":"1.10","forceRefresh":false}`,
    }));
  });

  it('rejects HTML fallback and malformed JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Proxy unavailable</html>')));
    await expect(api.state()).rejects.toThrow('invalid JSON');
  });
});
