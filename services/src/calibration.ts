import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import type { GraphEvidence } from "./graph.js";
import { USDC_ADDRESS, WETH_ADDRESS } from "./graph.js";

export const MIN_SHOCK_BPS = 100;
export const MAX_SHOCK_BPS = 5_000;
export const MAX_POLICY_TTL = 6 * 60 * 60;
export const MODEL_VERSION = 1;

export interface CalibrationArtifact {
  chainId: bigint;
  policyRegistry: string;
  pairId: string;
  shockBps: number;
  marketRegime: number;
  policyVersion: number;
  modelVersion: number;
  issuedAt: number;
  validUntil: number;
  evidenceBlockFrom: number;
  evidenceBlockTo: number;
  evidenceHash: string;
}

export interface CalibrationResult {
  artifact: CalibrationArtifact;
  diagnostics: {
    observationCount: number;
    q99DownsideBps: number;
    twoSigmaDownsideBps: number;
    maxDrawdownBps: number;
    shockBps: number;
    aaveUtilization: { weth: string; usdc: string };
    marketDeployment: string;
    aaveDeployment: string;
  };
  canonicalEvidence: string;
}

export interface CalibrationRequest {
  chainId: bigint;
  policyRegistry: string;
  pairId: string;
  policyVersion: number;
  issuedAt: number;
  validUntil: number;
}

interface Rational {
  coefficient: bigint;
  scale: number;
}

export function calibrate(evidence: GraphEvidence, request: CalibrationRequest): CalibrationResult {
  validateRequest(request);
  const pool = evidence.market.pool!;
  const usdcIsToken0 = pool.token0.id === USDC_ADDRESS && pool.token1.id === WETH_ADDRESS;
  const priceField = usdcIsToken0 ? "token0Price" : "token1Price";
  const points = evidence.market.poolHourDatas.map((point) => ({
    timestamp: point.periodStartUnix,
    open: parseDecimal(point.open),
    high: parseDecimal(point.high),
    low: parseDecimal(point.low),
    close: parseDecimal(point.close),
    quotedPrice: parseDecimal(point[priceField]),
  }));

  const downsideReturns: number[] = [];
  const intrahourDrops: number[] = [];
  let peak = points[0]!.close;
  let maxDrawdownBps = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (
      compare(point.high, point.low) < 0
      || compare(point.open, point.high) > 0
      || compare(point.open, point.low) < 0
      || compare(point.close, point.high) > 0
      || compare(point.close, point.low) < 0
      || compare(point.quotedPrice, point.high) > 0
      || compare(point.quotedPrice, point.low) < 0
    ) {
      throw new Error("Market OHLC evidence is internally inconsistent");
    }
    intrahourDrops.push(downsideBps(point.high, point.low));
    if (compare(point.close, peak) > 0) peak = point.close;
    maxDrawdownBps = Math.max(maxDrawdownBps, downsideBps(peak, point.low));
    if (index > 0) downsideReturns.push(downsideBps(points[index - 1]!.close, point.close));
  }

  const samples = downsideReturns.concat(intrahourDrops);
  const q99DownsideBps = nearestRank(samples, 99, 100);
  const meanSquare = ceilDiv(samples.reduce((sum, value) => sum + BigInt(value) ** 2n, 0n), BigInt(samples.length));
  const twoSigmaDownsideBps = Number(2n * sqrtCeil(meanSquare));
  const shockBps = Math.max(q99DownsideBps, twoSigmaDownsideBps, maxDrawdownBps);
  if (shockBps < MIN_SHOCK_BPS || shockBps > MAX_SHOCK_BPS) {
    throw new Error(`Calibrated shock ${shockBps} bps is outside the accepted security envelope`);
  }

  const firstBlock = Number(BigInt(evidence.market.firstSwap[0]!.transaction.blockNumber));
  const lastMarketBlock = Number(BigInt(evidence.market.lastSwap[0]!.transaction.blockNumber));
  const evidenceBlockTo = Math.min(lastMarketBlock, evidence.market._meta.block.number, evidence.aave._meta.block.number);
  if (!Number.isSafeInteger(firstBlock) || !Number.isSafeInteger(evidenceBlockTo) || firstBlock > evidenceBlockTo) {
    throw new Error("Graph evidence block range is invalid");
  }

  const evidenceDocument = {
    schema: "marginmm-evidence-v1",
    model: {
      version: MODEL_VERSION,
      method: "max(q99 downside, 2x downside RMS, peak-to-low drawdown)",
      shockTarget: "WETH",
      usdcMultiplierBps: 10_000,
    },
    queriedAt: evidence.queriedAt,
    fromTimestamp: evidence.fromTimestamp,
    sources: {
      market: {
        subgraphDeployment: evidence.market._meta.deployment,
        indexedBlock: evidence.market._meta.block,
        pool: evidence.market.pool,
        firstSwapBlock: firstBlock,
        lastSwapBlock: lastMarketBlock,
        observations: evidence.market.poolHourDatas,
      },
      aave: {
        subgraphDeployment: evidence.aave._meta.deployment,
        indexedBlock: evidence.aave._meta.block,
        reserves: evidence.aave.reserves,
        liquidations: evidence.aave.liquidationCalls.filter((call) => {
          const assets = new Set([call.collateralReserve.underlyingAsset, call.principalReserve.underlyingAsset]);
          return assets.has(WETH_ADDRESS) || assets.has(USDC_ADDRESS);
        }),
      },
    },
    diagnostics: { q99DownsideBps, twoSigmaDownsideBps, maxDrawdownBps, shockBps },
  };
  const canonicalEvidence = canonicalJson(evidenceDocument);
  const evidenceHash = keccak256(toUtf8Bytes(canonicalEvidence));
  const reserves = new Map(evidence.aave.reserves.map((reserve) => [reserve.underlyingAsset, reserve]));
  const artifact: CalibrationArtifact = {
    chainId: request.chainId,
    policyRegistry: getAddress(request.policyRegistry),
    pairId: request.pairId.toLowerCase(),
    shockBps,
    marketRegime: shockBps >= 2_000 ? 3 : shockBps >= 1_000 ? 2 : 1,
    policyVersion: request.policyVersion,
    modelVersion: MODEL_VERSION,
    issuedAt: request.issuedAt,
    validUntil: request.validUntil,
    evidenceBlockFrom: firstBlock,
    evidenceBlockTo,
    evidenceHash,
  };
  return {
    artifact,
    diagnostics: {
      observationCount: points.length,
      q99DownsideBps,
      twoSigmaDownsideBps,
      maxDrawdownBps,
      shockBps,
      aaveUtilization: {
        weth: reserves.get(WETH_ADDRESS)!.utilizationRate,
        usdc: reserves.get(USDC_ADDRESS)!.utilizationRate,
      },
      marketDeployment: evidence.market._meta.deployment,
      aaveDeployment: evidence.aave._meta.deployment,
    },
    canonicalEvidence,
  };
}

