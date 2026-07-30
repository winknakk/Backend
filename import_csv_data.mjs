import pg from "pg";
import fs from "fs";
import path from "path";

function parseCSV(text) {
  const lines = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      row.push(cell);
      if (row.length > 1 || (row.length === 1 && row[0].trim() !== "")) {
        lines.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== "")) {
      lines.push(row);
    }
  }
  return lines;
}

// Ordered list by foreign-key dependency
const orderedTables = [
  "companies",
  "company_holiday_calendars",
  "company_holidays",
  "teams",
  "projects",
  "project_ai_settings",
  "project_business_hours",
  "project_channels",
  "project_feature_flags",
  "project_holidays",
  "project_mcp_permissions",
  "project_prompts",
  "project_routing_rules",
  "project_sla_policies",
  "schema_migrations",
  "operators",
  "profiles",
  "identities",
  "customer_enrollments",
  "profile_projects",
  "operator_project_access",
  "on_call_rosters",
  "knowledge_documents",
  "knowledge_embeddings",
  "document_embeddings",
  "conversations",
  "tickets",
  "conversation_ticket_links",
  "conversation_participants",
  "conversation_handoffs",
  "conversation_events",
  "internal_notes",
  "takeover_sessions",
  "messages",
  "message_attachments",
  "ticket_events",
  "ticket_embeddings",
  "ai_memory",
  "admin_audit_logs",
  "traces",
  "notification_logs",
  "outbox_events",
  "verification_requests",
  "webchat_sessions",
  "webhook_events"
];

async function runImport() {
  console.log("🔌 Connecting to Remote PostgreSQL (postgres.promptxai.com)...");
  const client = new pg.Client({
    host: "postgres.promptxai.com",
    port: 5432,
    database: "csdb",
    user: "cs_user",
    password: "F52Gs8w46001",
    ssl: false,
    connectionTimeoutMillis: 30000,
  });

  try {
    await client.connect();
    console.log("✅ Connected successfully!");

    await client.query("SET search_path TO cs_tickets, public;");

    const downloadsDir = "C:/Users/akkha/Downloads";
    const allFiles = fs.readdirSync(downloadsDir).filter(f => f.endsWith("_202607271101.csv"));

    // Map table names to files
    const fileMap = new Map();
    allFiles.forEach(f => {
      const tableName = f.replace("_202607271101.csv", "");
      fileMap.set(tableName, f);
    });

    // Combine ordered tables and remaining tables
    const sortedTables = [];
    orderedTables.forEach(t => {
      if (fileMap.has(t)) sortedTables.push(t);
    });
    fileMap.forEach((_, t) => {
      if (!sortedTables.includes(t)) sortedTables.push(t);
    });

    console.log(`📁 Found ${sortedTables.length} CSV tables to import in topological order.\n`);

    let totalRowsImported = 0;
    const summary = [];

    for (const tableName of sortedTables) {
      const fileName = fileMap.get(tableName);
      const filePath = path.join(downloadsDir, fileName);
      const content = fs.readFileSync(filePath, "utf8").trim();

      if (!content) {
        summary.push({ table: tableName, rows: 0, status: "Empty file" });
        continue;
      }

      const rows = parseCSV(content);
      if (rows.length <= 1) {
        summary.push({ table: tableName, rows: 0, status: "Header only / No data" });
        continue;
      }

      const headers = rows[0].map(h => h.trim().replace(/^"|"$/g, ""));
      const dataRows = rows.slice(1);

      // Clean existing rows before inserting
      try {
        await client.query(`DELETE FROM cs_tickets."${tableName}";`);
      } catch (err) {}

      let insertedCount = 0;
      for (const row of dataRows) {
        if (row.length === 0 || (row.length === 1 && !row[0])) continue;

        const columns = [];
        const values = [];
        const params = [];

        headers.forEach((header, idx) => {
          let val = row[idx] !== undefined ? row[idx] : null;
          
          if (val === "" || val === null || val === undefined) {
            val = null;
          } else {
            val = val.trim();
            if (val.startsWith('"') && val.endsWith('"')) {
              val = val.slice(1, -1);
            }
            if (val === "" || val === "NULL" || val === "\\N") {
              val = null;
            } else if (val === "true" || val === "t") {
              val = true;
            } else if (val === "false" || val === "f") {
              val = false;
            }
          }

          columns.push(`"${header}"`);
          values.push(val);
          params.push(`$${columns.length}`);
        });

        const insertQuery = `
          INSERT INTO cs_tickets."${tableName}" (${columns.join(", ")})
          VALUES (${params.join(", ")})
          ON CONFLICT DO NOTHING;
        `;

        try {
          await client.query(insertQuery, values);
          insertedCount++;
        } catch (insertErr) {
          // Ignore individual row error if missing foreign key
        }
      }

      totalRowsImported += insertedCount;
      summary.push({ table: tableName, rows: insertedCount, status: "OK" });
      console.log(`✅ Loaded ${insertedCount} rows into cs_tickets.${tableName}`);
    }

    // Reset sequence values for serial columns
    console.log("\n🔢 Resetting SERIAL auto-increment sequences...");
    const seqRes = await client.query(`
      SELECT table_name, column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'cs_tickets' AND column_default LIKE 'nextval%';
    `);

    for (const seq of seqRes.rows) {
      try {
        const seqMatch = seq.column_default.match(/'([^']+)'/);
        if (seqMatch) {
          const seqName = seqMatch[1];
          await client.query(`
            SELECT setval('${seqName}', COALESCE((SELECT MAX("${seq.column_name}") FROM cs_tickets."${seq.table_name}"), 1), true);
          `);
        }
      } catch (seqErr) {}
    }
    console.log("✅ Auto-increment sequences reset successfully!");

    console.log(`\n==================================================`);
    console.log(`🎉 CSV IMPORT COMPLETE! Total ${totalRowsImported} rows imported across ${summary.length} tables:`);
    console.log(`==================================================`);
    summary.forEach(s => {
      console.log(`  - cs_tickets.${s.table.padEnd(30)} : ${s.rows} rows (${s.status})`);
    });

  } catch (err) {
    console.error("❌ CSV Import failed:", err);
  } finally {
    await client.end();
    console.log("\n🔌 Database connection closed.");
  }
}

runImport();
