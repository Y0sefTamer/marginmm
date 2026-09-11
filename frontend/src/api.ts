import { isAddress, isHash, isHex } from 'viem';
import { compare, inputDecimals, isDecimal, outputDecimals } from './decimal';
import type { Direction } from './decimal';

export interface MakerAction {
  id: string;
  chainId: '31337';
  from: string;
  to: string;
  data: `0x${string}`;
  value: '0';
  label: string;
}

export interface MakerState {
  makerAddress: string;
  demoScenarioReceiver: string;
  chain: { id: '31337'; name: string; fork: true; forkBlock: string; timestamp: number };
  blockNumber: string;
  contracts: { aqua: string; router: string; policy: string; aWETH: string; aUSDC: string };
  pairId: string;
  strategy: {
    state: 'missing' | 'unshipped' | 'active' | 'docked';
    hash: string | null;
    priceBounds: { minUsdcPerWeth: string; maxUsdcPerWeth: string } | null;
    aquaBalances: { weth: string; usdc: string };
    nextAction: MakerAction | null;
  };
  collateral: { weth: string; usdc: string };
  debt: { usdc: string };
  currentHF: string | null;
  stressHF: string | null;
  policy: {
    state: 'missing' | 'disabled' | 'valid' | 'expiring' | 'expired';
    enabled: boolean;
    hardFloorStressHF: string;
    policyVersion: number;
    revision: string;
    shockBps: number;
    marketRegime: number;
    modelVersion: number;
    issuedAt: number;
    validUntil: number;
    secondsRemaining: number;
    evidenceBlockFrom: number;
    evidenceBlockTo: number;
    evidenceHash: string | null;
  };
  ready: boolean;
}

export interface Quote {
  quoteId: string;
  status: 'ready' | 'rejected';
  direction: Direction;
  requestedAmountIn: string;
  actualAmountIn: string;
  baseAmountOut: string;
  finalAmountOut: string;
  qMax: string;
  partialFill: boolean;
  riskClass: number;
  stressHFBefore: string | null;
  stressHFAfter: string | null;
  hardFloorStressHF: string;
  shockBps: number;
  policyVersion: number;
  policyRevision: string;
  policyValidUntil: number;
  expiresAt: string;
  reason: string | null;
}

export interface Fill {
  quoteId: string;
  status: 'filled';
  direction: Direction;
  requestedAmountIn: string;
  actualAmountIn: string;
  baseAmountOut: string;
  finalAmountOut: string;
  qMax: string;
  stressHFBefore: string | null;
  stressHFAfter: string | null;
  shockBps: number;
  policyVersion: number;
  riskClass: number;
  transactionHash: string;
  chainId: '31337';
}

export interface AgentProposal {
  decision: 'no_refresh' | 'proposal_ready';
  headline: string;
  rationale: string[];
  policyStatus: Record<string, unknown>;
  graphEvidence?: {
    queriedAt: number;
    observationCount: number;
    marketDeployment: string;
    marketIndexedBlock: number;
    aaveDeployment: string;
    aaveIndexedBlock: number;
  };
  paymentReceipt?: { transaction: string; network: string; amount?: string; idempotentReplay: boolean };
  calibration?: {
    shockBps: number;
    marketRegime: number;
    policyVersion: number;
    modelVersion: number;
    issuedAt: number;
    validUntil: number;
    evidenceBlockFrom: number;
    evidenceBlockTo: number;
    evidenceHash: string;
    signer: string;
  };
  approval?: MakerAction;
}

export class ApiError extends Error {
  constructor(message: string, public readonly code = 'UNAVAILABLE') { super(message); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('The API returned an invalid response.', 'INVALID_RESPONSE');
  }
  return value as Record<string, unknown>;
}

function ensure(condition: unknown): asserts condition {
  if (!condition) throw new ApiError('The API response does not match the frontend contract.', 'INVALID_RESPONSE');
}

