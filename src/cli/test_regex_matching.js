const { Client } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: 'system/backend/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const testCases = [
    { name: "1.1 Modules & Config", q: "ระบบ EXC03 มีโมดูลอะไรบ้าง และไฟล์คอนฟิกหลักอยู่ที่ไหน" },
    { name: "1.2 Report Tech", q: "รายงานในระบบ EXC03 ใช้เทคโนโลยีอะไร และแม่แบบไฟล์รายงานเก็บไว้ที่โฟลเดอร์ไหน" },
    { name: "1.3 Scheduler", q: "ระบบ Scheduler ทำงานอย่างไร มีคลาสไหนทำหน้าที่ตั้งเวลาประมวลผล" },
    { name: "2.1 Jasper Error", q: "ออกรายงาน JasperReport ไม่ได้ ระบบแจ้ง error: net.sf.jasperreports.engine.JRException: Resource not found ช่วยเช็กให้หน่อย" },
    { name: "2.2 ServiceImportFile Freeze", q: "นำเข้าไฟล์ข้อมูลในโมดูล ServiceImportFile แล้วระบบค้าง เกิดจากอะไร" },
    { name: "2.3 Unknown Error (Should be 0)", q: "ระบบขึ้น MFR4048 ACT_EXECUTE_ERROR process getListNotiPm2 ใช้งาน User สลน ค่ะ" }
  ];

  for (const tc of testCases) {
    const tokens = tc.q.replace(/[^\u0E00-\u0E7Fa-zA-Z0-9_.]/g, ' ')
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length >= 3 && !['และ', 'หรือ', 'ช่วย', 'หน่อย', 'อะไร', 'อย่างไร', 'มีอะไรบ้าง', 'อยู่ที่ไหน', 'ใช้งาน', 'เกิดจากอะไร'].includes(w));
    const regexPattern = tokens.length > 0 ? tokens.join('|') : tc.q;

    const sql = `
      SELECT doc_id, metadata->>'title' as title 
      FROM document_embeddings 
      WHERE (metadata->>'projectId' = $1 OR metadata->>'project_id' = $1)
        AND (
          content ~* $2 
          OR metadata->>'title' ~* $2 
          OR (metadata->>'keywords')::text ~* $2 
          OR content ILIKE '%' || $3 || '%'
        )
      ORDER BY updated_at DESC 
      LIMIT 5;
    `;
    const res = await client.query(sql, ['101', regexPattern, tc.q]);
    console.log(`\n[${tc.name}] Regex: "${regexPattern.substring(0, 50)}"`);
    console.log(`Found ${res.rows.length} docs:`, res.rows.map(r => r.title));
  }

  await client.end();
}

run().catch(console.error);
