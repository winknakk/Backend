/**
 * CaseResolver — ทดสอบด้วยภาษาที่ลูกค้าจริงใช้ (ไม่พิมพ์เลขตั๋ว)
 *
 * เดโมที่รันอยู่ ลูกค้าพิมพ์เลขตั๋วเองถึง 5 ครั้ง ซึ่งคนจริงไม่ทำ
 * สคริปต์นี้เอาเคสจริงจาก conversation 99961 มาเป็นฉาก แล้วยิงประโยคแบบที่
 * คนพูดจริง เพื่อดูว่า resolver แยกออกกี่ประโยค และพังตรงไหน
 *
 * READ-ONLY: อ่าน candidate จาก DB แล้วเรียก resolver ตรงๆ ไม่เขียนอะไรเลย
 */
import { pool } from "./adapters/postgres/PostgresAdapter";
import { caseResolver, type CaseCandidate } from "./domain/case/CaseResolver";

type Expect = "SWITCH_73046" | "SWITCH_86186" | "AMBIGUOUS" | "NEW" | "CONTINUE" | "ANY";

interface Probe {
  id: string;
  text: string;
  /** เคสที่โฟกัสอยู่ก่อนพูดประโยคนี้ */
  active: "73046" | "86186" | null;
  expect: Expect;
  note: string;
}

const PROBES: Probe[] = [
  // ── กลุ่ม A: อ้างถึงเคสด้วยชื่อระบบ (คนจริงพูดแบบนี้) ───────────────
  { id: "A1", text: "เรื่องเงินยืมถึงไหนแล้วคะ", active: null, expect: "SWITCH_73046", note: "ชื่อระบบเด่นชัด" },
  { id: "A2", text: "ขอถามเรื่องชดใช้เงินยืมหน่อยค่ะ", active: null, expect: "SWITCH_73046", note: "ชื่อเต็ม" },
  { id: "A3", text: "เรื่องเว็บเข้าไม่ได้ถึงไหนแล้ว", active: null, expect: "SWITCH_86186", note: "อาการเด่นชัด" },
  { id: "A4", text: "เรื่องใบเสร็จเล่ม 05 คะ", active: null, expect: "SWITCH_73046", note: "รายละเอียดเฉพาะ" },
  { id: "A5", text: "อันที่เกี่ยวกับการชำระเงินค่ะ", active: null, expect: "SWITCH_73046", note: "คำใกล้เคียง ไม่ตรงเป๊ะ" },

  // ── กลุ่ม B: กำกวมจริง ควรถาม ───────────────────────────────────────
  { id: "B1", text: "แล้วเรื่องระบบล่ะคะ มีใครดูให้หรือยัง", active: null, expect: "AMBIGUOUS", note: "ประโยคจริงจากเดโม" },
  { id: "B2", text: "เรื่องที่แจ้งไปถึงไหนแล้ว", active: null, expect: "AMBIGUOUS", note: "ไม่ระบุอะไรเลย" },
  { id: "B3", text: "ขอตามเรื่องหน่อยค่ะ", active: null, expect: "AMBIGUOUS", note: "สั้นและกว้าง" },

  // ── กลุ่ม C: อ้างถึงด้วยเวลา (คนจริงพูดบ่อยมาก) ─────────────────────
  { id: "C1", text: "เรื่องที่แจ้งเมื่อวานถึงไหนแล้วคะ", active: null, expect: "ANY", note: "อ้างด้วยเวลา — resolver รองรับไหม" },
  { id: "C2", text: "อันที่แจ้งเมื่อเช้าค่ะ", active: null, expect: "ANY", note: "อ้างด้วยเวลา" },
  { id: "C3", text: "เรื่องล่าสุดที่คุยกันค่ะ", active: null, expect: "ANY", note: "อ้างด้วยลำดับ" },

  // ── กลุ่ม D: คุยต่อในเคสเดิม ────────────────────────────────────────
  { id: "D1", text: "ยังไม่ได้เลยค่ะ", active: "73046", expect: "CONTINUE", note: "คำสั้น ต้องอยู่เคสเดิม" },
  { id: "D2", text: "ขอบคุณค่ะ", active: "73046", expect: "CONTINUE", note: "คำขอบคุณ" },
  { id: "D3", text: "ส่งรูปเพิ่มให้แล้วนะคะ", active: "86186", expect: "CONTINUE", note: "ต่อยอดเคสเดิม" },

  // ── กลุ่ม E: ยกเลิก / ปิด โดยไม่บอกเลขตั๋ว ──────────────────────────
  { id: "E1", text: "ขอยกเลิกเรื่องเงินยืมค่ะ ไม่ต้องแล้ว", active: null, expect: "SWITCH_73046", note: "ยกเลิกด้วยชื่อระบบ" },
  { id: "E2", text: "เรื่องเว็บใช้ได้แล้วค่ะ ปิดได้เลย", active: null, expect: "SWITCH_86186", note: "ปิดด้วยอาการ" },
  { id: "E3", text: "ปิดเคสให้หน่อยค่ะ", active: "73046", expect: "CONTINUE", note: "ปิดโดยไม่ระบุ มีเคสโฟกัสอยู่" },
  { id: "E4", text: "ปิดเคสให้หน่อยค่ะ", active: null, expect: "AMBIGUOUS", note: "ปิดโดยไม่ระบุ ไม่มีโฟกัส — อันตรายถ้าเดา" },

  // ── กลุ่ม F: ปัญหาใหม่ ต้องไม่ปนเคสเดิม ─────────────────────────────
  { id: "F1", text: "มีอีกปัญหาค่ะ ปริ้นใบเสร็จไม่ออก", active: "73046", expect: "NEW", note: "บอกชัดว่าเรื่องใหม่" },
  { id: "F2", text: "ขอแจ้งปัญหาใหม่ค่ะ ระบบลางานกดไม่ได้", active: "73046", expect: "NEW", note: "เปิดเคสใหม่ชัดเจน" },
  { id: "F3", text: "ใบเสร็จปริ้นไม่ออกค่ะ", active: "73046", expect: "NEW", note: "ปัญหาใหม่แต่คำใกล้เคียงเคสเดิม (ใบเสร็จ) — กับดัก" },
];

