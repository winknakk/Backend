import { minimizePii } from "./ConversationContextBuilder";

/**
 * Guard rails for the optional AI daily narrative.
 *
 * The narrative is prose over facts that SQL already computed. The model gets
 * a sanitized copy of those facts (no project id, no ticket ids, no customer
 * identities, PII-minimized knowledge-gap topics) and every number in its
 * answer must appear in that copy. Anything else is rejected and the
 * deterministic template is used instead.
 */

export interface NarrativeFactsInput {
  date: string;
  timezone: string;
  totalConversations: number;
  totalMessages: number;
  totalTickets: number;
  resolvedTickets: number;
  slaBreaches: number;
  humanHandoffs: number;
  botDeflectionRate: number;
  topIssueCategories: Array<{ category: string; count: number }>;
  topKnowledgeGaps: Array<{ topic: string; inquiryCount: number }>;
}

export interface NarrativeFacts {
  date: string;
  timezone: string;
  metrics: {
    totalConversations: number;
    totalMessages: number;
    totalTickets: number;
    resolvedTickets: number;
    slaBreaches: number;
    humanHandoffs: number;
    botDeflectionRatePercent: number;
  };
  topIssueCategories: Array<{ category: string; count: number }>;
  topKnowledgeGaps: Array<{ topic: string; inquiryCount: number }>;
}

export function buildNarrativeFacts(input: NarrativeFactsInput): NarrativeFacts {
  return {
    date: input.date,
    timezone: input.timezone,
    metrics: {
      totalConversations: input.totalConversations,
      totalMessages: input.totalMessages,
      totalTickets: input.totalTickets,
      resolvedTickets: input.resolvedTickets,
      slaBreaches: input.slaBreaches,
      humanHandoffs: input.humanHandoffs,
      botDeflectionRatePercent: Number((input.botDeflectionRate * 100).toFixed(1)),
    },
    topIssueCategories: input.topIssueCategories.map((c) => ({ category: minimizePii(String(c.category)), count: c.count })),
    topKnowledgeGaps: input.topKnowledgeGaps.map((g) => ({ topic: minimizePii(String(g.topic)), inquiryCount: g.inquiryCount })),
  };
}

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

function toArabicDigits(text: string): string {
  return text.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
}

/** Canonical form of a numeric token: no grouping commas, no trailing ".0". */
function canonicalNumber(token: string): string {
  const plain = token.replace(/,(?=\d{3}\b)/g, "");
  const n = Number(plain);
  if (!Number.isFinite(n)) return plain;
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

/** Every number a narrative may legitimately contain. */
export function allowedNumbers(facts: NarrativeFacts): Set<string> {
  const allowed = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) allowed.add(canonicalNumber(String(v)));
    if (typeof v === "string") {
      for (const m of toArabicDigits(v).match(/\d+(?:[.,]\d+)*/g) || []) allowed.add(canonicalNumber(m));
    }
  };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
    else add(v);
  };
  walk(facts);

  // Date parts, including the Buddhist-era year commonly written in Thai.
  const [y, m, d] = facts.date.split("-").map((p) => Number(p));
  if (Number.isFinite(y)) {
    allowed.add(String(y));
    allowed.add(String(y + 543));
  }
  if (Number.isFinite(m)) allowed.add(String(m));
  if (Number.isFinite(d)) allowed.add(String(d));
  return allowed;
}

export type NarrativeValidation =
  | { valid: true }
  | { valid: false; reason: "invented_number" | "identifier_like"; offending: string[] };

export function validateNarrative(text: string, facts: NarrativeFacts): NarrativeValidation {
  const normalized = toArabicDigits(text);

  const identifiers = normalized.match(/\b[A-Z]{2,5}-\d+|#\d+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  if (identifiers && identifiers.length > 0) {
    return { valid: false, reason: "identifier_like", offending: identifiers };
  }

  const allowed = allowedNumbers(facts);
  const offending = (normalized.match(/\d+(?:[.,]\d+)*/g) || [])
    .map(canonicalNumber)
    .filter((n) => !allowed.has(n));
  if (offending.length > 0) {
    return { valid: false, reason: "invented_number", offending };
  }
  return { valid: true };
}
