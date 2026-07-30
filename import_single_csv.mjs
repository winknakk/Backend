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

async function runSingleImport() {
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

    const filePath = "C:/Users/akkha/Downloads/identities_202607271138.csv";
    const content = fs.readFileSync(filePath, "utf8").trim();
    const rows = parseCSV(content);

    const headers = rows[0].map(h => h.trim().replace(/^"|"$/g, ""));
    const dataRows = rows.slice(1);

    console.log(`📄 Found ${dataRows.length} rows in identities_202607271138.csv`);

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
        INSERT INTO cs_tickets."identities" (${columns.join(", ")})
        VALUES (${params.join(", ")})
        ON CONFLICT (id) DO UPDATE SET
          profile_id = EXCLUDED.profile_id,
          channel_type = EXCLUDED.channel_type,
          channel_id = EXCLUDED.channel_id,
          external_id = EXCLUDED.external_id,
          created_at = EXCLUDED.created_at;
      `;

      try {
        await client.query(insertQuery, values);
        insertedCount++;
      } catch (insertErr) {
        // Fallback without conflict target
        try {
          const fallbackQuery = `
            INSERT INTO cs_tickets."identities" (${columns.join(", ")})
            VALUES (${params.join(", ")})
            ON CONFLICT DO NOTHING;
          `;
          await client.query(fallbackQuery, values);
          insertedCount++;
        } catch (e) {
          console.error("⚠️ Insert failed for row:", e.message);
        }
      }
    }

    // Reset sequence
    try {
      await client.query(`
        SELECT setval('cs_tickets.identities_id_seq', COALESCE((SELECT MAX(id) FROM cs_tickets.identities), 1), true);
      `);
    } catch {}

    const totalCountRes = await client.query("SELECT COUNT(*) FROM cs_tickets.identities;");

    console.log(`\n🎉 SUCCESS! Inserted/Updated ${insertedCount} rows into cs_tickets.identities.`);
    console.log(`📊 Current total rows in cs_tickets.identities: ${totalCountRes.rows[0].count}`);

  } catch (err) {
    console.error("❌ Import failed:", err);
  } finally {
    await client.end();
    console.log("\n🔌 Connection closed.");
  }
}

runSingleImport();
