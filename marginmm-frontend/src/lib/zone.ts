export type Zone = "safe" | "warning" | "capped";

export function zoneColor(zone: Zone): string {
  switch (zone) {
    case "safe":
      return "var(--safe)";
    case "warning":
      return "var(--warn)";
    case "capped":
      return "var(--danger)";
  }
}

export function zoneLabel(zone: Zone): string {
  switch (zone) {
    case "safe":
      return "Safe capacity";
    case "warning":
      return "Warning tail";
    case "capped":
      return "Capped";
  }
}
