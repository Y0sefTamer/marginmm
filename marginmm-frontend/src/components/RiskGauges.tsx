import type { MakerRiskState } from "../data/mockMaker";
import { zoneColor } from "../lib/zone";

function Gauge({
  label,
  value,
  floor,
  ceiling,
}: {
  label: string;
  value: number;
  floor: number;
  ceiling: number;
}) {
  const pct = Math.max(0, Math.min(1, (value - floor) / (ceiling - floor)));
  const zone = value < floor * 1.02 ? "capped" : value < floor * 1.2 ? "warning" : "safe";

  return (
    <div className="gauge">
      <div className="gauge__top">
        <span className="muted">{label}</span>
        <span className="num gauge__value">{value.toFixed(2)}</span>
      </div>
      <div className="gauge__track">
        <div className="gauge__fill" style={{ width: `${pct * 100}%`, background: zoneColor(zone) }} />
        <div className="gauge__floor" style={{ left: "0%" }} title={`Hard floor ${floor}`} />
      </div>
      <div className="gauge__bottom muted">
        <span>floor {floor.toFixed(2)}</span>
      </div>
    </div>
  );
}

export function RiskGauges({ maker }: { maker: MakerRiskState }) {
  return (
    <section className="panel-section">
      <h2>Health factor</h2>
      <div className="gauge-row">
        <Gauge label="Current HF" value={maker.currentHF} floor={maker.hardFloorStressHF} ceiling={2.2} />
        <Gauge label="Stressed HF" value={maker.stressHF} floor={maker.hardFloorStressHF} ceiling={2.2} />
      </div>
      <p className="muted small">
        Stressed HF assumes a {(maker.shockBps / 100).toFixed(1)}% price shock. It's what the contract actually
        checks before allowing a fill — not the live HF above it.
      </p>
    </section>
  );
}