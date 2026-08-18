const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'system/backend/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const queries = [
    "ระบบ EXC03 มีโมดูลอะไรบ้าง และไฟล์คอนฟิกหลักอยู่ที่ไหน",
    "รายงานในระบบ EXC03 ใช้เทคโนโลยีอะไร และแม่แบบไฟล์รายงานเก็บไว้ที่โฟลเดอร์ไหน",
    "ระบบ Scheduler ทำงานอย่างไร มีคลาสไหนทำหน้าที่ตั้งเวลาประมวลผล",
    "ออกรายงาน JasperReport ไม่ได้ ระบบแจ้ง error: net.sf.jasperreports.engine.JRException: Resource not found ช่วยเช็กให้หน่อย",
    "นำเข้าไฟล์ข้อมูลในโมดูล ServiceImportFile แล้วระบบค้าง เกิดจากอะไร",
    "ระบบขึ้น MFR4048 ACT_EXECUTE_ERROR process getListNotiPm2 ใช้งาน User สลน ค่ะ"
  ];

  console.log('--- Testing keyword query ---');
  for (const q of queries) {
    // Extract keywords (words with 3+ characters)
    const rawWords = q.replace(/[^\u0E00-\u0E7Fa-zA-Z0-9_.]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
    console.log(`\nQuery: "${q.substring(0, 40)}..."`);
    console.log('Keywords extracted:', rawWords);

    // Test a smart query:
    // Check if any keyword matches content or title, or exact substring
    const sql = `
      SELECT doc_id, metadata->>'title' as title,
        (
          CASE WHEN content ILIKE '%' || $2 || '%' THEN 10 ELSE 0 END +
          CASE WHEN metadata->>'title' ILIKE '%' || $2 || '%' THEN 10 ELSE 0 END
        ) as exact_score
      FROM document_embeddings 
      WHERE (metadata->>'projectId' = $1 OR metadata->>'project_id' = $1)
      ORDER BY updated_at DESC
      LIMIT 5;
    `;
    const res = await client.query(sql, ['101', q]);
    console.log('Exact score matches:', res.rows.map(r => r.title));
  }

  await client.end();
}

run().catch(console.error);
