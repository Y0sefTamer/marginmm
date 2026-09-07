// Mock data shaped to match the real MarginMM risk instruction's expected
// return values. Once the team finalizes which backend version they're
// shipping, swap `mockMaker` for a `useReadContract` call and this file
// mostly disappears — component code below should not need to change shape.

export interface MakerRiskState {
  address: string;
  currentHF: number; // Aave's live health factor, unmodified
  stressHF: number; // health factor if the shock scenario happened right now
  hardFloorStressHF: number; // minimum stressHF the policy will tolerate
  safeZonePct: number; // 0-1, fraction of budget treated as fully safe
  qMax: number; // max safe output amount, in USDC, at this instant
  shockBps: number; // calibrated per-asset stress shock, in bps
  policyVersion: number;
}

export const mockMaker: MakerRiskState = {
  address: "0x71C7...3f4e",
  currentHF: 1.82,
  stressHF: 1.34,
  hardFloorStressHF: 1.10,
  safeZonePct: 0.65,
  qMax: 62000,
  shockBps: 1500,
  policyVersion: 3,
};

export interface FillPreview {
  requestedOut: number;
  fillOut: number;
  isPartial: boolean;
  zone: "safe" | "warning" | "capped";
  postTradeHF: number;
  priceImpactBps: number;
}

// Mirrors the real risk-instruction logic described in the handoff doc:
// flat pricing inside the safe zone, a small convex premium in the warning
// tail, hard cap at qMax. This is a believable stand-in curve, not the real
// math -- replace with the actual on-chain preview call once it exists.
export function previewFill(maker: MakerRiskState, requestedOut: number): FillPreview {
  const safeBoundary = maker.qMax * maker.safeZonePct;
  const fillOut = Math.min(requestedOut, maker.qMax);
  const isPartial = requestedOut > maker.qMax;

  let zone: FillPreview["zone"] = "safe";
  let priceImpactBps = 0;

  if (requestedOut > maker.qMax) {
    zone = "capped";
    priceImpactBps = 0; // beyond qMax there's no price to quote -- it's just capped
  } else if (requestedOut > safeBoundary) {
    zone = "warning";
    const tailProgress = (requestedOut - safeBoundary) / (maker.qMax - safeBoundary);
    priceImpactBps = Math.round(tailProgress * tailProgress * 25); // convex ramp, capped ~25bps
  }

  // fake but directionally-correct HF depletion as size grows toward qMax
  const depletion = (fillOut / maker.qMax) * (maker.currentHF - maker.hardFloorStressHF);
  const postTradeHF = Number((maker.currentHF - depletion).toFixed(3));

  return { requestedOut, fillOut, isPartial, zone, postTradeHF, priceImpactBps };
}

export interface FillEvent {
  id: number;
  amount: number;
  zone: FillPreview["zone"];
  policyVersion: number;
  timestamp: string;
}

export const mockEventLog: FillEvent[] = [
  { id: 4, amount: 18000, zone: "safe", policyVersion: 3, timestamp: "2m ago" },
  { id: 3, amount: 51000, zone: "warning", policyVersion: 3, timestamp: "14m ago" },
  { id: 2, amount: 70000, zone: "capped", policyVersion: 2, timestamp: "31m ago" },
  { id: 1, amount: 9500, zone: "safe", policyVersion: 2, timestamp: "48m ago" },
];