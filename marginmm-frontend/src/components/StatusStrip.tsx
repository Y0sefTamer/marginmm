import { ConnectButton } from "@rainbow-me/rainbowkit";
import type { MakerRiskState } from "../data/mockMaker";
import { zoneColor } from "../lib/zone";

export function StatusStrip({ maker }: { maker: MakerRiskState }) {
  const overallZone =
    maker.stressHF < maker.hardFloorStressHF
      ? "capped"
      : maker.stressHF < maker.hardFloorStressHF * 1.15
        ? "warning"
        : "safe";

  return (
    <div className="status-strip">
      <div className="status-strip__maker">
        <span className="status-dot" style={{ background: zoneColor(overallZone) }} />
        <span className="muted">Maker</span>
        <span className="num">{maker.address}</span>
        <span className="status-strip__sep">·</span>
        <span className="muted">Policy</span>
        <span className="num">v{maker.policyVersion}</span>
      </div>
      <ConnectButton showBalance={false} accountStatus="address" chainStatus="icon" />
    </div>
  );
}
