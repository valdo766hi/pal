/** RFC 4180-style CSV; the "eu" locale uses ";" between fields and a decimal comma in numbers. */
export function toCsv(rows, locale) {
  const eu = locale === "eu";
  const delimiter = eu ? ";" : ",";
  const field = (value) => {
    const text = typeof value === "number" && eu ? String(value).replace(".", ",") : String(value);
    return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return rows.map((row) => row.map(field).join(delimiter) + "\r\n").join("");
}
