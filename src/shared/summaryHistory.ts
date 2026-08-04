export interface SummaryHistoryAppendResult {
  runningSummary: string;
  appended: boolean;
  itemCount: number;
}

function normalizeSummaryItem(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^[-*\u2022]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSummaryHistory(value: unknown): string[] {
  const text = String(value ?? "").trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const hasBullet = lines.some((line) => /^\s*[-*\u2022]\s+/.test(line));
  if (!hasBullet) return [normalizeSummaryItem(text)].filter(Boolean);

  const items: string[] = [];
  let current = "";
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*\u2022]\s+(.*)$/);
    if (bullet) {
      if (current) items.push(normalizeSummaryItem(current));
      current = bullet[1];
      continue;
    }

    const continuation = line.trim();
    if (continuation) current = current ? `${current} ${continuation}` : continuation;
  }
  if (current) items.push(normalizeSummaryItem(current));

  return items.filter(Boolean);
}

export function appendSummaryHistory(
  existingRunningSummary: unknown,
  newestCustomerUpdate: unknown
): SummaryHistoryAppendResult {
  const items = parseSummaryHistory(existingRunningSummary);
  const newest = normalizeSummaryItem(newestCustomerUpdate);
  const comparisonKey = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const alreadyExists = newest
    ? items.some((item) => comparisonKey(item) === comparisonKey(newest))
    : true;

  if (newest && !alreadyExists) items.push(newest);

  return {
    runningSummary: items.map((item) => `- ${item}`).join("\n"),
    appended: Boolean(newest) && !alreadyExists,
    itemCount: items.length,
  };
}
