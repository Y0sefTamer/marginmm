import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, decodeFill, decodeQuote, decodeState } from './api';
import { fillFixture, quoteFixture, stateFixture } from './test/fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('API response boundary', () => {
  it('accepts the documented local-fork state and decimal strings', () => {
    expect(decodeState(stateFixture)).toEqual(stateFixture);
    expect(decodeQuote(quoteFixture)).toEqual(quoteFixture);
    expect(decodeFill(fillFixture)).toEqual(fillFixture);
  });
  it('rejects missing fields, numeric amounts and actual mainnet chain IDs', () => {
    expect(() => decodeState({})).toThrow();
    expect(() => decodeState({ ...stateFixture, collateral: { weth: 10, usdc: '100' } })).toThrow();
    expect(() => decodeState({ ...stateFixture, chain: { ...stateFixture.chain, id: '1' } })).toThrow();
    expect(() => decodeState({ ...stateFixture, chain: { ...stateFixture.chain, fork: false } })).toThrow();
  });
  it('only permits null health factors for a debt-free account', () => {
    expect(() => decodeState({ ...stateFixture, currentHF: null })).toThrow();
    expect(decodeState({ ...stateFixture, debt: { usdc: '0' }, currentHF: null, stressHF: null }).stressHF).toBeNull();
  });
  it('rejects overfills, inconsistent partial-fill flags and below-floor ready quotes', () => {
    expect(() => decodeQuote({ ...quoteFixture, executableOut: '1001' })).toThrow();
    expect(() => decodeQuote({ ...quoteFixture, qMax: '1' })).toThrow();
    expect(() => decodeQuote({ ...quoteFixture, partialFill: false })).toThrow();
    expect(() => decodeQuote({ ...quoteFixture, stressHF: '1.09' })).toThrow();
    expect(() => decodeQuote({ ...quoteFixture, executableOut: '0' })).toThrow();
  });
  it('requires a real hash for confirmed fills and zero output for rejections', () => {
    expect(() => decodeFill({ ...fillFixture, transactionHash: '0xfake' })).toThrow();
    expect(() => decodeFill({ ...fillFixture, status: 'rejected', transactionHash: null })).toThrow();
    expect(decodeFill({ ...fillFixture, status: 'rejected', transactionHash: null, executedOut: '0' }).status).toBe('rejected');
  });
});

describe('HTTP requests', () => {
  it('posts exactly the decimal string, with no numeric conversion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...quoteFixture, direction: 'usdc-in', requestedOut: '0.123456789123456789', executableOut: '0.1', qMax: '0.1' })));
    vi.stubGlobal('fetch', fetchMock);
    await api.quote('usdc-in', '0.123456789123456789');
    expect(fetchMock).toHaveBeenCalledWith('/api/quote', expect.objectContaining({ method: 'POST', body: '{"direction":"usdc-in","amountOut":"0.123456789123456789"}', credentials: 'same-origin' }));
  });
  it('maps expected rejection codes without exposing backend internals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'QUOTE_EXPIRED', message: 'SECRET internal stack' } }), { status: 409 })));
    await expect(api.fill('quote-1')).rejects.toThrow('This quote expired.');
  });
  it('does not retry uncertain fill submissions', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Network failure'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.fill('quote-1')).rejects.toThrow('outcome is unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects an HTML fallback response and malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Proxy unavailable</html>')));
    await expect(api.state()).rejects.toThrow('invalid JSON');
  });
});
