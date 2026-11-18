// Transfer fees; see POLICY.md.
export function fee(transfer) {
  return Math.round(transfer.amountCents * 0.025);
}