const uintString = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 78;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const nullableHF = (value: unknown): value is string | null => value === null || isDecimal(value);
const direction = (value: unknown): value is Direction => value === 'weth-in' || value === 'usdc-in';
const safeUint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function decodeMakerAction(value: unknown, maker?: string): MakerAction {
  const action = record(value);
  ensure(identifier(action.id) && action.chainId === '31337');
  ensure(typeof action.from === 'string' && isAddress(action.from));
  ensure(typeof action.to === 'string' && isAddress(action.to));
  ensure(typeof action.data === 'string' && isHex(action.data) && action.data.length >= 10 && action.data.length % 2 === 0);
  ensure(action.value === '0' && identifier(action.label));
  if (maker) ensure(action.from.toLowerCase() === maker.toLowerCase());
  return action as unknown as MakerAction;
}

export function decodeState(value: unknown): MakerState {
  const state = record(value);
  const chain = record(state.chain);
  const contracts = record(state.contracts);
  const strategy = record(state.strategy);
  const collateral = record(state.collateral);
  const debt = record(state.debt);
  const policy = record(state.policy);
  const aquaBalances = record(strategy.aquaBalances);
  ensure(typeof state.makerAddress === 'string' && isAddress(state.makerAddress));
  ensure(typeof state.demoScenarioReceiver === 'string' && isAddress(state.demoScenarioReceiver));
  ensure(state.demoScenarioReceiver.toLowerCase() !== state.makerAddress.toLowerCase());
  ensure(
    chain.id === '31337' && chain.fork === true && identifier(chain.name)
    && uintString(chain.forkBlock) && safeUint(chain.timestamp) && chain.timestamp > 0,
  );
  ensure(uintString(state.blockNumber));
  for (const key of ['aqua', 'router', 'policy', 'aWETH', 'aUSDC']) {
    ensure(typeof contracts[key] === 'string' && isAddress(contracts[key]));
  }
  ensure(typeof state.pairId === 'string' && isHash(state.pairId));
  ensure(['missing', 'unshipped', 'active', 'docked'].includes(String(strategy.state)));
  ensure(strategy.hash === null || (typeof strategy.hash === 'string' && isHash(strategy.hash)));
  if (strategy.priceBounds !== null) {
    const bounds = record(strategy.priceBounds);
    ensure(isDecimal(bounds.minUsdcPerWeth, 6) && isDecimal(bounds.maxUsdcPerWeth, 6));
    ensure(compare(bounds.minUsdcPerWeth, bounds.maxUsdcPerWeth) < 0);
  }
  ensure(isDecimal(aquaBalances.weth) && isDecimal(aquaBalances.usdc, 6));
  if (strategy.nextAction !== null) decodeMakerAction(strategy.nextAction, state.makerAddress);
  ensure(isDecimal(collateral.weth) && isDecimal(collateral.usdc, 6) && isDecimal(debt.usdc, 6));
  ensure(nullableHF(state.currentHF) && nullableHF(state.stressHF));
  ensure(['missing', 'disabled', 'valid', 'expiring', 'expired'].includes(String(policy.state)));
  ensure(typeof policy.enabled === 'boolean' && isDecimal(policy.hardFloorStressHF));
  ensure(safeUint(policy.policyVersion) && policy.policyVersion <= 0xffff_ffff && uintString(policy.revision));
  ensure(safeUint(policy.shockBps) && policy.shockBps <= 5_000);
  ensure(safeUint(policy.issuedAt) && safeUint(policy.validUntil) && safeUint(policy.secondsRemaining));
  ensure(safeUint(policy.marketRegime) && safeUint(policy.modelVersion));
  ensure(safeUint(policy.evidenceBlockFrom) && safeUint(policy.evidenceBlockTo));
  ensure(policy.evidenceHash === null || (typeof policy.evidenceHash === 'string' && isHash(policy.evidenceHash)));
  const hasPolicy = ['valid', 'expiring', 'expired'].includes(String(policy.state));
  ensure(hasPolicy === (policy.shockBps >= 100 && policy.policyVersion > 0 && policy.evidenceHash !== null));
  if (hasPolicy) {
    ensure(policy.marketRegime >= 1 && policy.marketRegime <= 3 && policy.modelVersion === 1);
    ensure(policy.evidenceBlockFrom <= policy.evidenceBlockTo);
    ensure(policy.issuedAt > 0 && policy.validUntil > policy.issuedAt && policy.validUntil - policy.issuedAt <= 21_600);
    const remaining = Math.max(0, policy.validUntil - chain.timestamp);
    ensure(policy.secondsRemaining === remaining);
    ensure(
      (policy.state === 'valid' && chain.timestamp <= policy.validUntil && remaining > 900)
      || (policy.state === 'expiring' && chain.timestamp <= policy.validUntil && remaining <= 900)
      || (policy.state === 'expired' && chain.timestamp > policy.validUntil && remaining === 0),
    );
    ensure(state.stressHF !== null && compare(policy.hardFloorStressHF, '1.01') >= 0);
  } else {
    ensure(policy.marketRegime === 0 && policy.modelVersion === 0
      && policy.issuedAt === 0 && policy.validUntil === 0 && policy.secondsRemaining === 0
      && policy.evidenceBlockFrom === 0 && policy.evidenceBlockTo === 0 && state.stressHF === null);
  }
  ensure(typeof state.ready === 'boolean');
  ensure(state.ready === (strategy.state === 'active' && ['valid', 'expiring'].includes(String(policy.state))));
  return state as unknown as MakerState;
}

