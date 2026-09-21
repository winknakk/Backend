/** READ-ONLY: เอา "ไบต์จริง" ของข้อความ 12:14 กับ 13:16 จาก DB มายิงเข้า detector ตัวจริง */
import { pool } from "./adapters/postgres/PostgresAdapter";
import { detectCancelIntent } from "./domain/ticket/CustomerConfirmation";

(async () => {
  const r = await pool.query<{ id: string; t: string; content: string }>(
    `SELECT id, to_char(created_at AT TIME ZONE 'Asia/Bangkok','HH24:MI:SS') AS t, content
       FROM messages
      WHERE conversation_id = 99961 AND role = 'customer'
        AND content LIKE '%ยกเลิกเคส%'
        AND created_at >= CURRENT_DATE - interval '7 hours'
      ORDER BY created_at`
  );
  for (const row of r.rows) {
    const c = row.content;
    const i = detectCancelIntent(c, false);
    const iPending = detectCancelIntent(c, true);
    console.log(`\n--- msg ${row.id} @ ${row.t} ---`);
    console.log(`  len=${c.length}  codepoints[0..6]=${[...c].slice(0, 6).map((ch) => ch.codePointAt(0)!.toString(16)).join(" ")}`);
    console.log(`  JSON: ${JSON.stringify(c)}`);
    console.log(`  detect(pending=false) = ${i.kind}  num=${i.ticketNumber}`);
    console.log(`  detect(pending=true)  = ${iPending.kind}`);
  }

  // และ AI message ที่ตอบกลับในวินาทีเดียวกัน — เพื่อดูว่าเป็น template ตัวไหน
  const ai = await pool.query<{ id: string; t: string; purpose: string; content: string }>(
    `SELECT id, to_char(created_at AT TIME ZONE 'Asia/Bangkok','HH24:MI:SS') AS t,
            COALESCE(message_purpose,'(null)') AS purpose, LEFT(content, 130) AS content
       FROM messages
      WHERE conversation_id = 99961 AND role = 'ai'
        AND created_at >= CURRENT_DATE - interval '7 hours'
        AND to_char(created_at AT TIME ZONE 'Asia/Bangkok','HH24:MI') IN ('12:14','12:17','13:16','13:17')
      ORDER BY created_at`
  );
  console.log("\n=== AI replies รอบ ๆ สองเหตุการณ์ ===");
  for (const a of ai.rows) {
    console.log(`  ${a.t}  purpose=${a.purpose.padEnd(14)} ${a.content.replace(/\n/g, " | ")}`);
  }

  await pool.end();
})().catch((e) => {
  console.log("ERR", e.message);
  process.exit(1);
});
