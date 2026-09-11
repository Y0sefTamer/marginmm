import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { Fill, MakerState, Quote } from './api';
import { amountError, compare, DEMO_FLOOR, displayDecimal as fmt, floorError, headroom, meterPercent, outputToken } from './decimal';
import type { Direction } from './decimal';

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

function stateFingerprint(state: MakerState) {
  return JSON.stringify([state.makerAddress, state.chain, state.collateral, state.debt, state.currentHF, state.stressHF, state.riskFloor, state.qMax]);
}

export default function App() {
  const [state, setState] = useState<MakerState | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>('weth-in');
  const [amount, setAmount] = useState('1000');
  const [floor, setFloor] = useState(DEMO_FLOOR);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const lock = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const latestState = useRef<MakerState | null>(null);
  const dirtyFloor = useRef(false);
  const usedQuotes = useRef(new Set<string>());
  const mounted = useRef(true);

  const acceptState = useCallback((next: MakerState) => {
    if (!mounted.current) return;
    if (latestState.current && stateFingerprint(latestState.current) !== stateFingerprint(next)) setQuote(null);
    latestState.current = next;
    setState(next);
    setConnection('connected');
    setConnectionError('');
    setUpdatedAt(Date.now());
    if (!dirtyFloor.current) setFloor(next.riskFloor);
  }, []);

  const disconnect = useCallback((message: string) => {
    setConnection('disconnected');
    setConnectionError(message);
    setState(null);
    setQuote(null);
    latestState.current = null;
  }, []);

  const refresh = useCallback(async () => {
    if (lock.current || readController.current) return;
    const controller = new AbortController();
    readController.current = controller;
    try {
      const next = await api.state(controller.signal);
      if (!controller.signal.aborted && mounted.current) acceptState(next);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) disconnect(error instanceof Error ? error.message : 'Local API unavailable.');
    } finally {
      if (readController.current === controller) readController.current = null;
    }
  }, [acceptState, disconnect]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const polling = setInterval(() => { void refresh(); }, 5000);
    const ticking = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(polling);
      clearInterval(ticking);
      readController.current?.abort();
      readController.current = null;
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

  const connected = connection === 'connected' && state !== null;
  const disabled = !connected || busy !== null;
  const tokenOut = outputToken(direction);
  const validation = amountError(amount, direction);
  const policyValidation = floorError(floor);
  const expired = quote ? Date.parse(quote.expiresAt) <= now : false;
  const belowFloor = state?.stressHF != null && compare(state.stressHF, state.riskFloor) < 0;
  const capacity = state?.qMax[direction === 'weth-in' ? 'usdc' : 'weth'];
  const hf = (value: string | null | undefined) => connected && value === null ? 'No debt' : fmt(value, 2, 4);

  async function getQuote() {
    if (validation) return;
    const snapshot = latestState.current;
    if (!snapshot) return;
    await perform('Quoting', async () => {
      setQuote(null);
      const next = await api.quote(direction, amount);
      if (next.direction !== direction || compare(next.requestedOut, amount) !== 0 || compare(next.riskFloor, snapshot.riskFloor) !== 0 || usedQuotes.current.has(next.quoteId)) {
        throw new ApiError('The quote does not match this request. Refresh state and request a new quote.', 'INVALID_RESPONSE');
      }
      setQuote(next);
      setNow(Date.now());
      if (next.status === 'rejected') setNotice({ text: next.reason ?? 'The backend rejected this quote under the active policy.', error: true });
    });
  }

  async function fillQuote() {
    const active = quote;
    const snapshot = latestState.current;
    if (!active || !snapshot || active.status !== 'ready' || Date.parse(active.expiresAt) <= Date.now() || usedQuotes.current.has(active.quoteId)) return;
    await perform('Executing', async () => {
      // Consume locally before the request. An uncertain response must never auto-resubmit.
      usedQuotes.current.add(active.quoteId);
      setQuote(null);
      const result = await api.fill(active.quoteId);
      if (result.quoteId !== active.quoteId || result.direction !== active.direction || compare(result.requestedOut, active.requestedOut) !== 0 || compare(result.executedOut, active.executableOut) > 0 || result.chainId !== snapshot.chain.id) {
        throw new ApiError('The fill receipt does not match the quote. Verify local chain state before continuing.', 'INVALID_RESPONSE');
      }
      setFills(previous => [result, ...previous].slice(0, 8));
      setNotice({ text: result.status === 'filled' ? 'Fill confirmed by the local backend. Position refreshed below.' : result.reason ?? 'Fill rejected. No output was executed.', error: result.status !== 'filled' });
      acceptState(await api.state());
    });
  }

  async function updatePolicy() {
    if (policyValidation) return;
    await perform('Updating policy', async () => {
      setQuote(null);
      const next = await api.policy(floor);
      dirtyFloor.current = false;
      acceptState(next);
      setNotice({ text: `Policy applied. Minimum StressHF ${fmt(next.riskFloor, 2)}. Request a new quote to use the updated capacity.`, error: false });
    });
  }

  async function scenario(action: 'withdraw-usdc' | 'restore') {
    await perform(action === 'restore' ? 'Restoring' : 'Withdrawing', async () => {
      setQuote(null);
      acceptState(await api.scenario(action));
      setNotice({ text: action === 'restore' ? 'Demo position restored. Live capacity has been refreshed.' : 'USDC withdrawal scenario completed. Review the updated stress factor and capacity.', error: false });
    });
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#overview" aria-label="MarginMM home"><span className="brand-mark">M</span><span>margin<span className="brand-light">mm</span><small style ={{"fontSize": "12px"}}>MAKER CONSOLE</small></span></a>
      <div className="workspace-label" style ={{"fontSize": "14px"}}>WORKSPACE <span style ={{"fontSize": "12px"}}>MVP</span></div>
      <nav aria-label="Dashboard sections">
        <a className="nav-link active" href="#overview" style ={{"fontSize": "14px"}}><Icon name="grid" />Overview<span className="nav-dot" /></a>
        <a className="nav-link" href="#position" style ={{"fontSize": "14px"}}><Icon name="wallet" />Position</a>
        <a className="nav-link" href="#policy" style ={{"fontSize": "14px"}}><Icon name="sliders" />Risk policy</a>
        <a className="nav-link" href="#activity" style ={{"fontSize": "14px"}}><Icon name="activity" />Execution activity</a>
      </nav>
      <div className="sidebar-bottom"><div className="fork-card"><Icon name="flask" /><strong style ={{"fontSize": "14px"}}>A local proving ground</strong><p style ={{"fontSize": "12px"}}>Explore how collateral and policy shape executable liquidity.</p><span className="tiny-badge" style ={{"fontSize": "12px"}}>MAINNET FORK</span></div><div className="sidebar-footer" style ={{"fontSize": "14px"}}><span className="status-dot"  />MarginMM / MVP <span>v0.1</span></div></div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb" style = {{"fontSize": "14px"}}>Workspace <span>/</span> <strong>Overview</strong></div><div className="topbar-right"><span className="network-pill" style ={{"fontSize": "14px"}}><span className="network-icon">◇</span>Mainnet fork</span><span className={`connection-pill ${connected ? 'online' : ''}`} style ={{"fontSize": "14px"}}><span className="status-dot" />{connection === 'connecting' ? 'Connecting' : connected ? 'Local API connected' : 'Disconnected'}</span></div></header>
      <main id="overview">
        <div className="page-heading"><div><div className="eyebrow">COLLATERAL-AWARE MARKET MAKING</div><h1>Your liquidity, within limits.</h1><p style = {{"fontSize": '18px'}}>Manage your position. Set your stress floor. Review every fill.</p></div><button className="button subtle refresh-button" onClick={() => void refresh()} disabled={busy !== null} style = {{"fontSize": "14px"}}><Icon name="refresh" size={20} />Refresh state</button></div>

        {connection !== 'connected' && <div className={`connection-banner ${connection === 'disconnected' ? 'warning' : ''}`} style ={{"fontSize": "14px"}} role="status"><Icon name="link" /><div><strong style ={{"fontSize": "14px"}}>{connection === 'connecting' ? 'Connecting to your local environment' : 'Local backend disconnected'}</strong><p style ={{"fontSize": "14px"}}>{connection === 'connecting' ? 'Waiting for live position data. Actions will unlock after a valid response.' : connectionError}</p></div>{connection === 'disconnected' && <button className="button small" style ={{"fontSize": "14px"}} onClick={() => void refresh()}>Reconnect</button>}</div>}
        {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}

        <section className="overview-grid" aria-label="Position health">
          <div className="health-card">
            <div className="card-heading"><span className="eyebrow" style ={{"fontSize": "14px"}}>POSITION HEALTH</span><span className={`health-tag ${belowFloor ? 'below' : ''}`} style ={{"fontSize": "12px"}}>{!connected ? 'Awaiting data' : belowFloor ? 'Below policy floor' : 'Live snapshot'}</span></div>
            <div className="health-values"><div><span className="metric-label" style ={{"fontSize": "14px"}}>Current HF</span><strong className="health-number">{hf(state?.currentHF)}</strong><span className="health-caption" style ={{"fontSize": "12px"}}>Aave account health</span></div><div><span className="metric-label" style ={{"fontSize": "14px"}}>StressHF <span className="stress-indicator">↘</span></span><strong className={`health-number accent ${belowFloor ? 'danger-text' : ''}`}>{hf(state?.stressHF)}</strong><span className="health-caption" style ={{"fontSize": "12px"}}>Under configured stress</span></div></div>
            <div className="health-meter" aria-label="Stress health factor scale, capped at 2"><div className="meter-track"><span className="meter-progress" style={{ width: `${meterPercent(state?.stressHF)}%` }} />{state && <span className="meter-marker" style={{ left: `${meterPercent(state.riskFloor)}%` }} />}</div><div className="meter-labels"><span style ={{"fontSize": "12px"}}>0.00</span><span style ={{"fontSize": "12px"}}>Policy floor {fmt(state?.riskFloor, 2)}</span><span style ={{"fontSize": "12px"}}>2.00+</span></div></div>
            <div className="health-footnote" style ={{"fontSize": "12px"}}><span className="outline-dot" />{state?.stressHF != null ? `${fmt(headroom(state.stressHF, state.riskFloor), 0, 6)} HF headroom relative to policy` : 'Stress metrics are read from the local backend'}</div>
          </div>

          <div className="policy-summary"><div className="card-heading"><span className="eyebrow" style ={{"fontSize": "18px"}}>ACTIVE POLICY</span><Icon name="sliders" /></div><div className="policy-value">{fmt(state?.riskFloor, 2)}<span>min. StressHF</span></div><p style ={{"fontSize": "14px"}}>Outgoing liquidity is bounded by the maker’s collateral and stress policy.</p><a href="#policy" style ={{"fontSize": "14px"}}>Adjust policy <Icon name="arrow" size={24} /></a><div className="policy-minimum" style ={{"fontSize": "14px"}}>Demo policy minimum StressHF <strong>1.10</strong></div></div>
        </section>

        <section id="position" className="position-section" aria-labelledby="position-title"><div className="section-heading"><h2 id="position-title" style ={{"fontSize": "24px"}}>Position balances</h2><span className="meta-text" style ={{"fontSize": "14px"}}>Aave V3 · {state ? `Block ${fmt(state.blockNumber)}` : 'Waiting for local fork'}</span></div><div className="balance-grid">
          <article className="balance-card"><div className="balance-label"><Token symbol="WETH" /><span style ={{"fontSize": "14px"}}>WETH collateral</span><span className="balance-type" style ={{"fontSize": "12px"}}>SUPPLIED</span></div><div className="balance-amount" title={state?.collateral.weth}>{fmt(state?.collateral.weth, 4, 8)} <small>WETH</small></div><div className="balance-footer" style ={{"fontSize": "14px"}}>Output capacity · qMax <strong title={state?.qMax.weth} style ={{"fontSize": "12px"}}>{fmt(state?.qMax.weth, 4, 8)} WETH</strong></div></article>
          <article className="balance-card"><div className="balance-label"><Token symbol="USDC" /><span style ={{"fontSize": "14px"}}>USDC collateral</span><span className="balance-type" style ={{"fontSize": "12px"}}>SUPPLIED</span></div><div className="balance-amount" title={state?.collateral.usdc}>{fmt(state?.collateral.usdc, 2, 6)} <small>USDC</small></div><div className="balance-footer" style ={{"fontSize": "14px"}}>Output capacity · qMax <strong title={state?.qMax.usdc} style ={{"fontSize": "12px"}}>{fmt(state?.qMax.usdc, 2, 6)} USDC</strong></div></article>
          <article className="balance-card debt-card"><div className="balance-label"><Token symbol="USDC" /><span style ={{"fontSize": "14px"}}>USDC debt</span><span className="balance-type" style ={{"fontSize": "12px"}}>BORROWED</span></div><div className="balance-amount" title={state?.debt.usdc}>{fmt(state?.debt.usdc, 2, 6)} <small>USDC</small></div><div className="balance-footer" style ={{"fontSize": "14px"}}><span className="amber-dot" />Included in the stress calculation</div></article>
        </div></section>

        <div className="workspace-grid">
          <section className="panel quote-panel" aria-labelledby="quote-title"><div className="panel-heading"><div><div className="eyebrow" style ={{"fontSize": "14px"}}>EXECUTION WORKBENCH</div><h2 id="quote-title">Preview a fill</h2></div><span className="tiny-badge" style ={{"fontSize": "12px"}}>LOCAL CHAIN</span></div>
            <form onSubmit={event => { event.preventDefault(); void getQuote(); }}>
              <label className="field-label" htmlFor="direction" style ={{"fontSize": "14px"}}>Trade direction <span style ={{"fontSize": "14px"}}>Incoming asset → outgoing asset</span></label>
              <div className="direction-control"><select id="direction" value={direction} disabled={disabled} style ={{"fontSize": "14px"}} onChange={event => { setDirection(event.target.value as Direction); setAmount(''); setQuote(null); }}><option value="weth-in">WETH in → USDC out</option><option value="usdc-in">USDC in → WETH out</option></select><span className="direction-decor"><Token symbol={direction === 'weth-in' ? 'WETH' : 'USDC'} /><Icon name="arrow" size={16} /><Token symbol={tokenOut} /></span></div>
              <label className="field-label" htmlFor="amount" style ={{"fontSize": "14px"}}>Requested output <span style ={{"fontSize": "14px"}}>Amount leaving the maker</span></label>
              <div className={`amount-input ${amount && validation ? 'invalid' : ''}`}><input id="amount" inputMode="decimal" autoComplete="off" spellCheck={false} value={amount} placeholder={direction === 'weth-in' ? '1000' : '0.1'} disabled={disabled} aria-invalid={!!validation} aria-describedby="amount-help" onChange={event => { setAmount(event.target.value); setQuote(null); }} /><span style ={{"fontSize": "12px"}}>{tokenOut}</span></div>
              <div className="amount-presets">{(direction === 'weth-in' ? ['100', '1000', '5000'] : ['0.01', '0.1', '1']).map(value => <button type="button" className="preset" key={value} disabled={disabled} style ={{"fontSize": "14px"}} onClick={() => { setAmount(value); setQuote(null); }}>{fmt(value)}</button>)}<button type="button" className="preset max" disabled={disabled || !capacity || compare(capacity, '0') === 0} style ={{"fontSize": "14px"}} onClick={() => { if (capacity) { setAmount(capacity); setQuote(null); } }}>Use qMax</button></div>
              <p style ={{"fontSize": "12px"}} id="amount-help" className={amount && validation ? 'field-error' : 'field-help'}>{amount && validation ? validation : 'The backend may reduce output to the available capacity.'}</p>
              <div className="capacity-line"><span style ={{"fontSize": "12px"}}>Current output capacity <span className="mono" style ={{"fontSize": "14px"}}>qMax</span></span><strong>{fmt(capacity)} {tokenOut}</strong></div>
              <button type="submit" className="button primary full-width" style ={{"fontSize": "14px"}} disabled={disabled || !!validation}>{busy === 'Quoting' ? 'Requesting quote…' : 'Get executable quote'}<Icon name="arrow" size={18} /></button>
            </form>

            <div className={`quote-result ${quote?.status === 'rejected' ? 'rejected' : ''}`} aria-live="polite">
              {quote ? <><div className="result-heading"><strong>{quote.status === 'rejected' ? 'Quote rejected' : expired ? 'Quote expired' : quote.partialFill ? 'Partial fill available' : 'Quote ready'}</strong><span>{expired ? 'Request a new quote' : `${Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - now) / 1000))}s remaining`}</span></div><dl className="quote-details"><div><dt>Requested output</dt><dd>{fmt(quote.requestedOut)} {tokenOut}</dd></div><div><dt>Quoted qMax</dt><dd>{fmt(quote.qMax)} {tokenOut}</dd></div><div><dt>Executable output</dt><dd className="emphasized">{fmt(quote.executableOut)} {tokenOut}</dd></div><div><dt>Quoted StressHF / floor</dt><dd>{hf(quote.stressHF)} / {fmt(quote.riskFloor, 2)}</dd></div></dl>{quote.partialFill && <p className="field-help">Only the executable amount will be submitted for this quote.</p>}<button className="button primary full-width" disabled={disabled || expired || quote.status !== 'ready'} onClick={() => void fillQuote()}>Execute quoted fill <Icon name="arrow" size={18} /></button></> : <div className="quote-empty"><span className="empty-icon"><Icon name="activity" size={21} /></span><strong style ={{"fontSize": "14px"}}>{busy === 'Executing' ? 'Waiting for local execution…' : 'Your quote will appear here'}</strong><p style ={{"fontSize": "12px"}}>{busy === 'Executing' ? 'Submission is in progress. Do not resend the request.' : 'Review executable output before submitting a fill.'}</p></div>}
            </div>
          </section>

          <div className="right-stack"><section id="policy" className="panel" aria-labelledby="policy-title"><div className="panel-heading"><div><div className="eyebrow" style ={{"fontSize": "14px"}}>MAKER CONTROLS</div><h2 id="policy-title">Stress policy</h2></div><Icon name="sliders" /></div><p className="panel-description" style ={{"fontSize": "14px"}}>Choose the minimum stressed health factor your quotes must preserve.</p><form onSubmit={event => { event.preventDefault(); void updatePolicy(); }}><div className="floor-presets">{[['1.10', 'Demo minimum'], ['1.20', 'More headroom'], ['1.30', 'Higher floor']].map(([value, label]) => <button type="button" className={`floor-preset ${isFloorEqual(floor, value) ? 'selected' : ''}`} style ={{"fontSize": "14px"}} key={value} disabled={disabled} aria-pressed={isFloorEqual(floor, value)} onClick={() => { dirtyFloor.current = true; setFloor(value); }}><strong>{value}</strong><span style ={{"fontSize": "12px"}}>{label}</span></button>)}</div><label className="field-label" htmlFor="floor" style ={{"fontSize": "14px"}}>Custom floor <span style ={{"fontSize": "12px"}}>Minimum 1.10</span></label><div className="policy-input-row"><input id="floor" inputMode="decimal" autoComplete="off" value={floor} disabled={disabled} aria-invalid={!!policyValidation} aria-describedby="floor-help" onChange={event => { dirtyFloor.current = true; setFloor(event.target.value); }} /><button className="button dark" disabled={disabled || !!policyValidation || (state ? isFloorEqual(floor, state.riskFloor) : false)} style ={{"fontSize": "14px"}}>{busy === 'Updating policy' ? 'Applying…' : 'Apply policy'}</button></div><p id="floor-help" className={policyValidation ? 'field-error' : 'field-help'} style ={{"fontSize": "12px"}}>{policyValidation ?? 'Demo policy minimum StressHF 1.10. Changes invalidate existing quotes.'}</p></form></section>

            <section className="panel scenario-panel" aria-labelledby="scenario-title"><div className="panel-heading"><div><div className="eyebrow" style ={{"fontSize": "14px"}}>DEMO LAB</div><h2 id="scenario-title" style ={{"fontSize": "18px"}}>Put capacity to the test</h2></div><span className="flask-icon"><Icon name="flask" /></span></div><p className="panel-description" style ={{"fontSize": "14px"}}>Withdraw USDC collateral on the local fork, then observe the change in StressHF and qMax.</p><div className="scenario-buttons"><button className="button scenario-withdraw" style ={{"fontSize": "14px"}} disabled={disabled} onClick={() => void scenario('withdraw-usdc')}>{busy === 'Withdrawing' ? 'Withdrawing…' : 'Withdraw USDC'}</button><button className="button subtle" disabled={disabled} style ={{"fontSize": "14px"}} onClick={() => void scenario('restore')}><Icon name="refresh" size={15} />{busy === 'Restoring' ? 'Restoring…' : 'Restore demo'}</button></div><div className="local-note" style ={{"fontSize": "14px"}}><span className="outline-dot" />Scenario actions change the local fork position.</div></section>
          </div>
        </div>

        <section id="activity" className="panel activity-panel" aria-labelledby="activity-title"><div className="panel-heading"><div><h2 id="activity-title" style ={{"fontSize": "18px"}}>Execution activity</h2><p className="panel-description" style ={{"fontSize": "14px"}}>Receipts from this browser session</p></div><span className="tiny-badge" style ={{"fontSize": "14px"}}>{fills.length} RECEIPTS</span></div>{fills.length === 0 ? <div className="activity-empty"><Icon name="activity" size={44} /><div><strong style ={{"fontSize": "14px"}}>No executions yet</strong><p style ={{"fontSize": "14px"}}>Confirmed fills and rejections will appear here with their requested and executed amounts.</p></div></div> : <div className="table-scroll"><table><thead><tr><th>Status / direction</th><th>Requested</th><th>Executed</th><th>Transaction / local chain</th></tr></thead><tbody>{fills.map(fill => <tr key={fill.quoteId}><td><span className={`receipt-status ${fill.status}`}>{fill.status === 'filled' ? 'Confirmed' : 'Rejected'}</span><small>{fill.direction === 'weth-in' ? 'WETH → USDC' : 'USDC → WETH'}</small>{fill.reason && <small className="field-error">{fill.reason}</small>}</td><td>{fmt(fill.requestedOut)} {outputToken(fill.direction)}</td><td>{fmt(fill.executedOut)} {outputToken(fill.direction)}</td><td><code className="transaction-hash">{fill.transactionHash ?? 'No transaction'}</code><small>Local chain {fill.chainId}</small></td></tr>)}</tbody></table></div>}</section>

        <footer className="page-footer"><div style ={{"fontSize": "14px"}}><span className={`status-dot ${connected ? 'live' : ''}`} />{state ? `${state.chain.name} · Chain ${state.chain.id}` : 'Local chain unavailable'}<span className="footer-divider">/</span>Mainnet fork</div><span style ={{"fontSize": "14px"}}>{updatedAt && connected ? `Updated ${Math.max(0, Math.floor((now - updatedAt) / 1000))}s ago · Polls every 5s` : 'No live position data'}</span></footer>
        {state && <div className="maker-address">Maker <code>{state.makerAddress}</code></div>}
      </main>
    </div>
  </div>;
}

function isFloorEqual(a: string, b: string) {
  return !floorError(a) && compare(a, b) === 0;
}
