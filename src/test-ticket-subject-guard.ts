/**
 * The subject guard: a ticket whose subject is only the customer's trigger
 * phrase is an empty case. Evidence: tickets#746 TCK-2026-81490,
 * subject "เปิดเคสใหม่", created 2026-09-18 14:15:30 in conversation 99961.
 *
 * The accept half is the one that can do damage — refusing a real report is
 * worse than filing a thin one, so every realistic short report below must
 * pass through untouched.
 *
 * Self-contained: pure function, no DB.
 */
import { isCommandOnlySubject } from "./domain/ticket/TicketSubject";

const REJECT: [string, string][] = [
  ["เปิดเคสใหม่", "the exact production defect (ticket #746)"],
  ["แจ้งปัญหาใหม่", "P0 trigger chip"],
  ["เปิดเคสใหม่ค่ะ", "with a polite particle"],
  ["+ แจ้งปัญหาใหม่", "chip text with the decoration LINE adds"],
  ["/new_case", "slash command form"],
  ["report_issue", "raw action id"],
  ["มีอีกปัญหา", "trigger with no problem attached"],
  ["ดูเคสล่าสุดทั้งหมด", "a navigation chip must never become a case"],
  ["ตรวจสอบสถานะ", "status chip"],
  ["ยืนยัน", "the confirm chip"],
  ["ใช้งานได้แล้ว", "a delivery answer, not a problem"],
  ["ยังมีปัญหาอยู่", "a delivery answer with no detail"],
  ["", "empty subject"],
  ["   ", "whitespace only"],
  ["...", "punctuation only"],
  ["ครับ", "politeness only"],
];

const ACCEPT: [string, string][] = [
  ["ระบบเบิกค่าการศึกษาบุตร - ไม่มีระดับการศึกษาระดับ ปวส.ให้เลือก", "the real ticket #745"],
  ["ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก", "the real ticket #731"],
  ["เข้าระบบไม่ได้", "a short but genuine report"],
  ["ปริ้นใบเสร็จไม่ออก", "short report"],
  ["ลืมรหัสผ่าน", "two words, still a problem"],
  ["เปิดเคสใหม่ ปริ้นใบเสร็จไม่ออกค่ะ", "trigger PLUS a problem — must pass"],
  ["แจ้งปัญหาใหม่: ระบบลางานกดไม่ได้", "trigger with a colon and a problem"],
  ["ปิดเคสไม่ได้", "a report ABOUT closing is a real problem"],
  ["ยกเลิกเคสไม่สำเร็จ ขึ้น error 500", "a report about cancelling"],
  ["ตรวจสอบสถานะแล้วขึ้นหน้าว่าง", "a report that starts with a chip word"],
];

let failed = 0;
for (const [subject, why] of REJECT) {
  if (!isCommandOnlySubject(subject)) {
    console.log(`  ✗ ควรปฏิเสธแต่ผ่าน: "${subject}"  [${why}]`);
    failed += 1;
  }
}
for (const [subject, why] of ACCEPT) {
  if (isCommandOnlySubject(subject)) {
    console.log(`  ✗ ควรผ่านแต่ถูกปฏิเสธ: "${subject}"  [${why}]`);
    failed += 1;
  }
}

const total = REJECT.length + ACCEPT.length;
console.log(`\nsubject guard — ${total} เช็ค (ปฏิเสธ ${REJECT.length} / ผ่าน ${ACCEPT.length})`);

// --- wiring: the predicate is useless unless createTicket actually calls it --
// The guard runs before any DB work, so a stub adapter is enough. If the guard
// were removed, this reaches the repository and fails differently (or throws),
// which is exactly the regression this assertion is here to catch.
(async () => {
  const { TicketService } = await import("./tools/TicketService");
  const stubAdapter: any = {
    createTicket: async () => {
      throw new Error("GUARD BYPASSED: reached the adapter with a command-only subject");
    },
  };
  const svc = new TicketService(stubAdapter);
  const result = await svc.createTicket({
    conversationId: "99961",
    subject: "เปิดเคสใหม่",
    summary: "เปิดเคสใหม่",
    severity: "Medium",
    priority: "P3",
    projectId: "101",
  } as any);

  let wiringFailed = 0;
  if (result.success !== false) {
    console.log("  ✗ createTicket ยอมรับ subject ที่เป็นคำสั่งล้วน");
    wiringFailed += 1;
  }
  if (!String(result.error ?? "").startsWith("SUBJECT_IS_COMMAND_NOT_PROBLEM")) {
    console.log(`  ✗ error ไม่ตรง: ${JSON.stringify(result.error)}`);
    wiringFailed += 1;
  }
  console.log(`wiring — createTicket ปฏิเสธจริง: ${wiringFailed === 0 ? "ใช่" : "ไม่"}`);

  if (failed + wiringFailed) {
    console.log(`พลาด ${failed + wiringFailed} ข้อ`);
    process.exit(1);
  }
  console.log("ผ่านทั้งหมด");
})().catch((err) => {
  console.log("ERR", err.message);
  process.exit(1);
});
