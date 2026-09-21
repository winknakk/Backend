/**
 * READ-ONLY: ตรวจสิ่งที่เกิดขึ้นจริงในฐานข้อมูล ระหว่างเดโม Scene 7 + reopen
 * (18/09/2026 13:20 - 14:05) บน conversation 99961
 */
import { pool } from "./adapters/postgres/PostgresAdapter";

const CONV = 99961;

(async () => {
  console.log("=== 1) ตั๋วทั้งหมดของ conversation ที่ถูกแตะวันนี้ ===");
  const t = await pool.query(
    `SELECT id, ticket_number, status, priority,
            LEFT(COALESCE(subject,title,''), 55) AS subj,
            to_char(created_at AT TIME ZONE 'Asia/Bangkok','HH24:MI:SS') AS created,
            to_char(updated_at AT TIME ZONE 'Asia/Bangkok','HH24:MI:SS') AS updated
       FROM tickets
      WHERE conversation_id = $1
        AND (created_at >= CURRENT_DATE OR updated_at >= CURRENT_DATE)
      ORDER BY updated_at`,
    [CONV]
  );
  for (const r of t.rows) {
    console.log(
      `  #${String(r.id).padEnd(6)} ${String(r.ticket_number).padEnd(16)} ${String(r.status).padEnd(12)} ` +
        `${String(r.priority ?? "-").padEnd(9)} created ${r.created}  updated ${r.updated}  ${r.subj}`
    );
  }

  console.log("\n=== 2) มีตั๋วใหม่เกิดขึ้นช่วง 13:50-14:05 ไหม (กับดัก: ข้อความพิมพ์เองอาจสร้างตั๋วซ้ำ) ===");
  const dup = await pool.query(
    `SELECT id, ticket_number, status, LEFT(COALESCE(subject,title,''),60) AS subj,
            to_char(created_at AT TIME ZONE 'Asia/Bangkok','HH24:MI:SS') AS created
       FROM tickets
      WHERE conversation_id = $1
        AND created_at >= CURRENT_DATE + interval '13 hours 45 minutes' - interval '7 hours'
      ORDER BY created_at`,
    [CONV]
  );
  console.log(dup.rows.length ? dup.rows : "  (ไม่มีตั๋วใหม่ — ดี)");

  console.log("\n=== 3) ประวัติสถานะของ TCK-2026-03655 และ TCK-2026-86186 ===");
  for (const num of ["TCK-2026-03655", "TCK-2026-86186"]) {
    const row = await pool.query(
      `SELECT id, status, resolved_at, closed_at,
              to_char(updated_at AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS') AS updated
         FROM tickets WHERE ticket_number = $1`,
      [num]
    );
    console.log(`  ${num}:`, row.rows[0] ?? "ไม่พบ");
  }

  console.log("\n=== 4) ข้อความจริง 13:20-14:05 (ดูว่า bot ถามซ้ำเพราะอะไร) ===");
  const colRes = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name='messages'`
  );
  const cols = new Set(colRes.rows.map((c) => c.column_name));
  const senderCol = ["sender_type", "sender", "role", "direction", "message_type"].find((c) => cols.has(c));
  const bodyCol = ["content", "text", "body", "message"].find((c) => cols.has(c));
  const focusCol = ["active_ticket_id", "ticket_id"].find((c) => cols.has(c));
  console.log(`  (คอลัมน์ที่ใช้: sender=${senderCol} body=${bodyCol} focus=${focusCol})`);

  const m = await pool.query(
    `SELECT id, ${senderCol} AS sender, ${focusCol ? `${focusCol} AS focus` : "NULL AS focus"},
            to_char(created_at AT TIME ZONE 'Asia/Bangkok','HH24:MI:SS') AS t,
            LEFT(REPLACE(COALESCE(${bodyCol},''), E'\n', ' | '), 95) AS body
       FROM messages
      WHERE conversation_id = $1 AND created_at >= CURRENT_DATE - interval '7 hours'
      ORDER BY created_at, id`,
    [CONV]
  );
  for (const r of m.rows) {
    console.log(`  ${r.t}  ${String(r.sender).padEnd(9)} focus=${String(r.focus ?? "-").padEnd(6)} ${r.body}`);
  }

  console.log("\n=== 5) โฟกัสปัจจุบันของ conversation ===");
  const c = await pool.query(
    `SELECT active_ticket_id, project_id,
            to_char(updated_at AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS') AS updated
       FROM conversations WHERE id = $1`,
    [CONV]
  );
  console.log(" ", c.rows[0]);

  await pool.end();
})().catch((e) => {
  console.log("ERR", e.message);
  process.exit(1);
});