export function decodeQuote(value: unknown): Quote {
  const quote = record(value);
  ensure(identifier(quote.quoteId) && direction(quote.direction));
  ensure(quote.status === 'ready' || quote.status === 'rejected');
  const inDecimals = inputDecimals(quote.direction);
  const outDecimals = outputDecimals(quote.direction);
  for (const key of ['requestedAmountIn', 'actualAmountIn']) ensure(isDecimal(quote[key], inDecimals));
  for (const key of ['baseAmountOut', 'finalAmountOut', 'qMax']) ensure(isDecimal(quote[key], outDecimals));
  ensure(compare(quote.requestedAmountIn as string, '0') > 0);
  ensure(compare(quote.actualAmountIn as string, quote.requestedAmountIn as string) <= 0);
  ensure(compare(quote.finalAmountOut as string, quote.baseAmountOut as string) <= 0);
  ensure(compare(quote.finalAmountOut as string, quote.qMax as string) === 0);
  ensure(typeof quote.partialFill === 'boolean');
  ensure(quote.partialFill === (compare(quote.finalAmountOut as string, quote.baseAmountOut as string) < 0));
  ensure(safeUint(quote.riskClass) && quote.riskClass <= 2);
  ensure(nullableHF(quote.stressHFBefore) && nullableHF(quote.stressHFAfter));
  ensure(isDecimal(quote.hardFloorStressHF) && compare(quote.hardFloorStressHF, '1.01') >= 0);
  ensure(safeUint(quote.shockBps) && quote.shockBps >= 100 && quote.shockBps <= 5_000);
  ensure(safeUint(quote.policyVersion) && quote.policyVersion > 0 && quote.policyVersion <= 0xffff_ffff && uintString(quote.policyRevision));
  ensure(safeUint(quote.policyValidUntil) && quote.policyValidUntil > 0);
  ensure(typeof quote.expiresAt === 'string' && Number.isFinite(Date.parse(quote.expiresAt)));
  ensure(quote.reason === null || identifier(quote.reason));
  ensure(quote.status !== 'ready' || (
    compare(quote.actualAmountIn as string, '0') > 0
    && compare(quote.finalAmountOut as string, '0') > 0
    && quote.stressHFAfter !== null
    && compare(quote.stressHFAfter, quote.hardFloorStressHF as string) >= 0
  ));
  return quote as unknown as Quote;
}

