// Transfer fees; see POLICY.md clauses 0117, 0613, 0981 and 1150.
export function fee({ amountCents, from, to }) {
  if (from.owner === to.owner) return 0;
  if (amountCents >= 1_000_000) return 1500;
  return Math.min(500, Math.floor((amountCents * 25 + 500) / 1000));
}