function decisionOf(r: { type: string; ticketId: number | null }, map: Record<string, number>): string {
  if (r.type === "SWITCH_EXISTING_CASE" || r.type === "CONTINUE_ACTIVE_CASE") {
    if (r.ticketId === map["73046"]) return r.type === "CONTINUE_ACTIVE_CASE" ? "CONTINUE(73046)" : "SWITCH_73046";
    if (r.ticketId === map["86186"]) return r.type === "CONTINUE_ACTIVE_CASE" ? "CONTINUE(86186)" : "SWITCH_86186";
    return `${r.type}(${r.ticketId})`;
  }
  if (r.type === "AMBIGUOUS_CASE") return "AMBIGUOUS";
  if (r.type === "NEW_CASE") return "NEW";
  return r.type;
}

function matches(got: string, want: Expect): boolean {
  if (want === "ANY") return true;
  if (want === "CONTINUE") return got.startsWith("CONTINUE");
  return got === want;
}

(async () => {
  // ฉากจริง: เคสที่เปิดอยู่ของ conversation 99961 ตอนที่เดโมรัน
  const { rows } = await pool.query<CaseCandidate & { status: string }>(
    `SELECT id, ticket_number, ticket_id, subject, title, summary, running_summary,
            original_problem_statement, searchable_text, issue_category, status, created_at
       FROM tickets
      WHERE ticket_number IN ('TCK-2026-73046','TCK-2026-86186')`
  );
  if (rows.length < 2) {
    console.log("ไม่พบเคสตั้งต้นครบ 2 ใบ — ข้ามการทดสอบ");
    await pool.end();
    return;
  }

  const map: Record<string, number> = {};
  for (const r of rows) {
    if (r.ticket_number?.includes("73046")) map["73046"] = r.id;
    if (r.ticket_number?.includes("86186")) map["86186"] = r.id;
  }
  // ทั้งสองใบถือว่าเปิดอยู่ (ตอนเดโมยังไม่ถูกยกเลิก)
  const openCases: CaseCandidate[] = rows.map((r) => ({ ...r, status: "IN_PROGRESS" }));

  // เคสปิดของ conversation เดียวกัน — ตัวที่เคยทำให้ resolve ผิดมาก่อน
  const closedRes = await pool.query<CaseCandidate>(
    `SELECT id, ticket_number, ticket_id, subject, title, summary, running_summary,
            original_problem_statement, searchable_text, issue_category, status, created_at
       FROM tickets
      WHERE conversation_id = 99961 AND UPPER(COALESCE(status,'')) IN ('CLOSED','CANCELLED')
      ORDER BY id DESC LIMIT 8`
  );

  console.log("\nฉากทดสอบ");
  console.log(`  เคสเปิด  : ${openCases.map((c) => `${c.ticket_number} (${String(c.subject).slice(0, 42)})`).join("\n             ")}`);
  console.log(`  เคสปิด   : ${closedRes.rows.length} ใบ`);
  console.log(`\n${"ID".padEnd(4)} ${"คาดหวัง".padEnd(14)} ${"ได้จริง".padEnd(16)} ผล   ประโยค`);
  console.log("-".repeat(108));

  let pass = 0;
  const fails: string[] = [];
  const informational: string[] = [];

  for (const p of PROBES) {
    const activeId = p.active ? map[p.active] : null;
    const res = caseResolver.resolve({
      conversationId: 99961,
      activeTicketId: activeId,
      messageText: p.text,
      openCases,
      closedCases: closedRes.rows,
      recentMessages: [],
    });
    const got = decisionOf(res, map);
    const ok = matches(got, p.expect);
    if (p.expect === "ANY") {
      informational.push(`  ${p.id}  ${got.padEnd(18)} "${p.text}"  (${p.note})`);
    } else if (ok) {
      pass += 1;
    } else {
      fails.push(`  ${p.id}  คาดหวัง ${p.expect} แต่ได้ ${got}  — "${p.text}"  [${p.note}]`);
    }
    const mark = p.expect === "ANY" ? "info" : ok ? "ผ่าน" : "พลาด";
    console.log(
      `${p.id.padEnd(4)} ${p.expect.padEnd(14)} ${got.padEnd(16)} ${mark.padEnd(5)} ${p.text}`
    );
  }

  const judged = PROBES.filter((p) => p.expect !== "ANY").length;
  console.log("\n" + "=".repeat(108));
  console.log(`ผ่าน ${pass}/${judged}  (อีก ${PROBES.length - judged} ข้อเป็นการสำรวจ ไม่ตัดสินถูกผิด)`);
  if (fails.length) {
    console.log("\nจุดที่พลาด:");
    fails.forEach((f) => console.log(f));
  }
  if (informational.length) {
    console.log("\nการสำรวจ (อ้างถึงด้วยเวลา/ลำดับ — ดูว่า resolver ตอบอะไร):");
    informational.forEach((i) => console.log(i));
  }
  await pool.end();
})().catch((e) => {
  console.log("ERR", e.message);
  process.exit(1);
});