function validateRequest(request: CalibrationRequest): void {
  if (request.chainId <= 0n) throw new Error("Invalid policy chain ID");
  getAddress(request.policyRegistry);
  if (!/^0x[0-9a-fA-F]{64}$/.test(request.pairId) || /^0x0{64}$/.test(request.pairId)) {
    throw new Error("Invalid pair ID");
  }
  if (!Number.isSafeInteger(request.policyVersion) || request.policyVersion <= 0 || request.policyVersion > 0xffff_ffff) {
    throw new Error("Invalid policy version");
  }
  if (!Number.isSafeInteger(request.issuedAt) || request.issuedAt <= 0) throw new Error("Invalid policy issuance time");
  if (
    !Number.isSafeInteger(request.validUntil)
    || request.validUntil <= request.issuedAt
    || request.validUntil - request.issuedAt > MAX_POLICY_TTL
  ) {
    throw new Error("Invalid policy validity window");
  }
}

function parseDecimal(value: string): Rational {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error("Invalid decimal evidence");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > 36) throw new Error("Decimal evidence exceeds supported precision");
  const coefficient = BigInt(`${match[1]}${fraction}`);
  if (coefficient <= 0n) throw new Error("Price evidence must be positive");
  return { coefficient, scale: fraction.length };
}

function compare(left: Rational, right: Rational): number {
  const [l, r] = align(left, right);
  return l < r ? -1 : l > r ? 1 : 0;
}

function downsideBps(previous: Rational, current: Rational): number {
  const [before, after] = align(previous, current);
  if (after >= before) return 0;
  return Number(ceilDiv((before - after) * 10_000n, before));
}

function align(left: Rational, right: Rational): [bigint, bigint] {
  const scale = Math.max(left.scale, right.scale);
  return [left.coefficient * 10n ** BigInt(scale - left.scale), right.coefficient * 10n ** BigInt(scale - right.scale)];
}

function nearestRank(values: number[], numerator: number, denominator: number): number {
  if (values.length === 0) throw new Error("No calibration samples");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((sorted.length * numerator) / denominator);
  return sorted[Math.max(0, rank - 1)]!;
}

function sqrtCeil(value: bigint): bigint {
  if (value < 0n) throw new Error("Cannot calculate square root of a negative value");
  if (value < 2n) return value;
  let low = 1n;
  let high = value;
  while (low < high) {
    const midpoint = (low + high) >> 1n;
    if (midpoint * midpoint >= value) high = midpoint;
    else low = midpoint + 1n;
  }
  return low;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Invalid division denominator");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Unsupported canonical JSON value");
}