export function decodeFill(value: unknown): Fill {
  const fill = record(value);
  ensure(identifier(fill.quoteId) && fill.status === 'filled' && direction(fill.direction));
  const inDecimals = inputDecimals(fill.direction);
  const outDecimals = outputDecimals(fill.direction);
  for (const key of ['requestedAmountIn', 'actualAmountIn']) ensure(isDecimal(fill[key], inDecimals));
  for (const key of ['baseAmountOut', 'finalAmountOut', 'qMax']) ensure(isDecimal(fill[key], outDecimals));
  ensure(compare(fill.actualAmountIn as string, '0') > 0 && compare(fill.actualAmountIn as string, fill.requestedAmountIn as string) <= 0);
  ensure(compare(fill.finalAmountOut as string, fill.baseAmountOut as string) <= 0);
  ensure(compare(fill.finalAmountOut as string, '0') > 0 && compare(fill.finalAmountOut as string, fill.qMax as string) === 0);
  ensure(nullableHF(fill.stressHFBefore) && nullableHF(fill.stressHFAfter));
  ensure(safeUint(fill.shockBps) && fill.shockBps >= 100 && fill.shockBps <= 5_000);
  ensure(safeUint(fill.policyVersion) && fill.policyVersion > 0 && fill.policyVersion <= 0xffff_ffff && safeUint(fill.riskClass) && fill.riskClass <= 2);
  ensure(typeof fill.transactionHash === 'string' && isHash(fill.transactionHash) && fill.chainId === '31337');
  return fill as unknown as Fill;
}

export function decodeAgentProposal(value: unknown): AgentProposal {
  const proposal = record(value);
  ensure(proposal.decision === 'no_refresh' || proposal.decision === 'proposal_ready');
  ensure(typeof proposal.headline === 'string' && proposal.headline.length > 0 && proposal.headline.length <= 180);
  ensure(Array.isArray(proposal.rationale) && proposal.rationale.length >= 1 && proposal.rationale.length <= 4);
  ensure(proposal.rationale.every(item => typeof item === 'string' && item.length > 0 && item.length <= 280));
  record(proposal.policyStatus);
  if (proposal.decision === 'proposal_ready') {
    const graph = record(proposal.graphEvidence);
    const payment = record(proposal.paymentReceipt);
    const calibration = record(proposal.calibration);
    ensure(safeUint(graph.queriedAt) && safeUint(graph.observationCount) && graph.observationCount > 0);
    ensure(identifier(graph.marketDeployment) && safeUint(graph.marketIndexedBlock));
    ensure(identifier(graph.aaveDeployment) && safeUint(graph.aaveIndexedBlock));
    ensure(identifier(payment.transaction) && payment.network === 'hedera:testnet' && typeof payment.idempotentReplay === 'boolean');
    ensure(payment.amount === undefined || uintString(payment.amount));
    ensure(safeUint(calibration.shockBps) && calibration.shockBps >= 100 && calibration.shockBps <= 5_000);
    ensure(safeUint(calibration.marketRegime) && calibration.marketRegime >= 1 && calibration.marketRegime <= 3);
    ensure(safeUint(calibration.policyVersion) && calibration.policyVersion > 0 && calibration.policyVersion <= 0xffff_ffff);
    ensure(calibration.modelVersion === 1);
    ensure(safeUint(calibration.issuedAt) && safeUint(calibration.validUntil) && calibration.validUntil > calibration.issuedAt);
    ensure(calibration.validUntil - calibration.issuedAt <= 21_600);
    ensure(safeUint(calibration.evidenceBlockFrom) && safeUint(calibration.evidenceBlockTo)
      && calibration.evidenceBlockFrom <= calibration.evidenceBlockTo);
    ensure(typeof calibration.evidenceHash === 'string' && isHash(calibration.evidenceHash));
    ensure(typeof calibration.signer === 'string' && isAddress(calibration.signer));
    decodeMakerAction(proposal.approval);
  } else {
    ensure(proposal.approval === undefined && proposal.calibration === undefined && proposal.paymentReceipt === undefined);
  }
  return proposal as unknown as AgentProposal;
}

