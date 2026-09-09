import { formatUnits, maxUint256, parseUnits } from 'viem';

export const DEMO_FLOOR = '1.10';
export type Direction = 'weth-in' | 'usdc-in';
export const outputToken = (direction: Direction) => direction === 'weth-in' ? 'USDC' : 'WETH';
export const outputDecimals = (direction: Direction) => direction === 'weth-in' ? 6 : 18;

// Validate precision before parseUnits: never allow implicit rounding of a request.
export function isDecimal(value: unknown, decimals = 18): value is string {
  if (typeof value !== 'string' || value.length > 100 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) return false;
  if ((value.split('.')[1]?.length ?? 0) > decimals) return false;
  try { return parseUnits(value, decimals) <= maxUint256; } catch { return false; }
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  const left = parseUnits(a, 18);
  const right = parseUnits(b, 18);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function amountError(value: string, direction: Direction): string | null {
  const decimals = outputDecimals(direction);
  if (!isDecimal(value, decimals)) return `Enter a decimal amount with up to ${decimals} decimal places. No exponent notation.`;
  if (parseUnits(value, decimals) === 0n) return 'Requested output must be greater than zero.';
  return null;
}

export function floorError(value: string): string | null {
  if (!isDecimal(value)) return 'Enter a decimal health factor with up to 18 decimal places.';
  if (compare(value, DEMO_FLOOR) < 0) return 'Demo policy minimum StressHF is 1.10.';
  return null;
}

export function displayDecimal(value: string | undefined | null, minimumFraction = 0, maximumFraction?: number): string {
  if (value == null) return '—';
  const [whole, fraction = ''] = value.split('.');
  const withoutTrailingZeroes = fraction.replace(/0+$/, '');
  // Display truncation is deliberately downward, never floating-point rounding.
  // Exact decimal strings remain unchanged in state, validation and transactions.
  const visible = maximumFraction === undefined ? withoutTrailingZeroes : withoutTrailingZeroes.slice(0, maximumFraction);
  const trimmed = visible.padEnd(minimumFraction, '0');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${trimmed ? `.${trimmed}` : ''}`;
}

// Only non-financial, bounded meter positions become numbers in the view layer.
export function meterPercent(hf: string | null | undefined): number {
  if (hf == null) return 0;
  const scaled = parseUnits(hf, 18);
  const bounded = scaled > parseUnits('2', 18) ? parseUnits('2', 18) : scaled;
  return Number(bounded * 100n / parseUnits('2', 18));
}

export function headroom(stressHF: string, floor: string): string {
  return formatUnits(parseUnits(stressHF, 18) - parseUnits(floor, 18), 18);
}
