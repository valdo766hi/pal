import { unitCents } from "./prices.mjs";

export function receipt(lines) {
  return {
    unitCents: lines.map((line) => unitCents(line.price)),
    totalCents: Math.round(lines.reduce((sum, line) => sum + Number(line.price) * line.quantity, 0) * 100),
  };
}
