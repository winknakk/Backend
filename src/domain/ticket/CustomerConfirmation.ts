/**
 * Recognises a customer's answer to a resolution-confirmation request.
 *
 * Scope is deliberately narrow. This only runs when a ticket is already
 * RESOLVED and is waiting on the customer, so the question being answered is
 * known: "does it work now?". That makes deterministic matching appropriate
 * and safe — there is no need to involve the LLM to close a ticket, and doing
 * so would let customer text drive a state transition.
 *
 * Ambiguity resolves to NONE, never to CONFIRMED. Closing a ticket the
 * customer did not agree to close is the expensive mistake; asking again is
 * cheap.
 */

export type ConfirmationIntent = "CONFIRMED" | "REJECTED" | "NONE";

/**
 * Negation markers. Checked first: "ใช้งานได้แล้ว" and "ยังใช้งานไม่ได้"
 * share most of their characters, so a positive-first match would read the
 * rejection as a confirmation.
 */
const REJECTION_MARKERS = [
  // Ambiguity-question chip (two-step close, re-open path).
  "อาการเดิมยังไม่หาย",
  "อาการเดิม",
  "ยังไม่ได้",
  "ยังใช้ไม่ได้",
  "ยังใช้งานไม่ได้",
  "ไม่ได้อยู่",
  "ยังมีปัญหา",
  "ยังเหมือนเดิม",
  "ยังพัง",
  "ยังไม่หาย",
  "ยังเข้าไม่ได้",
  "ไม่หาย",
  "ยังไม่ขึ้น",
  "ไม่ขึ้นให้เลือก",
  "ยังกดไม่ได้",
  "ยังส่งไม่ได้",
  "ยังค้าง",
  "ยังติด",
  "ยังเป็นอยู่",
  "ยังไม่ผ่าน",
  "ยังไม่เรียบร้อย",
  "ยังไม่สำเร็จ",
  "ยังเออเร่อ",
  "ยัง error",
  "still not",
  "still broken",
  "still failing",
  "not working",
  "doesn't work",
  "does not work",
  "not fixed",
  "same problem",
  "same issue",
];

const CONFIRMATION_MARKERS = [
  "ใช้งานได้แล้ว",
  "ใช้ได้แล้ว",
  "ได้แล้วครับ",
  "ได้แล้วค่ะ",
  "เรียบร้อยแล้ว",
  "หายแล้ว",
  "ปกติแล้ว",
  "เข้าได้แล้ว",
  "ปิดเคสได้",
  "ปิดเคสได้เลย",
  "ขอบคุณครับ ปิดเคส",
  "it works",
  "working now",
  "works now",
  "resolved",
  "fixed now",
  "all good",
  "you can close",
  "close the case",
  "close it",
];

