export function parseIncome(income: string): number {
  if (typeof income !== "string") return 0;
  const cleaned = income.trim().replace(/[^\d,.-]/g, "");
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;

  const result = Number(normalized);
  return Number.isFinite(result) ? result : 0;
}
