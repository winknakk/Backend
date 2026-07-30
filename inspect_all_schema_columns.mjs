import pg from "pg";
import fs from "fs";

const client = new pg.Client({
  host: "postgres.promptxai.com",
  port: 5432,
  database: "csdb",
  user: "cs_user",
  password: "F52Gs8w46001",
  ssl: false,
});

async function inspectAllSchema() {
  await client.connect();
  console.log("🔌 Connected to postgres.promptxai.com/csdb");

  const res = await client.query(`
    SELECT 
      table_name, 
      column_name, 
      data_type, 
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'cs_tickets'
    ORDER BY table_name, ordinal_position;
  `);

  const tablesMap = {};
  res.rows.forEach(r => {
    if (!tablesMap[r.table_name]) {
      tablesMap[r.table_name] = [];
    }
    tablesMap[r.table_name].push({
      column: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable,
      default: r.column_default
    });
  });

  let report = "# 📑 รายงานโครงสร้างคอลัมน์ทั้งหมดใน Schema cs_tickets (" + Object.keys(tablesMap).length + " ตาราง)\n\n";

  for (const [table, cols] of Object.entries(tablesMap)) {
    report += `### 📌 ตาราง \`cs_tickets.${table}\` (${cols.length} คอลัมน์)\n`;
    report += "| คอลัมน์ (Column) | ประเภทข้อมูล (Type) | Nullable | Default |\n";
    report += "| :--- | :--- | :---: | :--- |\n";
    cols.forEach(c => {
      report += `| \`${c.column}\` | \`${c.type}\` | ${c.nullable} | ${c.default ? '`' + c.default + '`' : '-'} |\n`;
    });
    report += "\n---\n\n";
  }

  fs.writeFileSync("C:/Users/akkha/TicketX/system/backend/database/production/ALL_TABLE_COLUMNS_REPORT.md", report, "utf8");
  console.log("✅ Written full report to system/backend/database/production/ALL_TABLE_COLUMNS_REPORT.md");

  await client.end();
}

inspectAllSchema();