const errorMessages: Record<string, string> = {
  QUOTE_EXPIRED: 'This quote expired. Request a new quote.',
  QUOTE_USED: 'This quote was already submitted. Refresh state before requesting another quote.',
  POLICY_REJECTED: 'The request was rejected by the active stress policy.',
  STALE_QUOTE: 'Policy or collateral state changed after the quote. Request a new quote.',
  STRATEGY_NOT_READY: 'Create and ship the Aqua strategy before this action.',
  STRATEGY_EXISTS: 'The current immutable strategy already exists. Dock it before creating another.',
  AGENT_NOT_CONFIGURED: 'The local Agent credentials are incomplete. Check services/.env.agent.local.',
  AGENT_UNAVAILABLE: 'The Agent could not complete its pre-payment checks. Retry the same action; no paid request was started.',
  AGENT_OUTCOME_UNCERTAIN: 'This paid Agent request is still pending or has an uncertain outcome. Retry the same browser action; no new request ID will be created.',
  AGENT_REQUEST_CONFLICT: 'This Agent request ID is already bound to different inputs.',
  INVALID_INPUT: 'The backend rejected the exact input values.',
  INVALID_HOST: 'The local API rejected this browser host.',
  INVALID_ORIGIN: 'The local API rejected this request origin.',
  BUSY: 'The local API is busy. Wait for the current operation to finish.',
  FORK_UNAVAILABLE: 'The local fork is unavailable. Check the backend and RPC logs.',
};

export async function request<T>(
  path: string,
  decode: (value: unknown) => T,
  body?: object,
  signal?: AbortSignal,
  timeoutMs = body ? 60_000 : 10_000,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(`/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) {
      let code = 'REQUEST_FAILED';
      try {
        const failure = await response.json() as { error?: { code?: unknown } };
        if (typeof failure?.error?.code === 'string' && Object.hasOwn(errorMessages, failure.error.code)) code = failure.error.code;
      } catch { /* Never expose internal proxy or server response bodies. */ }
      throw new ApiError(errorMessages[code] ?? `The local API rejected the request (HTTP ${response.status}).`, code);
    }
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new ApiError('The API returned invalid JSON.', 'INVALID_RESPONSE'); }
    return decode(data);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(body
      ? 'The request outcome is unknown. Inspect state before submitting another mutation.'
      : 'Cannot reach the local API. Start the MVP and check port 3001.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

const decodeCheckpoint = (value: unknown) => {
  const result = record(value);
  ensure(identifier(result.snapshotId));
  return result as { snapshotId: string };
};

const decodeScenario = (value: unknown): MakerState | { alreadyApplied: boolean; action: MakerAction | null } => {
  const result = record(value);
  if (Object.hasOwn(result, 'ready')) return decodeState(result);
  ensure(typeof result.alreadyApplied === 'boolean');
  ensure(result.action === null || Boolean(decodeMakerAction(result.action)));
  return result as { alreadyApplied: boolean; action: MakerAction | null };
};

export const api = {
  state: (signal?: AbortSignal) => request('state', decodeState, undefined, signal),
  strategy: (minPrice: string, maxPrice: string) => request('strategy', decodeState, { minPrice, maxPrice }),
  agent: (requestId: string, hardFloor: string, forceRefresh: boolean) => request('agent', decodeAgentProposal, { requestId, hardFloor, forceRefresh }, undefined, 120_000),
  policyAction: (hardFloor: string) => request('policy-action', decodeMakerAction, { hardFloor }),
  quote: (direction: Direction, maxAmountIn: string, minAmountOut: string) => request('quote', decodeQuote, { direction, maxAmountIn, minAmountOut }),
  fill: (quoteId: string) => request('fill', decodeFill, { quoteId }),
  scenario: (action: 'withdraw-usdc' | 'restore') => request('scenario', decodeScenario, { action }),
  checkpoint: () => request('checkpoint', decodeCheckpoint, {}),
};
