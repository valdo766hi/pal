import { unitCents } from "./prices.mjs";

export function receipt(lines) {
  const active = lines.filter((line) => line.cancelled !== true);
  const cents = active.map((line) => unitCents(line.price));
  return {
    unitCents: cents,
    totalCents: active.reduce((sum, line, i) => sum + cents[i] * line.quantity, 0),
  };
}
