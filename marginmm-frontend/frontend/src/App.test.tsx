import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api, ApiError } from './api';
import type { Fill, MakerState, Quote } from './api';
import { fillFixture, quoteFixture, stateFixture } from './test/fixtures';

vi.mock('./api', async importOriginal => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: { state: vi.fn(), quote: vi.fn(), fill: vi.fn(), policy: vi.fn(), scenario: vi.fn() } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function connected() {
  render(<App />);
  await screen.findByText('Local API connected');
}
beforeEach(() => {
  vi.mocked(api.state).mockReset().mockResolvedValue(structuredClone(stateFixture));
  vi.mocked(api.quote).mockReset().mockResolvedValue(structuredClone(quoteFixture));
  vi.mocked(api.fill).mockReset().mockResolvedValue(structuredClone(fillFixture));
  vi.mocked(api.policy).mockReset().mockResolvedValue({ ...stateFixture, riskFloor: '1.20' });
  vi.mocked(api.scenario).mockReset().mockResolvedValue(structuredClone(stateFixture));
});
afterEach(() => vi.useRealTimers());

describe('maker dashboard', () => {
  it('shows unavailable balances and disables mutations when the API is disconnected', async () => {
    vi.mocked(api.state).mockRejectedValue(new ApiError('Backend unavailable'));
    render(<App />);
    await screen.findByText('Local backend disconnected');
    expect(screen.getByRole('button', { name: 'Get executable quote' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Withdraw USDC' })).toBeDisabled();
    expect(screen.queryByText('20,000.000001')).not.toBeInTheDocument();
  });
  it('can reconnect and renders exact live balances', async () => {
    vi.mocked(api.state).mockRejectedValueOnce(new ApiError('Backend unavailable'));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await screen.findByText('Local API connected');
    expect(screen.getByTitle('10.123456789123456789')).toHaveTextContent('10.12345678 WETH');
    expect(screen.getByTitle('20000.000001')).toHaveTextContent('20,000.000001 USDC');
  });
  it('preserves the requested output and executes the reviewed partial quote only once', async () => {
    const pending = deferred<Fill>();
    vi.mocked(api.fill).mockReturnValue(pending.promise);
    await connected();
    await userEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    expect(api.quote).toHaveBeenCalledWith('weth-in', '1000');
    await screen.findByText('Partial fill available');
    const execute = screen.getByRole('button', { name: 'Execute quoted fill' });
    fireEvent.click(execute);
    fireEvent.click(execute);
    expect(api.fill).toHaveBeenCalledTimes(1);
    expect(api.fill).toHaveBeenCalledWith('quote-1');
    expect(screen.getByRole('button', { name: 'Withdraw USDC' })).toBeDisabled();
    await act(async () => pending.resolve(fillFixture));
    await screen.findByText(fillFixture.transactionHash!);
    expect(screen.getByRole('cell', { name: '750.123456 USDC' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Execute quoted fill' })).not.toBeInTheDocument();
  });
  it('invalidates a quote after editing the request or direction', async () => {
    await connected();
    await userEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    await screen.findByText('Partial fill available');
    await userEvent.clear(screen.getByLabelText(/Requested output/));
    expect(screen.queryByRole('button', { name: 'Execute quoted fill' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/Trade direction/), 'usdc-in');
    await userEvent.type(screen.getByLabelText(/Requested output/), '0.000000000000000001');
    expect(screen.getByRole('button', { name: 'Get executable quote' })).toBeEnabled();
  });
  it('blocks USDC over-precision and floors below the minimum', async () => {
    await connected();
    fireEvent.change(screen.getByLabelText(/Requested output/), { target: { value: '1.0000001' } });
    expect(screen.getByRole('button', { name: 'Get executable quote' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Custom floor/), { target: { value: '1.09' } });
    expect(screen.getByRole('button', { name: 'Apply policy' })).toBeDisabled();
    expect(api.quote).not.toHaveBeenCalled();
    expect(api.policy).not.toHaveBeenCalled();
  });
  it('applies a selected policy via API and discards the old quote', async () => {
    await connected();
    await userEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    await screen.findByText('Partial fill available');
    await userEvent.click(screen.getByRole('button', { name: '1.20 More headroom' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply policy' }));
    expect(api.policy).toHaveBeenCalledWith('1.20');
    await screen.findByText(/Policy applied/);
    expect(screen.queryByRole('button', { name: 'Execute quoted fill' })).not.toBeInTheDocument();
  });
  it('displays rejection reasons without allowing execution', async () => {
    vi.mocked(api.quote).mockResolvedValue({ ...quoteFixture, status: 'rejected', executableOut: '0', reason: 'Position has no output capacity.' });
    await connected();
    await userEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    await screen.findByText('Quote rejected');
    expect(screen.getByRole('alert')).toHaveTextContent('Position has no output capacity.');
    expect(screen.getByRole('button', { name: 'Execute quoted fill' })).toBeDisabled();
  });
  it('expires quotes and prevents submission', async () => {
    vi.mocked(api.quote).mockResolvedValue({ ...quoteFixture, expiresAt: '2000-01-01T00:00:00.000Z' });
    await connected();
    await userEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    await screen.findByText('Quote expired');
    expect(screen.getByRole('button', { name: 'Execute quoted fill' })).toBeDisabled();
    expect(api.fill).not.toHaveBeenCalled();
  });
  it('does not reuse a quote after an uncertain fill response', async () => {
    vi.mocked(api.fill).mockRejectedValue(new ApiError('The request outcome is unknown.'));
    await connected();
    await userEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Execute quoted fill' }));
    await screen.findByText('Local backend disconnected');
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await screen.findByText('Local API connected');
    await userEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    await screen.findByRole('alert');
    expect(api.fill).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Execute quoted fill' })).not.toBeInTheDocument();
  });
  it('rejects a quote belonging to a different request', async () => {
    vi.mocked(api.quote).mockResolvedValue({ ...quoteFixture, requestedOut: '999' });
    await connected();
    await userEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Execute quoted fill' })).not.toBeInTheDocument();
  });
  it('refreshes scenario data and invalidates outstanding quotes', async () => {
    vi.mocked(api.scenario).mockResolvedValue({ ...stateFixture, collateral: { ...stateFixture.collateral, usdc: '15000.000001' } });
    await connected();
    await userEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    await screen.findByText('Partial fill available');
    await userEvent.click(screen.getByRole('button', { name: 'Withdraw USDC' }));
    expect(api.scenario).toHaveBeenCalledWith('withdraw-usdc');
    await screen.findByText('15,000.000001');
    expect(screen.queryByRole('button', { name: 'Execute quoted fill' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore demo' }));
    expect(api.scenario).toHaveBeenLastCalledWith('restore');
  });
  it('ignores an in-flight polling response after a mutation begins', async () => {
    const oldRead = deferred<MakerState>();
    const newQuote = deferred<Quote>();
    await connected();
    vi.mocked(api.state).mockReturnValueOnce(oldRead.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh state' }));
    vi.mocked(api.quote).mockReturnValueOnce(newQuote.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Get executable quote' }));
    await act(async () => oldRead.resolve({ ...stateFixture, collateral: { weth: '999', usdc: '999' } }));
    expect(screen.queryByText('999')).not.toBeInTheDocument();
    await act(async () => newQuote.resolve(quoteFixture));
    await waitFor(() => expect(screen.getByText('Partial fill available')).toBeInTheDocument());
  });
});
