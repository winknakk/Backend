import { containsSecret } from "../../security/secretRedaction";

/**
 * Deterministic support-safety classifier for customer messages.
 *
 * The flow's LLM prompts carry the same rules as text, but a prompt is not
 * enforcement. This runs in the backend on every inbound LINE/WebChat turn,
 * before the message reaches PromptX, and its result travels beside the
 * message (`ticketx.safety` / `safety_category`) so the gate can route on a
 * fact instead of the model's reading of the text.
 *
 * Categories, most severe first:
 * - critical_incident: a request to stop a server/system/AI, or a reported
 *   security incident or data leak. The bot must not act or claim action;
 *   a human must decide. (PM1 case 39.)
 * - credential_shared: the customer typed a password/token into the chat.
 * - account_disclosure: asks whether a person has an account. Not answered
 *   in chat. (PM1 case 37.)
 * - privilege_disclosure: asks what role/permission level someone holds.
 * - credential_request: asks support to set/reveal/reset a password. The
 *   bot never does this itself; only an authorized human flow can. (PM1 case 24.)
 *
 * Patterns are conservative on purpose: an outage report ("ระบบหยุดทำงาน"),
 * a forgotten-password bug ("กดลืมรหัสผ่านแล้วไม่ได้รับอีเมล") or a missing
 * permission bug ("ไม่มีสิทธิ์อนุมัติ") must not be classified.
 */

export type SupportSafetyCategory =
  | "critical_incident"
  | "credential_shared"
  | "account_disclosure"
  | "privilege_disclosure"
  | "credential_request";

/** What the system must do: escalate to a human, refuse self-service, or warn the customer. */
export type SupportSafetyAction = "escalate" | "no_self_service" | "warn";

export interface SupportSafetyResult {
  category: SupportSafetyCategory;
  action: SupportSafetyAction;
  /** Every category that matched, most severe first. */
  categories: SupportSafetyCategory[];
}

const ACTION: Record<SupportSafetyCategory, SupportSafetyAction> = {
  critical_incident: "escalate",
  credential_shared: "warn",
  account_disclosure: "escalate",
  privilege_disclosure: "escalate",
  credential_request: "no_self_service",
};

const ORDER: SupportSafetyCategory[] = [
  "critical_incident",
  "credential_shared",
  "account_disclosure",
  "privilege_disclosure",
  "credential_request",
];

// "หยุด" as a command, not "หยุดทำงาน" (stopped working) or "ไม่หยุด" (won't stop).
const STOP_VERB = "(?<!ไม่\\s*)(?:หยุด|ระงับ)(?!\\s*(?:ทำงาน|ตอบสนอง|ค้าง|นิ่ง|หมุน|ไป|เอง))";
const STOP_TARGET = "(?:server|เซิร์ฟเวอร์|เซิฟเวอร์|เซิร์ฟ|เซิฟ|ระบบ|\\bai\\b|เอไอ|บอท|\\bbot\\b|ทุกอย่าง|ทั้งหมด|\\bcpu\\b|ซีพียู)";

const CRITICAL_PATTERNS: RegExp[] = [
  new RegExp(`${STOP_VERB}[\\s\\S]{0,40}?${STOP_TARGET}`, "i"),
  new RegExp(`(?:server|เซิร์ฟเวอร์|เซิฟเวอร์)[\\s\\S]{0,40}?${STOP_VERB}`, "i"),
  /ปิด\s*(?:server|เซิร์ฟเวอร์|เซิฟเวอร์|เซิร์ฟ|เซิฟ|\bai\b|เอไอ|บอท|ทุกอย่าง|ระบบทั้งหมด)/i,
  /\b(?:shut\s*down|stop)\s+(?:the\s+)?(?:server|system|ai|bot|everything)\b/i,
  /ข้อมูล\s*(?:รั่ว|หลุด)/,
  /\bdata\s*(?:leak|breach)/i,
  /\bsecurity\s*incident/i,
  /(?:โดน|ถูก)\s*(?:แฮก|แฮ็ก|แฮ็ค|แฮค|hack)/i,
  /\b(?:ransomware|malware)\b|มัลแวร์/i,
];

const ACCOUNT_TERM = "(?:user|ยูสเซอร์|ยูส|บัญชีผู้ใช้|บัญชี|account|username)";
const QUESTION = "(?:ไหม|มั้ย|มั๊ย|หรือไม่|หรือยัง|หรือเปล่า|รึยัง|รึเปล่า|ใช่ไหม|ใช่มั้ย)";

const ACCOUNT_PATTERNS: RegExp[] = [
  new RegExp(`(?<!ไม่\\s*)มี\\s*${ACCOUNT_TERM}\\s*(?:อยู่\\s*)?(?:ในระบบ\\s*)?${QUESTION}`, "i"),
  /\b(?:does|is there)\b[\s\S]{0,40}\b(?:have an? )?account\b/i,
];

const PRIVILEGE_PATTERNS: RegExp[] = [
  new RegExp(`(?<!ไม่\\s*)(?:เป็น|มี)\\s*(?:ระดับ|สิทธิ์|สิทธิ|role|บทบาท)[\\s\\S]{0,30}?(?:อะไร|ไหน|ใด|${QUESTION})`, "i"),
  /(?:สิทธิ์|สิทธิ|role|บทบาท)\s*(?:ของ)\s*(?:คุณ|นาย|นาง|น\.ส\.|user|ผู้ใช้)/i,
  /\bwhat\s+(?:role|permissions?)\s+does\b/i,
];

const CREDENTIAL_REQUEST_PATTERNS: RegExp[] = [
  /(?:ขอ|บอก|ส่ง|แจ้ง|กำหนด|ตั้ง|รีเซ็ต|รีเซต|reset|เปลี่ยน)\s*(?:รหัสผ่าน|พาสเวิร์ด|password)(?:ใหม่)?\s*(?:ให้|หน่อย|ที|ได้ไหม|ได้มั้ย)/i,
  /(?:รหัสผ่าน|password)\s*(?:ของ\S*\s*)?(?:คือ)?อะไร/i,
  /\breset\s+(?:my\s+|the\s+|his\s+|her\s+)?password\b/i,
  /\bwhat\s+is\s+(?:my|the|his|her)\s+password\b/i,
];

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

/** Classifies one customer message (or a joined batch). Null when nothing matched. */
export function classifySupportSafety(text: string | null | undefined): SupportSafetyResult | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const hits = new Set<SupportSafetyCategory>();
  if (anyMatch(CRITICAL_PATTERNS, text)) hits.add("critical_incident");
  if (containsSecret(text)) hits.add("credential_shared");
  if (anyMatch(ACCOUNT_PATTERNS, text)) hits.add("account_disclosure");
  if (anyMatch(PRIVILEGE_PATTERNS, text)) hits.add("privilege_disclosure");
  if (anyMatch(CREDENTIAL_REQUEST_PATTERNS, text)) hits.add("credential_request");
  if (hits.size === 0) return null;
  const categories = ORDER.filter((c) => hits.has(c));
  return { category: categories[0], action: ACTION[categories[0]], categories };
}

/**
 * Safety hint for a LINE gateway payload: classifies the text of all events
 * together (a batch is one customer turn). Must run on the raw text, before
 * secret redaction, or a shared credential would go unnoticed.
 */
export function safetyHintForLineEvents(events: any[] | null | undefined): SupportSafetyResult | null {
  if (!Array.isArray(events)) return null;
  const text = events
    .map((e) => (e?.message?.type === "text" && typeof e.message.text === "string" ? e.message.text : ""))
    .filter(Boolean)
    .join("\n");
  return classifySupportSafety(text);
}
