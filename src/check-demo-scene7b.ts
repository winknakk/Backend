/** READ-ONLY: ยืนยัน 2 ข้อสงสัย — (ก) 12:17 บอทบอกว่ายกเลิกแล้วจริงไหม (ข) การ์ดสถานะที่ยิงเองทุก 20 นาที */
import { pool } from "./adapters/postgres/PostgresAdapter";

(async () => {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public'
        AND (table_name ILIKE '%history%' OR table_name ILIKE '%audit%'
             OR table_name ILIKE '%outbox%' OR table_name ILIKE '%event%'
             OR table_name ILIKE '%trace%' OR table_name ILIKE '%notification%')
      ORDER BY table_name`
  );
  console.log("=== ตารางที่เก็บประวัติ/เหตุการณ์ ===");
  console.log("  " + tables.rows.map((r) => r.table_name).join(", "));

  console.log("\n=== A) ticket 732 (TCK-2026-73046) — บอทอ้างว่ายกเลิกตอน 12:17:16 ===");
  const t = await pool.query(
    `SELECT id, status,
            to_char(created_at AT TIME ZONE 'Asia/Bangkok','MM-DD HH24:MI:SS') AS created,
            to_char(updated_at AT TIME ZONE 'Asia/Bangkok','MM-DD HH24:MI:SS') AS updated
       FROM tickets WHERE id = 732`
  );
  console.log(" ", t.rows[0]);

  for (const tbl of tables.rows.map((r) => r.table_name)) {
    const has = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name=$1`,
      [tbl]
    );
    const names = has.rows.map((c) => c.column_name);
    const tcol = names.find((c) => ["ticket_id", "entity_id", "aggregate_id"].includes(c));
    if (!tcol) continue;
    try {
      const r = await pool.query(
        `SELECT * FROM ${tbl} WHERE ${tcol}::text IN ('732','745','746')
          ORDER BY 1 DESC LIMIT 12`
      );
      if (r.rows.length) {
        console.log(`\n  -- ${tbl} (${r.rows.length} แถว) --`);
        for (const row of r.rows) {
          const o: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) {
            if (v === null) continue;
            const s = typeof v === "object" ? JSON.stringify(v) : String(v);
            o[k] = s.length > 70 ? s.slice(0, 70) + "…" : s;
          }
          console.log("    ", JSON.stringify(o));
        }
      }
    } catch (e) {
      console.log(`  (${tbl}: ${(e as Error).message})`);
    }
  }

  console.log("\n=== B) การ์ดสถานะที่ยิงเอง — ดู metadata ของข้อความ AI ที่ไม่มีคนถาม ===");
  const mcols = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name='messages'`
  );
  console.log("  คอลัมน์ messages: " + mcols.rows.map((r) => r.column_name).join(", "));
  const m = await pool.query(
    `SELECT * FROM messages
      WHERE conversation_id = 99961
        AND created_at >= CURRENT_DATE - interval '7 hours'
        AND to_char(created_at AT TIME ZONE 'Asia/Bangkok','MI:SS') LIKE ANY (ARRAY['17:5%','37:5%','25:4%'])
      ORDER BY created_at LIMIT 8`
  );
  for (const row of m.rows) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || k === "content") continue;
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      o[k] = s.length > 90 ? s.slice(0, 90) + "…" : s;
    }
    console.log("   ", JSON.stringify(o));
  }

  await pool.end();
})().catch((e) => {
  console.log("ERR", e.message);
  process.exit(1);
});