/** Lowercase and collapse whitespace. Thai has no case, but the English markers need it. */
function normalize(text: string): string {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function detectConfirmationIntent(text: string): ConfirmationIntent {
  const t = normalize(text);
  if (!t) return "NONE";

  // Rejection wins on a tie. "ยังใช้งานไม่ได้ครับ" contains no confirmation
  // marker, but a customer writing "ขอบคุณครับ แต่ยังใช้ไม่ได้" contains
  // both sentiments, and the operative half is the complaint.
  if (REJECTION_MARKERS.some((m) => t.includes(normalize(m)))) return "REJECTED";
  if (CONFIRMATION_MARKERS.some((m) => t.includes(normalize(m)))) return "CONFIRMED";

  return "NONE";
}

// ---------------------------------------------------------------------------
// Two-step close (operator decision 2026-09-07)
// ---------------------------------------------------------------------------
//
// A positive answer no longer closes anything by itself. The bot asks
// "ต้องการปิดเคส <number> เรื่อง <subject> ใช่ไหมคะ" with quick-reply chips, and
// only the explicit close confirmation performs the transition. The chips
// carry the ticket number in their text ("ยืนยันปิดเคส TCK-2026-00001") so
// the answer is unambiguous even when the customer has several cases open,
// and so a bare "ยืนยัน" — which the AI gate reads as "create the ticket" —
// is never the thing that closes a case.

export type CloseIntentKind =
  /** "ยืนยันปิดเคส", "ยืนยันปิดเคส TCK-…", or a bare yes that follows the close question. */
  | "CONFIRM_CLOSE"
  /** "ยังไม่ปิด", "อย่าเพิ่งปิด", "ยกเลิก" while a close question is pending. */
  | "DECLINE_CLOSE"
  /** "ปิดเคส", "ขอปิดเคส TCK-…": the customer asks to close something. */
  | "CLOSE_REQUEST"
  | "NONE";

export interface CloseIntent {
  kind: CloseIntentKind;
  /** Ticket number found in the message, upper-cased, when present. */
  ticketNumber: string | null;
  /** Whether the request explicitly references the active/current case ("เคสนี้", "ตั๋วนี้", "นี้") */
  isThisCaseRef?: boolean;
}

export const TICKET_NUMBER_PATTERN = /TCK-\d{4}-\d{4,6}/i;

/** Polite particles and filler a short Thai command may carry. */
const TAIL =
  "(?:\\s*(?:ให้|หน่อย|ด้วย|เลย|ที|นะ|น่ะ|ค่ะ|คะ|ครับ|คับ|ค้าบ|คร้าบ|ครับผม|จ้า|จ้ะ|งับ|ฮะ|ฮับ|ค่า|นะคะ|นะครับ|เดี๋ยวนี้|ตอนนี้|ได้ไหม|ได้มั้ย|หน่อยได้ไหม|please|pls|thanks|thank you)\\s*)*";
const TICKET = "(?:\\s*(?:เคส|ticket|เลข|หมายเลข)?\\s*(TCK-\\d{4}-\\d{4,6}))?";
const CLOSE_OBJECT = "(?:\\s*(?:นี้|นั้น|เดิม|ที่แจ้ง(?:ไว้)?))?";

/**
 * Thai sentence boundary, used to find a command inside a longer message.
 *
 * The command patterns below are anchored `^…$` on purpose: it is what stops a
 * *report* that mentions the command word ("ปิดเคสไม่ได้ครับ ระบบขึ้น error")
 * from reading as the command itself. Dropping the anchor to accept real
 * phrasing would trade a missed command for a fabricated one, which is the
 * more expensive mistake.
 *
 * So the anchor stays and the sentence boundary moves instead: a message is
 * split on Thai polite particles that end a sentence, and each clause is
 * matched whole. "แอดมินคะ | ขอยกเลิกเคส TCK-… ให้หน่อยค่ะ | คุยกับเจ้าหน้าที่แล้ว…"
 * matches on clause 2, while "ปิดเคสไม่ได้ครับ | ระบบขึ้น error" still matches
 * on neither — the negation defeats the anchor inside its own clause.
 *
 * Runtime evidence (conversation 99961, 2026-09-18): messages 4016 and 4022
 * carry byte-identical text opening with the vocative "แอดมินคะ". Both were
 * rejected here and reached the LLM, which replied at 12:17:16 that the case
 * had been cancelled while tickets.id=732 stayed untouched until 13:17:35.
 */
const CLAUSE_BOUNDARY =
  /(?<=(?:นะคะ|นะครับ|ค่ะ|คะ|ครับ|คับ|ค้าบ|คร้าบ|จ้า|จ้ะ|งับ|ฮะ|ฮับ|ค่า))\s+/;

/**
 * Splits a message into command-sized clauses, longest-first is not needed —
 * order is preserved so the earliest matching clause wins.
 *
 * Always returns at least one element (the whole message), so a single-clause
 * message behaves exactly as it did before this function existed.
 */
export function splitCommandClauses(text: string): string[] {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const parts = raw.split(CLAUSE_BOUNDARY).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? [raw, ...parts] : [raw];
}

/** Whole-message close request: "ปิดเคส", "ขอปิดเคส TCK-… หน่อยค่ะ", "close case", "ขอปิดเคสนี้ค่ะ", "แก้ได้แล้ว ขอปิดเคสครับ". */
const RESOLVED_PREFIX = "(?:(?:แก้|แก้ไข|ใช้งาน|ทำ|ใช้|เรียบร้อย|เสร็จ|โอเค|ok)(?:ได้)?แล้ว(?:นะคะ|นะครับ|ค่ะ|คะ|ครับ|คับ|จ้า)?\\s*)?";
const CLOSE_REQUEST_RE = new RegExp(
  `^\\s*${RESOLVED_PREFIX}(?:ขอ|อยาก|ช่วย|รบกวน|ต้องการ|จะ|please\\s+)?\\s*(?:ปิดเคส|ปิดตั๋ว|ปิดงาน|ปิดเรื่อง|close\\s+(?:the\\s+)?(?:case|ticket))${CLOSE_OBJECT}${TICKET}${TAIL}${TICKET}${TAIL}$`,
  "i"
);

/** Explicit close confirmation — the chip text, or the same words typed. */
const CONFIRM_CLOSE_RE = new RegExp(
  `^\\s*(?:ยืนยัน\\s*ปิดเคส|ยืนยัน\\s*การปิดเคส|ยืนยันปิด|confirm\\s+close)${TICKET}${TAIL}${TICKET}${TAIL}$`,
  "i"
);

/** A short affirmative that only means "close it" when the close question was just asked. */
const BARE_YES_RE = new RegExp(
  `^\\s*(?:ยืนยัน|ใช่|ใช่เลย|ใช่ค่ะ|ใช่ครับ|ปิดเลย|ปิดได้เลย|ปิดได้|ปิดเคสได้เลย|ปิดเคสเลย|ตกลง|โอเค|ok|okay|yes|confirm|ได้เลย|ได้|เอาเลย|จัดไป|👍|✅)${TAIL}$`,
  "i"
);

/** A refusal to close, meaningful only while the close question is pending. */
const DECLINE_CLOSE_RE = new RegExp(
  `^\\s*(?:ยังไม่ปิด|ยังไม่ต้องปิด|อย่าเพิ่งปิด|ไม่ปิด|ไม่ต้องปิด|ยังก่อน|ยังไม่|ยัง|เดี๋ยวก่อน|รอก่อน|รอแป๊บ|ขอเช็คก่อน|ขอลองก่อน|ขอดูก่อน|ขอทดสอบก่อน|ยกเลิก|ไม่ใช่|ไม่|cancel|not\\s+yet|no|nope|❌)${TAIL}$`,
  "i"
);

/** Identifies complaint / error reports that mention "ปิดเคส" negatively without intent to close. */
export function isNegativeCloseIntent(text: string): boolean {
  return /(?:ปิดเคสไม่ได้|ทำไมปิดเคสไม่ได้|ปิดเคสไม่สำเร็จ|error|ขึ้น error|กดปิดไม่ได้|ปิดตั๋วไม่ได้)/i.test(text);
}

// ---------------------------------------------------------------------------
// Re-open path (operator decisions 2026-09-08)
// ---------------------------------------------------------------------------

/** "Another / new / different problem" — mirrors NEW_ISSUE_NET in the AI gate. */
export const NEW_ISSUE_PATTERN =
  /(?:มี)?อีก\s*(?:ปัญหา|เรื่อง|อัน|เคส|อย่าง)|เรื่องใหม่|ปัญหาใหม่|เคสใหม่|คนละเรื่อง|คนละปัญหา|คนละเคส|ไม่เกี่ยวกับเคส|นอกจากนี้|อีกระบบ|another (?:issue|problem|case)|new (?:issue|problem|case)|separate (?:issue|case)/i;

export type ReopenScope =
  /** The delivered fix did not work: same case, re-open it. */
  | "SAME"
  /** A different problem: leave the case alone, file a new one. */
  | "NEW"
  /** Both signals at once ("ใช้ได้แล้ว แต่…"): ask which. */
  | "AMBIGUOUS"
  | "NONE";

/**
 * What a negative-sounding answer to the delivery message is about.
 *
 * Deterministic tiers, no model: the chips decide outright, explicit
 * new-issue wording wins over rejection words, and a message that praises
 * the fix while complaining about something else is asked about rather than
 * guessed. "อันเดิมใช้ได้แล้ว แต่หน้ารายงานจอขาว" used to read as CONFIRMED
 * because of "ใช้ได้แล้ว".
 */
/** Explicit "same problem" wording — the chip, or the customer's own words. */
export const SAME_ISSUE_PATTERN =
  /(?:^(?:เป็น)?(?:ปัญหา|อาการ|เรื่อง|อัน|เคส)เดิม|(?:^|\s)(?:ปัญหา|อาการ|เรื่อง|อัน|เคส)เดิม|ยังเหมือนเดิม|เหมือนเดิม(?:เลย|ครับ|ค่ะ)?|error\s*เดิม|same (?:bug|issue|problem|error)|อาการเดิมยังไม่หาย|ยังไม่หาย|ยังเป็นอยู่)/i;

/**
 * SAME and NEW need the customer's own words for it (the chips carry them).
 * A bare complaint ("ยังมีปัญหาอยู่", "ยังไม่ผ่าน") is NONE here and the
 * handler asks which it is (operator decision 2026-09-08: always ask). A
 * message that praises the fix while complaining about something else
 * ("อันเดิมใช้ได้แล้ว แต่หน้ารายงานจอขาว") is AMBIGUOUS and is asked the same way.
 */
export function detectReopenScope(text: string, scopePending = false): ReopenScope {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const t = normalize(raw);
  if (!t) return "NONE";

  const hasReject = REJECTION_MARKERS.some((m) => t.includes(normalize(m)));
  // Confirmation words are looked for only outside the rejection phrases:
  // "ไม่ผ่านค่ะ" contains "ผ่านค่ะ" and must not read as praise + complaint.
  const tSansReject = REJECTION_MARKERS.reduce((s, m) => s.split(normalize(m)).join(" "), t);
  const hasConfirm = CONFIRMATION_MARKERS.some((m) => tSansReject.includes(normalize(m)));
  if (hasConfirm && hasReject) return "AMBIGUOUS";
  if (hasConfirm && /แต่|ส่วน|ทว่า|ยกเว้น|however|but /i.test(raw)) return "AMBIGUOUS";

  const hasNew = NEW_ISSUE_PATTERN.test(raw) || /^(?:เป็น)?(?:ปัญหา|เรื่อง)ใหม่/.test(raw);
  const hasSame = SAME_ISSUE_PATTERN.test(raw);
  if (hasNew && !hasSame) return "NEW";
  if (hasSame && !hasNew) return "SAME";
  if (hasNew && hasSame) return "AMBIGUOUS";

  if (scopePending) {
    if (hasReject && !hasNew) return "SAME";
    if (!hasNew && raw.length >= 6) return "SAME";
  }

  return "NONE";
}

/** Explicit re-open confirmation chip: "ยืนยันเปิดเคสอีกครั้ง TCK-…". */
const CONFIRM_REOPEN_RE = new RegExp(
  `^\\s*(?:ยืนยัน\\s*เปิดเคส(?:อีกครั้ง|ใหม่|ซ้ำ)?|confirm\\s+reopen)${TICKET}${TAIL}${TICKET}${TAIL}$`,
  "i"
);

export function detectReopenConfirmation(text: string): { confirmed: boolean; ticketNumber: string | null } {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const num = raw.match(TICKET_NUMBER_PATTERN);
  return { confirmed: CONFIRM_REOPEN_RE.test(raw), ticketNumber: num ? num[0].toUpperCase() : null };
}

/**
 * Classifies a message against the close-confirmation protocol.
 *
 * `closeQuestionPending` tells the detector that the last thing the bot said
 * was the close question (or the "which case" list). Only then do a bare
 * "ยืนยัน"/"ใช่" and a bare "ยังไม่ปิด"/"ยกเลิก" count — outside that context
 * they are ordinary conversation and are left to the AI.
 */
export function detectCloseIntent(text: string, closeQuestionPending = false): CloseIntent {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return { kind: "NONE", ticketNumber: null, isThisCaseRef: false };
  const num = raw.match(TICKET_NUMBER_PATTERN);
  const ticketNumber = num ? num[0].toUpperCase() : null;
  const isThisCaseRef = /(?:เคสนี้|ตั๋วนี้|งานนี้|เรื่องนี้|อันนี้|this\s+case|this\s+ticket)/i.test(raw);

  if (isNegativeCloseIntent(raw)) {
    return { kind: "NONE", ticketNumber, isThisCaseRef: false };
  }

  // Whole message first, then each clause: a command wrapped in a vocative and
  // a reason ("แอดมินคะ ขอปิดเคส … ค่ะ เพราะ…") is still that command.
  const clauses = splitCommandClauses(raw);
  if (clauses.some((c) => CONFIRM_CLOSE_RE.test(c))) return { kind: "CONFIRM_CLOSE", ticketNumber, isThisCaseRef };
  if (clauses.some((c) => CLOSE_REQUEST_RE.test(c))) return { kind: "CLOSE_REQUEST", ticketNumber, isThisCaseRef };

  if (closeQuestionPending) {
    if (DECLINE_CLOSE_RE.test(raw)) return { kind: "DECLINE_CLOSE", ticketNumber, isThisCaseRef };
    if (BARE_YES_RE.test(raw)) return { kind: "CONFIRM_CLOSE", ticketNumber, isThisCaseRef };
    // The "which case" list was answered with just a number.
    if (ticketNumber && raw.replace(TICKET_NUMBER_PATTERN, "").replace(/นะครับ|นะคะ|ครับ|ค่ะ|คับ|จ้า|เคส|\s/g, "") === "") {
      return { kind: "CLOSE_REQUEST", ticketNumber, isThisCaseRef: false };
    }
  }

  return { kind: "NONE", ticketNumber, isThisCaseRef: false };
}

// ---------------------------------------------------------------------------
// Post-ticket cancel (Flow 5, operator decision 2026-09-17)
// ---------------------------------------------------------------------------
//
// "ขอยกเลิกเคส TCK-…" about a case that already exists. Same two-step shape
// as the close protocol: the request only produces a question with chips,
// and only the explicit "ยืนยันยกเลิกเคส <TCK>" chip performs the transition.
//
// A bare "ยกเลิก" is deliberately NOT a cancel request. It already carries
// three meanings decided by context — abort a draft report (the AI gate's
// CANCEL_RESET), decline the close question, decline the re-open question —
// so every pattern here requires the object word (เคส / ตั๋ว / งาน / case /
// ticket). Ambiguity resolves to NONE, never to CONFIRM_CANCEL.

export type CancelIntentKind =
  /** "ยืนยันยกเลิกเคส", "ยืนยันยกเลิกเคส TCK-…", or a bare yes right after the cancel question. */
  | "CONFIRM_CANCEL"
  /** "ไม่ยกเลิก", "ยังไม่ยกเลิก", "ไม่" while the cancel question is pending. */
  | "DECLINE_CANCEL"
  /** "ยกเลิกเคส", "ขอยกเลิกเคส TCK-… ค่ะ", "cancel the ticket": the customer asks to cancel something. */
  | "CANCEL_REQUEST"
  | "NONE";

export interface CancelIntent {
  kind: CancelIntentKind;
  /** Ticket number found in the message, upper-cased, when present. */
  ticketNumber: string | null;
  /**
   * What the customer wrote after "ยกเลิกเคส TCK-…" — their own reason
   * ("คุยกับเจ้าหน้าที่แล้วไม่ต้องย้อนสถานะแล้วค่ะ"). Only a numbered request
   * may carry one; recorded on the case when the cancel is confirmed.
   */
  reason?: string | null;
}

const CANCEL_OBJECT = "(?:the\\s+)?(?:การเปิดเคส|เปิดเคส|การแจ้งเคส|แจ้งเคส|เคส|ตั๋ว|งาน|case|ticket)";

/**
 * How a Thai customer opens a request to a person: "แอดมินคะ", "พี่แอดมินครับ",
 * "สวัสดีค่ะ แอดมิน". Seen live 2026-09-18: "แอดมินคะ ขอยกเลิกเคส TCK-… ให้หน่อยค่ะ …"
 * missed the whole-message rule and the AI answered with the draft-cancel line.
 */
const VOCATIVE =
  "(?:\\s*(?:สวัสดี|หวัดดี|แอดมิน|admin|พี่|คุณ|น้อง|ทีมงาน|เจ้าหน้าที่)(?:\\s*(?:คะ|ค่ะ|ครับ|คับ|ค้าบ|จ้า|จ๊ะ))?\\s*[,]?)*";

const CANCEL_VERB = `(?:ขอ|อยาก|ช่วย|รบกวน|ต้องการ|จะ|please\\s+)?\\s*(?:ยกเลิก|cancel)\\s*${CANCEL_OBJECT}(?:\\s*(?:นี้|นั้น|เดิม|ที่แจ้ง(?:ไว้)?))?`;

/**
 * Negative cancel markers: statements that mention cancelling negatively or as an error/question,
 * not an actual intent to cancel the ticket.
 */
export function isNegativeCancelIntent(text: string): boolean {
  return /(?:ยกเลิก(?:เคส|ตั๋ว|งาน)?ไม่ได้|ทำไมยกเลิก(?:เคส|ตั๋ว|งาน)?ไม่ได้|ยกเลิก(?:เคส|ตั๋ว|งาน)?ไม่สำเร็จ|error|ขึ้น error|กด(?:ปุ่ม)?ยกเลิก(?:เคส|ตั๋ว|งาน)?ไม่ได้|ยกเลิกตั๋วไม่ได้|ไม่ต้องยกเลิก|อย่า(?:เพิ่ง)?ยกเลิก|ทำไม(?:เคส|ตั๋ว)ถึงถูกยกเลิก)/i.test(text);
}

/** Whole-message cancel request. Exported so the pre-router can route on the same rule. */
export const CANCEL_TICKET_PATTERN = new RegExp(
  `^${VOCATIVE}\\s*${CANCEL_VERB}(?:\\s*[^\\n,.:;–-]*?)?${TICKET}${TAIL}${TICKET}${TAIL}$`,
  "i"
);

/**
 * A cancel request that names the case and goes on to say why. The number
 * makes the object unambiguous, so the trailing clause is the customer's
 * reason rather than a report that happens to contain "ยกเลิกเคส" (those stay
 * with the whole-message rule above and are NONE without a number).
 */
const CANCEL_WITH_REASON_PATTERN = new RegExp(
  `^${VOCATIVE}\\s*${CANCEL_VERB}\\s*(?:เคส|ticket|เลข|หมายเลข)?\\s*(TCK-\\d{4}-\\d{4,6})${TAIL}[\\s,.:;–-]*(.*)$`,
  "i"
);

/** Explicit cancel confirmation — the chip text, or the same words typed. */
const CONFIRM_CANCEL_RE = new RegExp(
  `^\\s*(?:ยืนยัน\\s*(?:การ)?ยกเลิก(?:เคส|ตั๋ว|งาน)?|confirm\\s+cancel(?:lation)?)${TICKET}${TAIL}${TICKET}${TAIL}$`,
  "i"
);

/** A refusal to cancel, meaningful only while the cancel question is pending. */
const DECLINE_CANCEL_RE = new RegExp(
  `^\\s*(?:ไม่ยกเลิก|ไม่ต้องยกเลิก|ยังไม่ยกเลิก|อย่าเพิ่งยกเลิก|อย่ายกเลิก|ไม่ยกเลิกแล้ว|เก็บไว้ก่อน|ทำต่อ(?:เลย|ได้เลย)?|ดำเนินการต่อ|ไม่ใช่|ไม่|ยังก่อน|เดี๋ยวก่อน|no|nope|keep\\s+it|❌)${TAIL}$`,
  "i"
);

/**
 * Classifies a message against the post-ticket cancel protocol.
 *
 * `cancelQuestionPending` tells the detector that the last thing the bot said
 * was the cancel question. Only then do a bare "ยืนยัน"/"ใช่" and a bare
 * "ไม่"/"ยังก่อน" count — outside that context they belong to other
 * protocols (create confirmation, close question) and are left alone.
 */
export function detectCancelIntent(text: string, cancelQuestionPending = false): CancelIntent {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return { kind: "NONE", ticketNumber: null };
  const num = raw.match(TICKET_NUMBER_PATTERN);
  const ticketNumber = num ? num[0].toUpperCase() : null;

  if (isNegativeCancelIntent(raw)) {
    return { kind: "NONE", ticketNumber };
  }

  // Whole message first, then each clause — same rule as detectCloseIntent.
  const clauses = splitCommandClauses(raw);
  if (clauses.some((c) => CONFIRM_CANCEL_RE.test(c))) return { kind: "CONFIRM_CANCEL", ticketNumber };
  if (clauses.some((c) => CANCEL_TICKET_PATTERN.test(c))) return { kind: "CANCEL_REQUEST", ticketNumber };
  if (CANCEL_WITH_REASON_PATTERN.test(raw)) {
    const m = raw.match(CANCEL_WITH_REASON_PATTERN);
    return { kind: "CANCEL_REQUEST", ticketNumber: m?.[1]?.toUpperCase() || ticketNumber, reason: m?.[2]?.trim() || null };
  }

  if (cancelQuestionPending) {
    if (DECLINE_CANCEL_RE.test(raw)) return { kind: "DECLINE_CANCEL", ticketNumber };
    if (BARE_YES_RE.test(raw)) return { kind: "CONFIRM_CANCEL", ticketNumber };
  }

  return { kind: "NONE", ticketNumber };
}
