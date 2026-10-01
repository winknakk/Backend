/**
 * Deterministic customer-message safety guard.
 *
 * Classifies a customer message into the few categories where the AI must not
 * act or answer on its own, and must hand the conversation to a person:
 *
 *   CREDENTIAL_REQUEST   asks the bot/support to reset, set, create, send or
 *                        reveal a password (for themselves or someone else).
 *   CREDENTIAL_SHARED    the message itself contains a password/OTP value.
 *   ACCOUNT_DISCLOSURE   asks whether another person has an account, or what
 *                        their role / approval level / account status is.
 *   CRITICAL_INCIDENT    orders to stop the server / the AI / everything, or
 *                        reports a security incident.
 *
 * Operator policy (2026-10-01 task brief): for these the AI MUST NOT act,
 * MUST NOT claim anything was done ("ดำเนินการแล้ว", "หยุดแล้ว", "แก้แล้ว"),
 * and MUST escalate to a human. Evidence: PM1 UAT cases 23-25 (password),
 * 37 (account/role), 39 (stop server and AI). See .ai/PM1_VERIFICATION_QUESTIONS.md.
 *
 * Deliberately NOT guarded: a customer REPORTING a login/password problem
 * ("กดลืมรหัสผ่านแล้วไม่ได้รับอีเมล", "ตั้งรหัสผ่านใหม่แล้วขึ้น error") or an
 * outage ("ระบบหยุดทำงาน"). Those are normal support cases and must still
 * reach intake.
 *
 * Pure: no I/O, no model. Callers decide what to do with the verdict.
 */

export type SafetyCategory = "CREDENTIAL_REQUEST" | "CREDENTIAL_SHARED" | "ACCOUNT_DISCLOSURE" | "CRITICAL_INCIDENT";

export interface SafetyVerdict {
  category: SafetyCategory | "NONE";
  /** True when the AI must stop autonomous handling and hand off to a human. */
  requiresHuman: boolean;
  /** Stable machine reason for takeover/audit records. Never contains message text. */
  reasonCode: string | null;
}

const NONE: SafetyVerdict = { category: "NONE", requiresHuman: false, reasonCode: null };

const verdict = (category: SafetyCategory): SafetyVerdict => ({
  category,
  requiresHuman: true,
  reasonCode: `SAFETY_${category}`,
});

const PASSWORD = String.raw`(?:รหัส\s*ผ่าน|พาส\s*เวิร์ด|พาสเวิด|password|passcode|pass\s*word)`;

/** A value follows the password word: "รหัสผ่านคือ Abc12345", "password: x9!k". */
const CREDENTIAL_VALUE = new RegExp(
  String.raw`${PASSWORD}\s*(?:ของ\S*\s*)?(?:คือ|=|:|เป็น|ใช้)\s*["'“]?[^\s"'”]{4,}` +
    String.raw`|\b(?:otp|รหัส\s*otp)\s*(?:คือ|=|:)?\s*\d{4,8}\b`,
  "i"
);

/** Asking someone to perform or reveal a credential action. */
const CREDENTIAL_ACTION = new RegExp(
  String.raw`(?:รีเซ็[ตท]|reset|ตั้ง(?:ค่า)?|กำหนด|สร้าง|เปลี่ยน|ส่ง|บอก|แจ้ง|ขอ|เปิดเผย|เซ็[ตท]|set)\s*(?:ให้\s*)?(?:ใหม่\s*)?${PASSWORD}` +
    String.raw`|${PASSWORD}\s*(?:ใหม่\s*)?(?:ให้|แทน)`,
  "i"
);

/** Request markers: the customer is asking for something to be done. */
const REQUEST_MARKER =
  /(?:ขอ|ช่วย|รบกวน|ฝาก|ได้ไหม|ได้มั้ย|ได้หรือไม่|หน่อย|ให้ด้วย|ให้ที|ให้หน่อย|please|can you|could you)/i;

