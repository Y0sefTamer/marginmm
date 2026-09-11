import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { AgentProposal, Fill, MakerAction, MakerState, Quote } from './api';
import {
  amountError, compare, DEMO_FLOOR, displayDecimal as fmt, floorError, headroom,
  inputToken, meterPercent, minimumOutputError, outputToken,
} from './decimal';
import type { Direction } from './decimal';
import { connectMaker, sendMakerAction } from './wallet';

function Icon({ name, size = 20 }: { name: 'grid' | 'wallet' | 'sliders' | 'arrow' | 'activity' | 'refresh' | 'link' | 'flask'; size?: number }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    wallet: <><path d="M20 8V5H5a2 2 0 0 0 0 4h16v11H5a2 2 0 0 1-2-2V7" /><path d="M21 12h-6v5h6" /><path d="M17 14.5h1" /></>,
    sliders: <><path d="M5 3v5m0 6v7M12 3v10m0 6v2M19 3v1m0 6v11" /><circle cx="5" cy="11" r="3" /><circle cx="12" cy="16" r="3" /><circle cx="19" cy="7" r="3" /></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
    activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
    refresh: <><path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5" /></>,
    link: <><path d="M9 15 15 9m-5-3 2-2a5 5 0 0 1 7 7l-2 2m-3 5-2 2a5 5 0 0 1-7-7l2-2" /></>,
    flask: <><path d="M9 3h6m-5 0v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M7 15h10" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Token({ symbol }: { symbol: 'WETH' | 'USDC' }) {
  return <span className={`token ${symbol.toLowerCase()}`} aria-hidden="true">{symbol === 'WETH' ? 'Ξ' : '$'}</span>;
}

function fingerprint(state: MakerState) {
  return JSON.stringify([
    state.blockNumber, state.collateral, state.debt, state.currentHF, state.stressHF,
    state.strategy.state, state.strategy.hash, state.policy,
  ]);
}

function bps(value: number) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}%`;
}

function regime(value: number | undefined) {
  return value === 1 ? 'low volatility' : value === 2 ? 'high volatility' : value === 3 ? 'extreme volatility' : '—';
}

type PendingAgentRequest = { id: string; hardFloor: string; forceRefresh: boolean };
const AGENT_REQUEST_STORAGE = 'marginmm.agent-request.v1';

function loadAgentRequest(): PendingAgentRequest | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(AGENT_REQUEST_STORAGE) ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const request = value as Record<string, unknown>;
    if (Object.keys(request).length !== 3
      || typeof request.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.id)
      || typeof request.hardFloor !== 'string' || floorError(request.hardFloor)
      || typeof request.forceRefresh !== 'boolean') throw new Error('Invalid stored Agent request');
    return request as PendingAgentRequest;
  } catch {
    try { sessionStorage.removeItem(AGENT_REQUEST_STORAGE); } catch { /* unavailable storage */ }
    return null;
  }
}

function storeAgentRequest(request: PendingAgentRequest | null) {
  try {
    if (request) sessionStorage.setItem(AGENT_REQUEST_STORAGE, JSON.stringify(request));
    else sessionStorage.removeItem(AGENT_REQUEST_STORAGE);
  } catch { /* the backend journal remains authoritative when storage is unavailable */ }
}

export default function App() {
  const agentRequest = useRef<PendingAgentRequest | null>(loadAgentRequest());
  const [state, setState] = useState<MakerState | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [connectionError, setConnectionError] = useState('');
  const [wallet, setWallet] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [direction, setDirection] = useState<Direction>('weth-in');
  const [maxInput, setMaxInput] = useState('0.01');
  const [minimumOutput, setMinimumOutput] = useState('1');
  const [floor, setFloor] = useState(agentRequest.current?.hardFloor ?? DEMO_FLOOR);
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);
  const [now, setNow] = useState(Date.now());
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const latestState = useRef<MakerState | null>(null);
  const readController = useRef<AbortController | null>(null);
  const usedQuotes = useRef(new Set<string>());
  const floorWasEdited = useRef(false);

  const acceptState = useCallback((next: MakerState) => {
    if (!mounted.current) return;
    if (latestState.current && fingerprint(latestState.current) !== fingerprint(next)) setQuote(null);
    if (proposal && proposal.approval && next.policy.policyVersion >= (proposal.calibration?.policyVersion ?? 0)) {
      agentRequest.current = null;
      storeAgentRequest(null);
      setProposal(null);
    }
    latestState.current = next;
    setState(next);
    setConnection('connected');
    setConnectionError('');
    setUpdatedAt(Date.now());
    if (!floorWasEdited.current && next.policy.hardFloorStressHF !== '0') setFloor(next.policy.hardFloorStressHF);
  }, [proposal]);

  const disconnect = useCallback((message: string) => {
    setConnection('disconnected');
    setConnectionError(message);
    latestState.current = null;
    setState(null);
    setQuote(null);
  }, []);

  const refresh = useCallback(async () => {
    if (lock.current || readController.current) return;
    const controller = new AbortController();
    readController.current = controller;
    try {
      const next = await api.state(controller.signal);
      if (!controller.signal.aborted) acceptState(next);
    } catch (error) {
      if (!controller.signal.aborted) disconnect(error instanceof Error ? error.message : 'Local API unavailable.');
    } finally {
      if (readController.current === controller) readController.current = null;
    }
  }, [acceptState, disconnect]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const polling = setInterval(() => { void refresh(); }, 5_000);
    const ticking = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      mounted.current = false;
      clearInterval(polling);
      clearInterval(ticking);
      readController.current?.abort();
    };
  }, [refresh]);

  async function perform(label: string, action: () => Promise<void>) {
    if (lock.current || !latestState.current) return;
    lock.current = true;
    readController.current?.abort();
    readController.current = null;
    setBusy(label);
    setNotice(null);
    try { await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'The request failed.';
      setQuote(null);
      setNotice({ text: message, error: true });
      if (error instanceof ApiError && ['UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.code)) disconnect(message);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function connect() {
    const current = latestState.current;
    if (!current) return;
    await perform('Connecting wallet', async () => {
      const account = await connectMaker(current.makerAddress);
      setWallet(account);
      setNotice({ text: 'Maker wallet connected to local chain 31337.', error: false });
    });
  }

  async function confirmMakerAction(current: MakerState, action: MakerAction, expected: { hardFloor?: string; proposal?: AgentProposal }) {
    const hash = await sendMakerAction(current, action, expected);
    setWallet(current.makerAddress);
    setQuote(null);
    const next = await api.state();
    acceptState(next);
    setNotice({ text: `${action.label} confirmed: ${hash.slice(0, 10)}…`, error: false });
  }

  async function submitMakerAction(action: MakerAction, label: string, expected: { hardFloor?: string; proposal?: AgentProposal } = {}) {
    const current = latestState.current;
    if (!current) return;
    await perform(label, async () => {
      const fresh = action.id === 'approve-market-policy' ? await api.state() : current;
      if (action.id === 'approve-market-policy'
        && (!expected.proposal?.calibration
          || fresh.chain.timestamp > expected.proposal.calibration.validUntil)) {
        throw new Error('The calibration expired on the local chain. Run the Agent again.');
      }
      await confirmMakerAction(fresh, action, expected);
    });
  }

  async function createStrategy() {
    await perform('Creating strategy', async () => {
      if (!minPrice || !maxPrice) throw new Error('Enter both XYC price bounds explicitly.');
      const next = await api.strategy(minPrice, maxPrice);
      acceptState(next);
      setNotice({ text: 'Immutable XYC strategy prepared. Complete the wallet actions to ship it.', error: false });
    });
  }

  async function runAgent(forceRefresh: boolean) {
    if (floorError(floor)) return;
    await perform('Running risk agent', async () => {
      setProposal(null);
      const pending = agentRequest.current;
      if (pending && (pending.hardFloor !== floor || pending.forceRefresh !== forceRefresh)) {
        throw new Error('Resolve the existing paid Agent request before changing its inputs.');
      }
      const request = pending ?? { id: crypto.randomUUID(), hardFloor: floor, forceRefresh };
      agentRequest.current = request;
      storeAgentRequest(request);
      const next = await api.agent(request.id, floor, forceRefresh);
      if (next.decision === 'no_refresh') {
        agentRequest.current = null;
        storeAgentRequest(null);
      }
      setProposal(next);
      setNotice({
        text: next.decision === 'proposal_ready'
          ? 'Paid calibration verified. Review the evidence, then approve with the Maker wallet.'
          : 'The deterministic policy check found no refresh requirement.',
        error: false,
      });
    });
  }

  async function updateFloor() {
    if (floorError(floor)) return;
    const current = latestState.current;
    if (!current) return;
    await perform('Updating Maker floor', async () => {
      const action = await api.policyAction(floor);
      await confirmMakerAction(current, action, { hardFloor: floor });
      floorWasEdited.current = false;
    });
  }

  async function getQuote() {
    if (amountError(maxInput, direction) || minimumOutputError(minimumOutput, direction)) return;
    await perform('Quoting', async () => {
      setQuote(null);
      const next = await api.quote(direction, maxInput, minimumOutput);
      if (next.direction !== direction || compare(next.requestedAmountIn, maxInput) !== 0
        || usedQuotes.current.has(next.quoteId)) throw new ApiError('Quote context mismatch.', 'INVALID_RESPONSE');
      setQuote(next);
      if (next.status === 'rejected') setNotice({ text: next.reason ?? 'Quote rejected.', error: true });
    });
  }

  async function fillQuote() {
    const active = quote;
    const current = latestState.current;
    if (!active || !current || active.status !== 'ready' || Date.parse(active.expiresAt) <= Date.now()
      || usedQuotes.current.has(active.quoteId)) return;
    await perform('Executing fill', async () => {
      const fresh = await api.state();
      if (!fresh.ready || fresh.chain.timestamp > active.policyValidUntil
        || fresh.policy.policyVersion !== active.policyVersion
        || fresh.policy.revision !== active.policyRevision) {
        throw new ApiError('The policy changed or expired onchain. Request a fresh quote.', 'STALE_QUOTE');
      }
      usedQuotes.current.add(active.quoteId);
      setQuote(null);
      const result = await api.fill(active.quoteId);
      if (result.direction !== active.direction
        || compare(result.requestedAmountIn, active.requestedAmountIn) !== 0
        || compare(result.actualAmountIn, result.requestedAmountIn) > 0
        || result.policyVersion !== active.policyVersion || result.shockBps !== active.shockBps
        || result.chainId !== fresh.chain.id
        || (result.stressHFAfter !== null
          && compare(result.stressHFAfter, fresh.policy.hardFloorStressHF) < 0)) {
        throw new ApiError('Fill receipt does not match the reviewed quote.', 'INVALID_RESPONSE');
      }
      setFills(previous => [result, ...previous].slice(0, 8));
      acceptState(await api.state());
      setNotice({ text: 'Exact-In fill confirmed from the current onchain risk state.', error: false });
    });
  }

  async function scenario(action: 'withdraw-usdc' | 'restore') {
    if (action === 'restore') {
      await perform('Restoring checkpoint', async () => {
        const result = await api.scenario('restore');
        if (!('ready' in result)) throw new ApiError('Restore response mismatch.', 'INVALID_RESPONSE');
        acceptState(result);
        setNotice({ text: 'Local demo restored to its saved checkpoint.', error: false });
      });
      return;
    }
    const current = latestState.current;
    if (!current) return;
    await perform('Applying collateral drift', async () => {
      const result = await api.scenario('withdraw-usdc');
      if ('ready' in result) throw new ApiError('Scenario response mismatch.', 'INVALID_RESPONSE');
      if (result.alreadyApplied || !result.action) {
        setNotice({ text: 'The collateral drift scenario is already applied.', error: false });
        return;
      }
      await confirmMakerAction(current, result.action, {});
    });
  }

  async function checkpoint() {
    await perform('Saving checkpoint', async () => {
      await api.checkpoint();
      setNotice({ text: 'Ready-state checkpoint saved for the Restore demo button.', error: false });
    });
  }

  const connected = connection === 'connected' && state !== null;
  const disabled = !connected || busy !== null;
  const walletConnected = Boolean(state && wallet?.toLowerCase() === state.makerAddress.toLowerCase());
  const inputError = amountError(maxInput, direction);
  const outputError = minimumOutputError(minimumOutput, direction);
  const policyError = floorError(floor);
  const floorEquals = (value: string) => !policyError && compare(floor, value) === 0;
  const quoteExpired = quote ? Date.parse(quote.expiresAt) <= now : false;
  const hardFloor = state?.policy.hardFloorStressHF === '0' ? DEMO_FLOOR : state?.policy.hardFloorStressHF;
  const belowFloor = state?.stressHF != null && hardFloor != null && compare(state.stressHF, hardFloor) < 0;
  const health = (value: string | null | undefined) => connected && value === null ? 'Not active' : fmt(value, 2, 4);

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#overview" aria-label="MarginMM home"><span className="brand-mark">M</span><span>margin<span className="brand-light">mm</span><small>MAKER CONSOLE</small></span></a>
      <div className="workspace-label">WORKSPACE <span>MVP</span></div>
      <nav aria-label="Dashboard sections">
        <a className="nav-link active" href="#overview"><Icon name="grid" />Overview<span className="nav-dot" /></a>
        <a className="nav-link" href="#setup"><Icon name="wallet" />Maker setup</a>
        <a className="nav-link" href="#policy"><Icon name="sliders" />Risk policy</a>
        <a className="nav-link" href="#activity"><Icon name="activity" />Execution evidence</a>
      </nav>
      <div className="sidebar-bottom"><div className="fork-card"><Icon name="flask" /><strong>Real protocols, isolated funds</strong><p>Aave + Aqua/SwapVM on a pinned local mainnet fork.</p><span className="tiny-badge">CHAIN 31337</span></div><div className="sidebar-footer"><span className="status-dot" />MarginMM / MVP <span>v0.2</span></div></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>Maker console</strong></div><div className="topbar-right"><span className="network-pill"><span className="network-icon">◇</span>Mainnet fork</span><button className="button small" onClick={() => void connect()} disabled={disabled}>{walletConnected ? 'Maker connected' : 'Connect Maker wallet'}</button></div></header>
      <main id="overview">
        <div className="page-heading"><div><div className="eyebrow">COLLATERAL-AWARE MARKET MAKING</div><h1>Liquidity bounded by live risk.</h1><p>Graph evidence → paid calibration → Maker approval → atomic qMax execution.</p></div><button className="button subtle refresh-button" onClick={() => void refresh()} disabled={busy !== null}><Icon name="refresh" size={16} />Refresh state</button></div>

        {connection !== 'connected' && <div className={`connection-banner ${connection === 'disconnected' ? 'warning' : ''}`} role="status"><Icon name="link" /><div><strong>{connection === 'connecting' ? 'Connecting to the local MVP' : 'Local backend disconnected'}</strong><p>{connection === 'connecting' ? 'Waiting for a verified fork response.' : connectionError}</p></div></div>}
        {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}

        <section className="overview-grid" aria-label="Position health">
          <div className="health-card"><div className="card-heading"><span className="eyebrow">POSITION HEALTH</span><span className={`health-tag ${belowFloor ? 'below' : ''}`}>{state?.ready ? 'Trading enabled' : 'Fail closed'}</span></div><div className="health-values"><div><span className="metric-label">Current HF</span><strong className="health-number">{health(state?.currentHF)}</strong><span className="health-caption">Aave account health</span></div><div><span className="metric-label">StressHF <span className="stress-indicator">↘</span></span><strong className={`health-number accent ${belowFloor ? 'danger-text' : ''}`}>{health(state?.stressHF)}</strong><span className="health-caption">WETH shocked; USDC unchanged</span></div></div><div className="health-meter"><div className="meter-track"><span className="meter-progress" style={{ width: `${meterPercent(state?.stressHF)}%` }} />{hardFloor && <span className="meter-marker" style={{ left: `${meterPercent(hardFloor)}%` }} />}</div><div className="meter-labels"><span>0.00</span><span>Maker floor {fmt(hardFloor, 2)}</span><span>2.00+</span></div></div><div className="health-footnote"><span className="outline-dot" />{state?.stressHF && hardFloor ? `${fmt(headroom(state.stressHF, hardFloor), 0, 6)} StressHF headroom` : 'No active signed policy: MarginMM fills are rejected'}</div></div>
          <div className="policy-summary"><div className="card-heading"><span className="eyebrow">MARKET POLICY</span><Icon name="sliders" /></div><div className="policy-value">{state?.policy.shockBps ? bps(state.policy.shockBps) : '—'}<span>WETH downside shock</span></div><p>Status: <strong>{state?.policy.state ?? 'unavailable'}</strong>. Policy v{state?.policy.policyVersion ?? 0}, revision {state?.policy.revision ?? '0'}.</p><p>Regime: <strong>{regime(state?.policy.marketRegime)}</strong> · Model v{state?.policy.modelVersion ?? 0}</p><p>Chain window: {state?.policy.issuedAt ?? 0}–{state?.policy.validUntil ?? 0}</p><p>Evidence source: The Graph · blocks {state?.policy.evidenceBlockFrom ?? 0}–{state?.policy.evidenceBlockTo ?? 0}</p><p>Evidence hash: <code>{state?.policy.evidenceHash ?? '—'}</code></p><div className="policy-minimum">Demo policy = minimum StressHF <strong>{fmt(hardFloor, 2)}</strong></div></div>
        </section>

        <section id="setup" className="panel" aria-labelledby="setup-title"><div className="panel-heading"><div><div className="eyebrow">MAKER ONBOARDING</div><h2 id="setup-title">Immutable Aqua strategy</h2></div><span className="tiny-badge">{state?.strategy.state ?? 'WAITING'}</span></div>
          {state?.strategy.state === 'missing' ? <div><p className="panel-description">Choose explicit XYC bounds in USDC per WETH. No hidden price default is used.</p><div className="policy-input-row"><input aria-label="Minimum XYC price" placeholder="Minimum, e.g. 1500" value={minPrice} onChange={event => setMinPrice(event.target.value)} disabled={disabled} /><input aria-label="Maximum XYC price" placeholder="Maximum, e.g. 6000" value={maxPrice} onChange={event => setMaxPrice(event.target.value)} disabled={disabled} /><button className="button dark" onClick={() => void createStrategy()} disabled={disabled || !minPrice || !maxPrice}>Prepare strategy</button></div></div> : <div><p className="panel-description">Bounds: {state?.strategy.priceBounds?.minUsdcPerWeth}–{state?.strategy.priceBounds?.maxUsdcPerWeth} USDC/WETH. Strategy <code>{state?.strategy.hash}</code></p>{state?.strategy.nextAction ? <button className="button primary" disabled={disabled} onClick={() => void submitMakerAction(state.strategy.nextAction as MakerAction, 'Maker approval')}>{state.strategy.nextAction.label}</button> : <span className="health-tag">Aqua strategy {state?.strategy.state}</span>}</div>}
        </section>

        <section id="position" className="position-section"><div className="section-heading"><h2>Live Aave position</h2><span className="meta-text">Block {state ? fmt(state.blockNumber) : '—'} · fork block {state?.chain.forkBlock ?? '—'}</span></div><div className="balance-grid"><article className="balance-card"><div className="balance-label"><Token symbol="WETH" /><span>WETH collateral</span><span className="balance-type">SUPPLIED</span></div><div className="balance-amount">{fmt(state?.collateral.weth, 4, 8)} <small>WETH</small></div><div className="balance-footer">Aqua virtual balance <strong>{fmt(state?.strategy.aquaBalances.weth, 4, 8)}</strong></div></article><article className="balance-card"><div className="balance-label"><Token symbol="USDC" /><span>USDC collateral</span><span className="balance-type">SUPPLIED</span></div><div className="balance-amount">{fmt(state?.collateral.usdc, 2, 6)} <small>USDC</small></div><div className="balance-footer">Aqua virtual balance <strong>{fmt(state?.strategy.aquaBalances.usdc, 2, 6)}</strong></div></article><article className="balance-card debt-card"><div className="balance-label"><Token symbol="USDC" /><span>USDC debt</span><span className="balance-type">BORROWED</span></div><div className="balance-amount">{fmt(state?.debt.usdc, 2, 6)} <small>USDC</small></div><div className="balance-footer"><span className="amber-dot" />Current Aave oracle valuation</div></article></div></section>

        <div className="workspace-grid">
          <section id="policy" className="panel"><div className="panel-heading"><div><div className="eyebrow">LIVE EVIDENCE + X402</div><h2>Risk Agent proposal</h2></div><Icon name="sliders" /></div><p className="panel-description">The Agent can read evidence and buy one deterministic calibration. It cannot sign Ethereum actions.</p><div className="floor-presets">{[['1.10', 'Demo default'], ['1.20', 'More headroom'], ['1.30', 'Higher floor']].map(([value, label]) => <button type="button" className={`floor-preset ${floorEquals(value) ? 'selected' : ''}`} key={value} disabled={disabled} onClick={() => { floorWasEdited.current = true; setFloor(value); }}><strong>{value}</strong><span>{label}</span></button>)}</div><label className="field-label" htmlFor="floor">Maker hard floor <span>Allowed 1.01–3.00; 1.10 is the demo policy</span></label><div className="policy-input-row"><input id="floor" value={floor} inputMode="decimal" onChange={event => { floorWasEdited.current = true; setFloor(event.target.value); }} disabled={disabled} /><button className="button primary" disabled={disabled || Boolean(policyError) || state?.strategy.state !== 'active'} onClick={() => void runAgent(false)}>{busy === 'Running risk agent' ? 'Agent running…' : 'Assess / buy calibration'}</button>{state && !policyError && ['valid', 'expiring'].includes(state.policy.state) && compare(floor, state.policy.hardFloorStressHF) !== 0 && <button className="button dark" disabled={disabled} onClick={() => void updateFloor()}>Update floor only</button>}</div><p className={policyError ? 'field-error' : 'field-help'}>{policyError ?? 'Changing the Maker floor does not alter the signed market shock.'}</p>
            {proposal && <div className="quote-result"><div className="result-heading"><strong>{proposal.headline}</strong><span>{proposal.decision}</span></div>{proposal.rationale.map(item => <p key={item} className="field-help">{item}</p>)}{proposal.calibration && proposal.paymentReceipt && proposal.graphEvidence && <dl className="quote-details"><div><dt>Graph observations</dt><dd>{proposal.graphEvidence.observationCount}</dd></div><div><dt>Calibrated WETH shock</dt><dd>{bps(proposal.calibration.shockBps)}</dd></div><div><dt>Market regime / model</dt><dd>{regime(proposal.calibration.marketRegime)} / v{proposal.calibration.modelVersion}</dd></div><div><dt>Evidence blocks</dt><dd>{proposal.calibration.evidenceBlockFrom}–{proposal.calibration.evidenceBlockTo}</dd></div><div><dt>Policy chain window</dt><dd>{proposal.calibration.issuedAt}–{proposal.calibration.validUntil}</dd></div><div><dt>Policy TTL</dt><dd>{proposal.calibration.validUntil - proposal.calibration.issuedAt}s</dd></div><div><dt>Hedera receipt</dt><dd><code>{proposal.paymentReceipt.transaction}</code></dd></div><div><dt>Evidence hash</dt><dd><code>{proposal.calibration.evidenceHash}</code></dd></div></dl>}{proposal.approval && <button className="button primary full-width" disabled={disabled} onClick={() => void submitMakerAction(proposal.approval as MakerAction, 'Approving MarketPolicy', { hardFloor: floor, proposal })}>Approve signed policy in Maker wallet</button>}</div>}
          </section>

          <section className="panel quote-panel"><div className="panel-heading"><div><div className="eyebrow">EXACT-IN EXECUTION</div><h2>Quote and fill</h2></div><span className="tiny-badge">qMax FINAL CHECK</span></div><form onSubmit={event => { event.preventDefault(); void getQuote(); }}><label className="field-label" htmlFor="direction">Direction <span>Incoming collateral → outgoing collateral</span></label><div className="direction-control"><select id="direction" value={direction} disabled={disabled} onChange={event => { setDirection(event.target.value as Direction); setQuote(null); }}><option value="weth-in">aWETH in → aUSDC out</option><option value="usdc-in">aUSDC in → aWETH out</option></select></div><label className="field-label" htmlFor="max-input">Maximum input</label><div className="amount-input"><input id="max-input" value={maxInput} inputMode="decimal" onChange={event => { setMaxInput(event.target.value); setQuote(null); }} disabled={disabled} /><span>{inputToken(direction)}</span></div><p className={inputError ? 'field-error' : 'field-help'}>{inputError ?? 'Risk capping may reduce actual input below this maximum.'}</p><label className="field-label" htmlFor="min-output">Minimum output protection</label><div className="amount-input"><input id="min-output" value={minimumOutput} inputMode="decimal" onChange={event => { setMinimumOutput(event.target.value); setQuote(null); }} disabled={disabled} /><span>{outputToken(direction)}</span></div><p className={outputError ? 'field-error' : 'field-help'}>{outputError ?? 'The quote/fill is rejected if final output falls below this value.'}</p><button className="button primary full-width" type="submit" disabled={disabled || !state?.ready || Boolean(inputError) || Boolean(outputError)}>Get executable quote <Icon name="arrow" size={18} /></button></form>
            <div className={`quote-result ${quote?.status === 'rejected' ? 'rejected' : ''}`} aria-live="polite">{quote ? <><div className="result-heading"><strong>{quote.status === 'rejected' ? 'Quote rejected' : quote.partialFill ? 'Risk-capped partial fill' : 'Full exact-in fill'}</strong><span>{quoteExpired ? 'expired' : `${Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - now) / 1_000))}s`}</span></div><dl className="quote-details"><div><dt>Requested / actual input</dt><dd>{fmt(quote.requestedAmountIn)} / {fmt(quote.actualAmountIn)} {inputToken(direction)}</dd></div><div><dt>Base / final output</dt><dd>{fmt(quote.baseAmountOut)} / <strong>{fmt(quote.finalAmountOut)}</strong> {outputToken(direction)}</dd></div><div><dt>qMax</dt><dd>{fmt(quote.qMax)} {outputToken(direction)}</dd></div><div><dt>StressHF before / after</dt><dd>{health(quote.stressHFBefore)} / {health(quote.stressHFAfter)}</dd></div><div><dt>Policy binding</dt><dd>v{quote.policyVersion} · r{quote.policyRevision}</dd></div></dl>{quote.reason && <p className="field-error">{quote.reason}</p>}<button className="button primary full-width" disabled={disabled || quote.status !== 'ready' || quoteExpired} onClick={() => void fillQuote()}>Execute quoted fill <Icon name="arrow" size={18} /></button></> : <div className="quote-empty"><Icon name="activity" /><div><strong>No quote yet</strong><p>Final output is recomputed from current Aave state and the active signed shock.</p></div></div>}</div>
          </section>
        </div>

        <section className="panel scenario-panel"><div className="panel-heading"><div><div className="eyebrow">DEMO CONTROL</div><h2>Collateral drift and recovery</h2></div><span className="flask-icon"><Icon name="flask" /></span></div><p className="panel-description">Save a ready checkpoint, then transfer 5,000 aUSDC using the Maker wallet and observe StressHF/qMax rejection.</p><div className="scenario-buttons"><button className="button subtle" disabled={disabled || !state?.ready} onClick={() => void checkpoint()}>Save ready checkpoint</button><button className="button scenario-withdraw" disabled={disabled || !state?.ready} onClick={() => void scenario('withdraw-usdc')}>Apply collateral drift</button><button className="button subtle" disabled={disabled} onClick={() => void scenario('restore')}><Icon name="refresh" size={15} />Restore checkpoint</button></div></section>

        <section id="activity" className="panel activity-panel"><div className="panel-heading"><div><h2>Onchain execution evidence</h2><p className="panel-description">`MarginRiskEvaluated` receipts from this browser session</p></div><span className="tiny-badge">{fills.length} FILLS</span></div>{fills.length === 0 ? <div className="activity-empty"><Icon name="activity" /><div><strong>No fills yet</strong><p>Confirmed exact-in fills appear here.</p></div></div> : <div className="table-scroll"><table><thead><tr><th>Direction / policy</th><th>Requested / actual input</th><th>Base / final output</th><th>StressHF after</th><th>Transaction</th></tr></thead><tbody>{fills.map(fill => <tr key={fill.quoteId}><td><strong>{fill.direction === 'weth-in' ? 'aWETH → aUSDC' : 'aUSDC → aWETH'}</strong><small>Policy v{fill.policyVersion} · {bps(fill.shockBps)}</small></td><td>{fmt(fill.requestedAmountIn)} / {fmt(fill.actualAmountIn)}</td><td>{fmt(fill.baseAmountOut)} / {fmt(fill.finalAmountOut)}</td><td>{health(fill.stressHFAfter)}</td><td><code className="transaction-hash">{fill.transactionHash}</code></td></tr>)}</tbody></table></div>}</section>

        <footer className="page-footer"><div><span className={`status-dot ${connected ? 'live' : ''}`} />{state ? `${state.chain.name} · Chain ${state.chain.id}` : 'Local chain unavailable'}<span className="footer-divider">/</span>{walletConnected ? 'Maker wallet connected' : 'Maker signature required'}</div><span>{updatedAt && connected ? `Updated ${Math.max(0, Math.floor((now - updatedAt) / 1_000))}s ago` : 'No live state'}</span></footer>
        {state && <div className="maker-address">Maker <code>{state.makerAddress}</code></div>}
      </main>
    </div>
  </div>;
}
