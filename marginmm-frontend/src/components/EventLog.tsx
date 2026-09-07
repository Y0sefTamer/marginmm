import type { FillEvent } from "../data/mockMaker";
import { zoneColor, zoneLabel } from "../lib/zone";

export function EventLog({ events }: { events: FillEvent[] }) {
  return (
    <section className="panel-section">
      <h2>Recent fills</h2>
      <table className="log-table">
        <thead>
          <tr>
            <th>Amount</th>
            <th>Zone</th>
            <th>Policy</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="num">${e.amount.toLocaleString()}</td>
              <td>
                <span className="log-dot" style={{ background: zoneColor(e.zone) }} />
                {zoneLabel(e.zone)}
              </td>
              <td className="num">v{e.policyVersion}</td>
              <td className="muted">{e.timestamp}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}