/** Problem-report markers: something failed; this is a support case, not a request. */
const PROBLEM_MARKER =
  /(?:error|เออเร่อ|ไม่ได้|ไม่สามารถ|ขึ้นว่า|ขึ้นแบบนี้|หมดอายุ|ไม่ได้รับ|ไม่เข้า|ค้าง|ผิดพลาด|ไม่ผ่าน|ไม่ทำงาน|expired|failed|doesn'?t work)/i;

/** Another person's account: existence, role, approval level, status. */
const ACCOUNT_SUBJECT = /(?:บัญชี(?:ผู้ใช้)?|ยูส(?:เซอร์)?|user(?:name)?|account|ไอดี|id\s*ผู้ใช้)/i;
const ACCOUNT_ATTRIBUTE =
  /(?:มี\s*(?:บัญชี|ยูส|user|account)|เป็น(?:ระดับ|สิทธิ์|role)|ระดับ(?:ผู้)?(?:อนุมัติ|approver|admin|updater)|สิทธิ์|role|approver|ผู้อนุมัติ|สถานะบัญชี|account status|ถูกระงับ|ถูกล็อก|locked)/i;
/** A role/level word is enough on its own ("คนนี้เป็นระดับผู้อนุมัติใช่ไหม"). */
const ROLE_WORD = /(?:ระดับ|สิทธิ์|role|approver|ผู้อนุมัติ|admin)/i;
// Bare "คุณ…" is not a third-party marker: "คุณช่วย…" / "คุณสามารถ…" address the bot.
const THIRD_PARTY =
  /(?:คนนี้|บุคคลนี้|ท่านนี้|รายนี้|ชื่อ\s*\S|นาย\s*\S|นาง(?:สาว)?\s*\S|ผู้ใช้\s*(?:ท่าน|คน)?นี้|ของ\s*(?:เขา|เธอ|ท่าน|พี่|น้อง)|someone|this (?:person|user)|another user)/i;
const QUESTION = /(?:ไหม|มั้ย|มั๊ย|หรือเปล่า|รึเปล่า|หรือไม่|ใช่ไหม|ใช่มั้ย|อะไร|ระดับไหน|\?)/;

/** Stop orders aimed at the server / AI / everything (target AFTER the verb). */
const STOP_ORDER = new RegExp(
  String.raw`(?:หยุด|ปิด|ระงับ|ยุติ|stop|shut\s*down|kill|turn\s*off|disable)\s*(?:การ\s*)?(?:ทำงาน\s*)?(?:ของ\s*)?` +
    String.raw`(?:server|เซิร์ฟเวอร์|เซิฟเวอร์|เซิฟ|ระบบ\s*ทั้งหมด|ทุกอย่าง|ทุกระบบ|ai|เอไอ|บอท|bot|automation)` +
    String.raw`|(?:server|เซิร์ฟเวอร์|เซิฟเวอร์|ai|เอไอ|บอท)[^\n]{0,40}(?:ให้\s*)?หยุด(?:ก่อน|ทันที|เดี๋ยวนี้)` +
    String.raw`|ให้\s*หยุด(?:ก่อน|ทันที|ทั้งหมด)`,
  "i"
);

/** Security incident reports. */
const SECURITY_INCIDENT =
  /(?:ถูก\s*แฮ[็]?[กค]|โดน\s*แฮ[็]?[กค]|hack(?:ed)?|ข้อมูล\s*(?:รั่ว|หลุด)|รั่วไหล|data\s*(?:breach|leak)|breach|ransomware|มัลแวร์|malware|ไวรัส|security incident|เข้าถึงโดยไม่ได้รับอนุญาต|unauthori[sz]ed access|มีคนเข้า\s*(?:server|เซิร์ฟเวอร์|ระบบ)\s*โดยไม่)/i;

/** Classify one customer message. Order matters: the most severe category wins. */
export function classifyCustomerSafety(text: string): SafetyVerdict {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return NONE;

  if (STOP_ORDER.test(raw) || SECURITY_INCIDENT.test(raw)) return verdict("CRITICAL_INCIDENT");

  if (CREDENTIAL_VALUE.test(raw)) return verdict("CREDENTIAL_SHARED");

  if (CREDENTIAL_ACTION.test(raw)) {
    const isRequest = REQUEST_MARKER.test(raw);
    const isProblem = PROBLEM_MARKER.test(raw);
    // "ช่วยรีเซ็ตรหัสผ่านให้หน่อย" is a request; "ตั้งรหัสผ่านใหม่แล้วขึ้น error" is a problem report.
    if (isRequest && !isProblem) return verdict("CREDENTIAL_REQUEST");
  }

  if (
    ACCOUNT_ATTRIBUTE.test(raw) &&
    (ACCOUNT_SUBJECT.test(raw) || ROLE_WORD.test(raw)) &&
    THIRD_PARTY.test(raw) &&
    QUESTION.test(raw)
  ) {
    return verdict("ACCOUNT_DISCLOSURE");
  }

  return NONE;
}

/**
 * Customer-facing reply for a guarded message. It promises only what the
 * caller has actually done (handed the conversation to a person) and never
 * claims the requested action happened.
 */
export function safetyHandoffReply(category: SafetyCategory): string {
  switch (category) {
    case "CREDENTIAL_SHARED":
      return "เพื่อความปลอดภัย รบกวนอย่าส่งรหัสผ่านหรือรหัส OTP ในแชตนะคะ เรื่องนี้แอดมินได้ส่งต่อให้เจ้าหน้าที่ดูแลต่อแล้วค่ะ";
    case "CREDENTIAL_REQUEST":
      return "เรื่องรหัสผ่านต้องให้เจ้าหน้าที่ที่ได้รับสิทธิ์ดำเนินการโดยตรงค่ะ แอดมินส่งต่อให้เจ้าหน้าที่ดูแลต่อแล้วนะคะ";
    case "ACCOUNT_DISCLOSURE":
      return "ข้อมูลบัญชีผู้ใช้ของบุคคลอื่นต้องให้เจ้าหน้าที่ที่ได้รับสิทธิ์ตรวจสอบค่ะ แอดมินส่งต่อให้เจ้าหน้าที่ดูแลต่อแล้วนะคะ";
    case "CRITICAL_INCIDENT":
      return "รับทราบค่ะ เรื่องนี้เร่งด่วน แอดมินส่งต่อให้เจ้าหน้าที่ดูแลต่อทันทีแล้วนะคะ";
  }
}
