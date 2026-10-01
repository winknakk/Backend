import { z } from "zod";

/**
 * Validated semantic output of a whole-conversation AI summary.
 *
 * Deliberately absent: ticket status, handoff status, assignee, customer or
 * project identity, resolution state, counts and timestamps. Those are
 * authoritative database facts and are read from the database, never from a
 * model. Unexpected fields a model adds are stripped, not stored.
 */

/** Removes control characters (keeps newline and tab) and trims. */
function cleanText(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

const Text = (max: number) => z.string().transform(cleanText).pipe(z.string().max(max));
const TextList = (itemMax: number, listMax: number) =>
  z
    .array(z.string())
    .transform((items) => items.map(cleanText).filter((s) => s.length > 0))
    .pipe(z.array(z.string().max(itemMax)).max(listMax));

/**
 * Closed vocabulary for risk_flags. Anything else a model emits is dropped,
 * so the console never shows an invented category.
 */
export const SUMMARY_RISK_FLAGS = [
  "credential_shared",
  "account_access",
  "security_incident",
  "data_exposure",
  "service_outage",
  "critical_request",
  "recurring_issue",
  "customer_frustrated",
  "multi_issue",
] as const;
export type SummaryRiskFlag = (typeof SUMMARY_RISK_FLAGS)[number];

const RiskFlags = z
  .array(z.string())
  .transform((items) =>
    Array.from(
      new Set(
        items
          .map((s) => cleanText(s).toLowerCase())
          .filter((s): s is SummaryRiskFlag => (SUMMARY_RISK_FLAGS as readonly string[]).includes(s))
      )
    )
  );

export const ConversationSummaryOutputSchema = z
  .object({
    summary_th: Text(1500).pipe(z.string().min(1)),
    customer_goal: Text(300).default(""),
    topics: TextList(120, 8).default([]),
    /** Each distinct problem the customer raised (multi-issue conversations list several). */
    issues: TextList(300, 8).default([]),
    open_questions: TextList(300, 8).default([]),
    actions_taken: TextList(300, 10).default([]),
    /** Only a cause someone in the transcript stated; empty when nobody did. Never inferred. */
    stated_root_cause: Text(300).default(""),
    /** What the customer explicitly confirmed (fixed / not fixed / per issue); empty when nothing was confirmed. */
    customer_confirmation: Text(300).default(""),
    risk_flags: RiskFlags.default([]),
    suggested_next_action: Text(300).default(""),
  })
  .strip();

export type ConversationSummaryOutput = z.infer<typeof ConversationSummaryOutputSchema>;

export type SummaryParseResult =
  | { ok: true; value: ConversationSummaryOutput }
  | { ok: false; category: "empty_output" | "invalid_output" };

/**
 * Parses model text into the summary contract. Tolerates code fences and
 * surrounding prose; rejects empty output, refusals (no JSON object), broken
 * JSON, replacement characters from a bad decode, and schema violations.
 */
export function parseConversationSummaryOutput(raw: unknown): SummaryParseResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, category: "empty_output" };
  }
  // U+FFFD appears when upstream bytes were not valid UTF-8.
  if (raw.includes(String.fromCharCode(0xfffd))) {
    return { ok: false, category: "invalid_output" };
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { ok: false, category: "invalid_output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, category: "invalid_output" };
  }

  const result = ConversationSummaryOutputSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, category: "invalid_output" };
  }
  return { ok: true, value: result.data };
}
