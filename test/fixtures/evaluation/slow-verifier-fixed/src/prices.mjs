export function unitCents(price) {
  const [whole, fraction = ""] = price.split(".");
  const digits = fraction.padEnd(3, "0");
  return Number(whole) * 100 + Number(digits.slice(0, 2)) + (Number(digits[2]) >= 5 ? 1 : 0);
}
