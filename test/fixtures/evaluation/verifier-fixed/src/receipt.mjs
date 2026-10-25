import { unitCents } from "./prices.mjs";

export function receipt(lines) {
  const cents = lines.map((line) => unitCents(line.price));
  return {
    unitCents: cents,
    totalCents: lines.reduce((sum, line, i) => sum + cents[i] * line.quantity, 0),
  };
}
