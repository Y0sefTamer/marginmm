import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api, ApiError } from './api';
import type { Fill, MakerAction, MakerState } from './api';
import { connectMaker, sendMakerAction } from './wallet';
import { fillFixture, proposalFixture, quoteFixture, stateFixture } from './test/fixtures';

vi.mock('./api', async importOriginal => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    api: {
      state: vi.fn(), strategy: vi.fn(), agent: vi.fn(), policyAction: vi.fn(),
      quote: vi.fn(), fill: vi.fn(), scenario: vi.fn(), checkpoint: vi.fn(),
    },
  };
});
vi.mock('./wallet', () => ({ connectMaker: vi.fn(), sendMakerAction: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function connected() {
  render(<App />);
  await screen.findByText('Trading enabled');
}

const scenarioAction: MakerAction = {
  id: 'withdraw-usdc-scenario', chainId: '31337', from: stateFixture.makerAddress,
  to: stateFixture.contracts.aUSDC, data: '0x12345678', value: '0',
  label: 'Demo collateral drift',
};

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(api.state).mockReset().mockResolvedValue(structuredClone(stateFixture));
  vi.mocked(api.strategy).mockReset().mockResolvedValue(structuredClone(stateFixture));
  vi.mocked(api.agent).mockReset().mockResolvedValue(structuredClone(proposalFixture));
  vi.mocked(api.policyAction).mockReset().mockResolvedValue({
    ...scenarioAction, id: 'update-maker-floor', to: stateFixture.contracts.policy,
  });
  vi.mocked(api.quote).mockReset().mockResolvedValue(structuredClone(quoteFixture));
  vi.mocked(api.fill).mockReset().mockResolvedValue(structuredClone(fillFixture));
  vi.mocked(api.scenario).mockReset().mockResolvedValue(structuredClone(stateFixture));
  vi.mocked(api.checkpoint).mockReset().mockResolvedValue({ snapshotId: '0x1' });
  vi.mocked(connectMaker).mockReset().mockResolvedValue(stateFixture.makerAddress as `0x${string}`);
  vi.mocked(sendMakerAction).mockReset().mockResolvedValue(`0x${'e'.repeat(64)}`);
});

describe('MarginMM Maker console', () => {
  it('fails closed when the local API is unavailable', async () => {
    vi.mocked(api.state).mockRejectedValue(new ApiError('Backend unavailable'));
    render(<App />);
    await screen.findByText('Local backend disconnected');
    expect(screen.getByRole('button', { name: /Get executable quote/ })).toBeDisabled();
    expect(screen.queryByText('50,000.000001')).not.toBeInTheDocument();
  });

  it('renders exact Aave/Aqua balances and signed policy metadata', async () => {
    await connected();
    expect(screen.getAllByText('10.12345678').length).toBeGreaterThan(0);
    expect(screen.getAllByText('50,000.000001').length).toBeGreaterThan(0);
    expect(screen.getByText('12.40%')).toBeInTheDocument();
    expect(screen.getByText(/Policy v1, revision 1/)).toBeInTheDocument();
  });

  it('uses exact-in fields and submits one reviewed partial fill only once', async () => {
    const pending = deferred<Fill>();
    vi.mocked(api.fill).mockReturnValue(pending.promise);
    await connected();
    await userEvent.clear(screen.getByLabelText('Maximum input'));
    await userEvent.type(screen.getByLabelText('Maximum input'), '5');
    await userEvent.click(screen.getByRole('button', { name: /Get executable quote/ }));
    expect(api.quote).toHaveBeenCalledWith('weth-in', '5', '1');
    await screen.findByText('Risk-capped partial fill');
    const execute = screen.getByRole('button', { name: /Execute quoted fill/ });
    fireEvent.click(execute);
    fireEvent.click(execute);
    await waitFor(() => expect(api.fill).toHaveBeenCalledTimes(1));
    await act(async () => pending.resolve(fillFixture));
    await screen.findByText(fillFixture.transactionHash);
    expect(screen.getByText('Exact-In fill confirmed from the current onchain risk state.')).toBeInTheDocument();
  });

  it('accepts a safe final receipt recomputed from current Aave state', async () => {
    const recomputed: Fill = {
      ...fillFixture,
      actualAmountIn: '3.000000000000000001',
      finalAmountOut: '7400.000001',
      qMax: '7400.000001',
    };
    vi.mocked(api.fill).mockResolvedValue(recomputed);
    await connected();
    await userEvent.clear(screen.getByLabelText('Maximum input'));
    await userEvent.type(screen.getByLabelText('Maximum input'), '5');
    await userEvent.click(screen.getByRole('button', { name: /Get executable quote/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Execute quoted fill/ }));
    await screen.findByText(recomputed.transactionHash);
    expect(screen.getByText('Exact-In fill confirmed from the current onchain risk state.')).toBeInTheDocument();
    expect(screen.queryByText('Fill receipt does not match the reviewed quote.')).not.toBeInTheDocument();
  });

  it('rejects precision mistakes without converting financial values to numbers', async () => {
    await connected();
    await userEvent.selectOptions(screen.getByLabelText(/Direction/), 'usdc-in');
    fireEvent.change(screen.getByLabelText('Maximum input'), { target: { value: '1.0000001' } });
    expect(screen.getByRole('button', { name: /Get executable quote/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Maker hard floor/), { target: { value: '1.009' } });
    expect(screen.getByRole('button', { name: /Assess.*buy calibration/ })).toBeDisabled();
    expect(api.quote).not.toHaveBeenCalled();
  });

  it('requires explicit XYC bounds before preparing a strategy', async () => {
    const missing: MakerState = {
      ...stateFixture, ready: false,
      strategy: { state: 'missing', hash: null, priceBounds: null, aquaBalances: { weth: '0', usdc: '0' }, nextAction: null },
      stressHF: null,
      policy: {
        ...stateFixture.policy, state: 'missing', enabled: false, hardFloorStressHF: '0',
        policyVersion: 0, revision: '0', shockBps: 0, marketRegime: 0, modelVersion: 0,
        issuedAt: 0, validUntil: 0, secondsRemaining: 0,
        evidenceBlockFrom: 0, evidenceBlockTo: 0, evidenceHash: null,
      },
    };
    vi.mocked(api.state).mockResolvedValue(missing);
    vi.mocked(api.strategy).mockResolvedValue({ ...missing, strategy: {
      state: 'unshipped', hash: stateFixture.strategy.hash,
      priceBounds: { minUsdcPerWeth: '1500', maxUsdcPerWeth: '6000' },
      aquaBalances: { weth: '0', usdc: '0' }, nextAction: scenarioAction,
    } });
    render(<App />);
    await screen.findByText('Fail closed');
    expect(screen.getByRole('button', { name: 'Prepare strategy' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Minimum XYC price'), '1500');
    await userEvent.type(screen.getByLabelText('Maximum XYC price'), '6000');
    await userEvent.click(screen.getByRole('button', { name: 'Prepare strategy' }));
    expect(api.strategy).toHaveBeenCalledWith('1500', '6000');
  });

  it('shows Graph, Hedera and calibration evidence before Maker approval', async () => {
    await connected();
    await userEvent.click(screen.getByRole('button', { name: /Assess.*buy calibration/ }));
    expect(api.agent).toHaveBeenCalledWith(expect.any(String), '1.10', false);
    await screen.findByText('A fresh policy is ready for Maker review.');
    expect(screen.getByText('24')).toBeInTheDocument();
    expect(screen.getAllByText('12.40%').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/high volatility/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('25913300–25913340').length).toBeGreaterThan(0);
    expect(screen.getByText(/Evidence source: The Graph/)).toBeInTheDocument();
    expect(screen.getByText(stateFixture.policy.evidenceHash!)).toBeInTheDocument();
    expect(screen.getByText('0.0.100@4000000000.000000000')).toBeInTheDocument();
    const stateReadsBeforeApproval = vi.mocked(api.state).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Approve signed policy in Maker wallet' }));
    expect(api.state).toHaveBeenCalledTimes(stateReadsBeforeApproval + 2);
    expect(sendMakerAction).toHaveBeenCalledWith(
      stateFixture, proposalFixture.approval,
      { hardFloor: '1.10', proposal: proposalFixture },
    );
  });

  it('refreshes chain time and refuses an expired policy before filling', async () => {
    const expired: MakerState = {
      ...stateFixture,
      chain: { ...stateFixture.chain, timestamp: stateFixture.policy.validUntil + 1 },
      policy: { ...stateFixture.policy, state: 'expired', secondsRemaining: 0 },
      ready: false,
    };
    vi.mocked(api.state).mockResolvedValueOnce(structuredClone(stateFixture)).mockResolvedValue(expired);
    await connected();
    await userEvent.clear(screen.getByLabelText('Maximum input'));
    await userEvent.type(screen.getByLabelText('Maximum input'), '5');
    await userEvent.click(screen.getByRole('button', { name: /Get executable quote/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Execute quoted fill/ }));
    await screen.findByText('The policy changed or expired onchain. Request a fresh quote.');
    expect(api.fill).not.toHaveBeenCalled();
  });

  it('reuses the same paid Agent request ID after an uncertain browser response', async () => {
    vi.mocked(api.agent)
      .mockRejectedValueOnce(new Error('Agent response uncertain'))
      .mockResolvedValueOnce(structuredClone(proposalFixture));
    const first = render(<App />);
    await screen.findByText('Trading enabled');
    await userEvent.click(screen.getByRole('button', { name: /Assess.*buy calibration/ }));
    await screen.findByText('Agent response uncertain');
    const requestId = vi.mocked(api.agent).mock.calls[0][0];
    expect(JSON.parse(sessionStorage.getItem('marginmm.agent-request.v1') ?? '{}').id).toBe(requestId);

    first.unmount();
    render(<App />);
    await screen.findByText('Trading enabled');
    await userEvent.click(screen.getByRole('button', { name: /Assess.*buy calibration/ }));
    expect(vi.mocked(api.agent).mock.calls[1][0]).toBe(requestId);
    await screen.findByText('A fresh policy is ready for Maker review.');
  });

  it('routes collateral drift through the injected Maker wallet', async () => {
    vi.mocked(api.scenario).mockResolvedValue({ alreadyApplied: false, action: scenarioAction });
    await connected();
    await userEvent.click(screen.getByRole('button', { name: 'Apply collateral drift' }));
    expect(api.scenario).toHaveBeenCalledWith('withdraw-usdc');
    expect(sendMakerAction).toHaveBeenCalledWith(stateFixture, scenarioAction, {});
  });

  it('consumes a quote locally after an uncertain fill and never auto-retries', async () => {
    vi.mocked(api.fill).mockRejectedValue(new ApiError('Unknown outcome'));
    await connected();
    await userEvent.clear(screen.getByLabelText('Maximum input'));
    await userEvent.type(screen.getByLabelText('Maximum input'), '5');
    await userEvent.click(screen.getByRole('button', { name: /Get executable quote/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Execute quoted fill/ }));
    await screen.findByText('Local backend disconnected');
    expect(api.fill).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Execute quoted fill/ })).not.toBeInTheDocument();
  });
});
