import { sanitizeSensitiveData } from "../domain/diagnostic/DeveloperDiagnostic";

/**
 * Secret redaction for customer text that leaves the backend (PromptX
 * gateway, summary prompts, logs).
 *
 * Scope is secrets only, by operator decision (2026-10-01): passwords,
 * tokens, API keys, JWTs. Contact details (email, phone) are deliberately
 * kept on the live chat path because the flow may need them to follow up or
 * open a ticket; the summary path additionally applies minimizePii.
 *
 * A credential typed by a customer is never needed downstream: the bot must
 * not handle passwords at all, so masking it loses nothing.
 */

export const REDACTED_SECRET = "[REDACTED_SECRET]";

// Thai and English credential keywords. Longer alternatives first so
// "รหัสผ่าน" wins over "รหัส".
const KEYWORDS =
  "รหัสผ่าน|พาสเวิร์ด|พาสเวิด|รหัส\\s*otp|รหัส\\s*pin|รหัสpin|รหัส|พาส|passwords?|passcode|passwd|pwd|pin|otp";

// A value: any run of non-space, non-Thai characters. Thai words after a
// keyword ("ลืมรหัสผ่านครับ") are never a secret value. Ticket numbers
// ("รหัส: TCK-000123") are references the flow needs, not secrets.
const VALUE = "(?!TCK-?\\d)[^\\s\\u0E00-\\u0E7F]{3,}";

// Optional qualifier between keyword and value: "รหัสผ่านใหม่", "รหัสผ่านผม", "รหัสของหนู".
const OWNER_WORD = "(?:ใหม่|เดิม|(?:ของ)?\\s*(?:ผม|ฉัน|หนู|เรา|ดิฉัน|เค้า|เขา))";
const OWNER = `${OWNER_WORD}?`;

// English keywords must not be the tail of a longer word ("spin", "shotp").
const KW = `(?<![A-Za-z])(${KEYWORDS})`;

// "รหัสผ่าน: abc", "password = abc", "รหัสคือ abc", "พาสเป็น abc", "รหัสใหม่ว่า abc"
const EXPLICIT_RE = new RegExp(
  `${KW}(\\s*${OWNER}\\s*(?::|=|คือ|เป็น|ว่า)\\s*)(${VALUE})`,
  "gi"
);

// "password abc123", "รหัสผ่าน Abc@1234" — no separator, so the value must
// contain a digit to count. Keeps "password reset" / "pin code" untouched.
const IMPLICIT_RE = new RegExp(`${KW}((?:\\s*${OWNER_WORD})?\\s+)((?=[^\\s\\u0E00-\\u0E7F]*\\d)${VALUE})`, "gi");

/** Masks credentials in free text. Idempotent; safe on any string. */
export function redactSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const out = sanitizeSensitiveData(text)
    .replace(EXPLICIT_RE, (m, kw: string, sep: string, value: string) =>
      value === REDACTED_SECRET ? m : `${kw}${sep}${REDACTED_SECRET}`
    )
    .replace(IMPLICIT_RE, (m, kw: string, sep: string, value: string) =>
      value === REDACTED_SECRET ? m : `${kw}${sep}${REDACTED_SECRET}`
    );
  return out;
}

/** True when redaction would change the text. */
export function containsSecret(text: string): boolean {
  return typeof text === "string" && redactSecrets(text) !== text;
}

/**
 * Returns a copy of a LINE gateway payload (`{ destination, events, ... }`)
 * with every text message redacted. The input is never mutated; non-text
 * events and all other fields pass through unchanged.
 */
export function redactLineGatewayPayload<T>(payload: T): T {
  const p = payload as any;
  if (!p || !Array.isArray(p.events)) return payload;
  let changed = false;
  const events = p.events.map((event: any) => {
    const text = event?.message?.text;
    if (typeof text !== "string") return event;
    const redacted = redactSecrets(text);
    if (redacted === text) return event;
    changed = true;
    return { ...event, message: { ...event.message, text: redacted } };
  });
  return changed ? ({ ...p, events } as T) : payload;
}
