import { useMemo, useState } from "react";
import { previewFill, type MakerRiskState } from "../data/mockMaker";
import { zoneColor, zoneLabel } from "../lib/zone";

const VIEW_W = 640;
const VIEW_H = 220;
const PAD_L = 50;
const PAD_R = 20;
const PAD_T = 16;
const PAD_B = 30;

export function TradeSimulator({ maker }: { maker: MakerRiskState }) {
  const displayMax = Math.round(maker.qMax * 1.25);
  const [requested, setRequested] = useState(Math.round(maker.qMax * 0.4));

  const preview = useMemo(() => previewFill(maker, requested), [maker, requested]);

  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = VIEW_H - PAD_T - PAD_B;
  const safeBoundary = maker.qMax * maker.safeZonePct;

  const xFor = (amount: number) => PAD_L + (amount / displayMax) * plotW;
  // impact ranges 0..~25bps in the safe→warning ramp; map to a small visual rise
  const yFor = (impactBps: number) => PAD_T + plotH - (impactBps / 30) * plotH * 0.6 - plotH * 0.05;

  const curvePoints: [number, number][] = [];
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    const amount = (i / steps) * maker.qMax;
    const p = previewFill(maker, amount);
    curvePoints.push([xFor(amount), yFor(p.priceImpactBps)]);
  }
  const pathD = curvePoints.map((pt, i) => `${i === 0 ? "M" : "L"} ${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(" ");

  const qMaxX = xFor(maker.qMax);
  const safeBoundaryX = xFor(safeBoundary);
  const markerX = xFor(Math.min(requested, displayMax));
  const markerY = requested <= maker.qMax ? yFor(preview.priceImpactBps) : yFor(0);

  return (
    <section className="hero">
      <h1>Trade simulator</h1>
      <p className="muted hero__sub">
        Drag to see how a hypothetical trade size lands on this maker's live risk curve.
      </p>

      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="curve-svg" role="img" aria-label="Risk-aware pricing curve">
        <rect x={PAD_L} y={PAD_T} width={safeBoundaryX - PAD_L} height={plotH} fill="var(--safe)" opacity="0.06" />
        <rect x={safeBoundaryX} y={PAD_T} width={qMaxX - safeBoundaryX} height={plotH} fill="var(--warn)" opacity="0.08" />
        <rect x={qMaxX} y={PAD_T} width={PAD_L + plotW - qMaxX} height={plotH} fill="var(--danger)" opacity="0.08" />

        <line x1={qMaxX} y1={PAD_T} x2={qMaxX} y2={PAD_T + plotH} stroke="var(--danger)" strokeDasharray="4 4" strokeWidth="1" />
        <line x1={PAD_L} y1={PAD_T + plotH} x2={PAD_L + plotW} y2={PAD_T + plotH} stroke="var(--line)" strokeWidth="1" />

        <path d={pathD} fill="none" stroke="var(--accent)" strokeWidth="2" />

        <circle cx={markerX} cy={markerY} r="6" fill={zoneColor(preview.zone)} stroke="var(--bg)" strokeWidth="2" />

        <text x={PAD_L} y={VIEW_H - 8} className="curve-label" fill="var(--muted)">0</text>
        <text x={qMaxX} y={VIEW_H - 8} className="curve-label" textAnchor="middle" fill="var(--danger)">
          qMax
        </text>
        <text x={PAD_L + plotW} y={VIEW_H - 8} className="curve-label" textAnchor="end" fill="var(--muted)">
          {displayMax.toLocaleString()}
        </text>
      </svg>

      <input
        type="range"
        min={0}
        max={displayMax}
        step={500}
        value={requested}
        onChange={(e) => setRequested(Number(e.target.value))}
        className="slider"
        aria-label="Requested trade amount in USDC"
      />

      <div className="hero__readout">
        <div>
          <span className="muted">Requesting</span>
          <div className="num readout-value">${requested.toLocaleString()}</div>
        </div>
        <div>
          <span className="muted">Would receive</span>
          <div className="num readout-value">${Math.round(preview.fillOut).toLocaleString()}</div>
        </div>
        <div>
          <span className="muted">Zone</span>
          <div className="num readout-value" style={{ color: zoneColor(preview.zone) }}>
            {zoneLabel(preview.zone)}
          </div>
        </div>
        <div>
          <span className="muted">Post-trade HF</span>
          <div className="num readout-value">{preview.postTradeHF}</div>
        </div>
      </div>
      {preview.isPartial && (
        <p className="hero__note" style={{ color: "var(--danger)" }}>
          Requested amount exceeds qMax — filling the safe portion only, remainder rejected.
        </p>
      )}
    </section>
  );
}
