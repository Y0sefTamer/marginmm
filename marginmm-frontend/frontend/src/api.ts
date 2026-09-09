import { isAddress, isHash } from 'viem';
import { compare, isDecimal, outputDecimals } from './decimal';
import type { Direction } from './decimal';

export interface MakerState {
  makerAddress: string;
  chain: { id: string; name: string; fork: true };
  blockNumber: string;
  collateral: { weth: string; usdc: string };
  debt: { usdc: string };
  currentHF: string | null;
  stressHF: string | null;
  riskFloor: string;
  qMax: { weth: string; usdc: string };
}

export interface Quote {
  quoteId: string;
  status: 'ready' | 'rejected';
  direction: Direction;
  requestedOut: string;
  executableOut: string;
  qMax: string;
  partialFill: boolean;
  stressHF: string | null;
  riskFloor: string;
  expiresAt: string;
  reason?: string;
}

export interface Fill {
  quoteId: string;
  status: 'filled' | 'rejected';
  direction: Direction;
  requestedOut: string;
  executedOut: string;
  transactionHash: string | null;
  chainId: string;
  reason?: string;
}

export class ApiError extends Error {
  constructor(message: string, public readonly code = 'UNAVAILABLE') { super(message); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('The API returned an invalid response.', 'INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function ensure(condition: unknown): asserts condition {
  if (!condition) throw new ApiError('The API response does not match the frontend contract.', 'INVALID_RESPONSE');
}
const uintString = (v: unknown) => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) && v.length <= 78;
const identifier = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256;
const nullableHF = (v: unknown) => v === null || isDecimal(v);
const direction = (v: unknown): v is Direction => v === 'weth-in' || v === 'usdc-in';

export function decodeState(value: unknown): MakerState {
  const s = record(value);
  const chain = record(s.chain), collateral = record(s.collateral), debt = record(s.debt), qMax = record(s.qMax);
  ensure(typeof s.makerAddress === 'string' && isAddress(s.makerAddress));
  ensure(uintString(chain.id) && chain.id !== '1' && chain.fork === true && identifier(chain.name));
  ensure(uintString(s.blockNumber));
  ensure(isDecimal(collateral.weth) && isDecimal(collateral.usdc, 6) && isDecimal(debt.usdc, 6));
  ensure(nullableHF(s.currentHF) && nullableHF(s.stressHF));
  ensure((s.currentHF !== null && s.stressHF !== null) || compare(debt.usdc, '0') === 0);
  ensure(isDecimal(s.riskFloor) && compare(s.riskFloor, '1.10') >= 0);
  ensure(isDecimal(qMax.weth) && isDecimal(qMax.usdc, 6));
  return s as unknown as MakerState;
}

export function decodeQuote(value: unknown): Quote {
  const q = record(value);
  ensure(identifier(q.quoteId) && direction(q.direction));
  ensure(q.status === 'ready' || q.status === 'rejected');
  const decimals = outputDecimals(q.direction);
  ensure(isDecimal(q.requestedOut, decimals) && isDecimal(q.executableOut, decimals) && isDecimal(q.qMax, decimals));
  ensure(compare(q.requestedOut, '0') > 0 && compare(q.executableOut, q.requestedOut) <= 0 && compare(q.executableOut, q.qMax) <= 0);
  ensure(typeof q.partialFill === 'boolean' && q.partialFill === (compare(q.executableOut, q.requestedOut) < 0));
  ensure(nullableHF(q.stressHF) && isDecimal(q.riskFloor) && compare(q.riskFloor, '1.10') >= 0);
  ensure(typeof q.expiresAt === 'string' && Number.isFinite(Date.parse(q.expiresAt)));
  ensure(q.reason === undefined || (typeof q.reason === 'string' && q.reason.length <= 500));
  ensure(q.status !== 'ready' || (compare(q.executableOut, '0') > 0 && (q.stressHF === null || compare(q.stressHF, q.riskFloor) >= 0)));
  return q as unknown as Quote;
}

export function decodeFill(value: unknown): Fill {
  const f = record(value);
  ensure(identifier(f.quoteId) && direction(f.direction) && uintString(f.chainId) && f.chainId !== '1');
  ensure(f.status === 'filled' || f.status === 'rejected');
  ensure(isDecimal(f.requestedOut, outputDecimals(f.direction)) && isDecimal(f.executedOut, outputDecimals(f.direction)));
  ensure(compare(f.executedOut, f.requestedOut) <= 0);
  ensure(f.reason === undefined || (typeof f.reason === 'string' && f.reason.length <= 500));
  ensure(f.status === 'filled'
    ? typeof f.transactionHash === 'string' && isHash(f.transactionHash) && compare(f.executedOut, '0') > 0
    : f.transactionHash === null && compare(f.executedOut, '0') === 0);
  return f as unknown as Fill;
}

const errorMessages: Record<string, string> = {
  QUOTE_EXPIRED: 'This quote expired. Request a new quote.',
  QUOTE_USED: 'This quote was already submitted. Refresh state before requesting another quote.',
  POLICY_REJECTED: 'The request was rejected by the active stress policy.',
  INSUFFICIENT_CAPACITY: 'There is no executable capacity for this request.',
  STALE_QUOTE: 'The position changed after this quote. Request a new quote.',
  INVALID_INPUT: 'The backend rejected the input. Check the amount or policy floor.',
  FORK_UNAVAILABLE: 'The local fork is unavailable. Check the backend and RPC connection.',
};

export async function request<T>(path: string, decode: (value: unknown) => T, body?: object, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, body ? 60_000 : 10_000);
  try {
    const response = await fetch(`/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      let code = 'REQUEST_FAILED';
      try {
        const failure = await response.json() as { error?: { code?: unknown } };
        if (typeof failure?.error?.code === 'string' && Object.hasOwn(errorMessages, failure.error.code)) code = failure.error.code;
      } catch { /* Never display internal HTTP or proxy error bodies. */ }
      throw new ApiError(errorMessages[code] ?? `The local API rejected the request (HTTP ${response.status}).`, code);
    }
    let data: unknown;
    try { data = await response.json(); } catch { throw new ApiError('The API returned invalid JSON.', 'INVALID_RESPONSE'); }
    return decode(data);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(body
      ? 'The request outcome is unknown. Check local chain state before making another transaction.'
      : 'Cannot reach the local API. Start the backend on port 3001 and the local fork.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export const api = {
  state: (signal?: AbortSignal) => request('state', decodeState, undefined, signal),
  quote: (direction: Direction, amountOut: string) => request('quote', decodeQuote, { direction, amountOut }),
  fill: (quoteId: string) => request('fill', decodeFill, { quoteId }),
  policy: (riskFloor: string) => request('policy', decodeState, { riskFloor }),
  scenario: (action: 'withdraw-usdc' | 'restore') => request('scenario', decodeState, { action }),
};
