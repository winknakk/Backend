import pg from "pg";
import fs from "fs";
import path from "path";

async function runSetup() {
  console.log("🔌 Connecting to Remote PostgreSQL (postgres.promptxai.com)...");
  
  const client = new pg.Client({
    host: "postgres.promptxai.com",
    port: 5432,
    database: "csdb",
    user: "cs_user",
    password: "F52Gs8w46001",
    ssl: false,
    connectionTimeoutMillis: 30000,
    keepAlive: true,
  });

  try {
    await client.connect();
    console.log("✅ Connected successfully to csdb on postgres.promptxai.com!");

    // Check pgvector support
    let hasVector = false;
    try {
      await client.query("SELECT 'vector'::regtype;");
      hasVector = true;
      console.log("⚡ pgvector extension is available!");
    } catch {
      console.log("ℹ️ pgvector extension is not installed on remote server. Falling back embedding columns to TEXT.");
    }

    // 1. Reset Schema cs_tickets
    console.log("🧹 Resetting schema cs_tickets...");
    await client.query("DROP SCHEMA IF EXISTS cs_tickets CASCADE;");
    await client.query("CREATE SCHEMA cs_tickets;");
    await client.query("SET search_path TO cs_tickets, public;");
    console.log("✨ Schema cs_tickets created clean!");

    const baseDir = path.join(process.cwd(), "database", "production");

    // 2. DDL
    console.log("🏗️ Creating 45 tables & helper functions from DDL...");
    let ddlSql = fs.readFileSync(path.join(baseDir, "ddl.sql"), "utf8");
    if (!hasVector) {
      ddlSql = ddlSql.replace(/vector\(1536\)/g, "TEXT");
    }
    await client.query(ddlSql);
    console.log("✅ 45 Tables created!");

    // 3. Indexes
    console.log("⚡ Creating indexes...");
    let idxSql = fs.readFileSync(path.join(baseDir, "indexes.sql"), "utf8");
    if (!hasVector) {
      idxSql = idxSql.split("\n").filter(line => !line.includes("hnsw")).join("\n");
    }
    await client.query(idxSql);
    console.log("✅ Indexes created!");

    // 4. Constraints (Foreign Keys)
    console.log("🔗 Creating foreign keys & constraints...");
    const constSql = fs.readFileSync(path.join(baseDir, "constraints.sql"), "utf8");
    await client.query(constSql);
    console.log("✅ Foreign keys & constraints created!");

    // 5. Seed Data
    console.log("🌱 Inserting initial seed data...");
    const seedSql = fs.readFileSync(path.join(baseDir, "seed.sql"), "utf8");
    await client.query(seedSql);
    console.log("✅ Seed data inserted!");

    // 6. Verify Tables
    const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'cs_tickets'
      ORDER BY table_name;
    `);

    console.log(`\n==================================================`);
    console.log(`🎉 SUCCESS! Verified ${res.rows.length} Tables in cs_tickets schema:`);
    console.log(`==================================================`);
    res.rows.forEach((r, i) => console.log(`  ${i + 1}. ${r.table_name}`));

  } catch (err) {
    console.error("❌ Setup error:", err);
  } finally {
    await client.end();
    console.log("\n🔌 Database connection closed.");
  }
}

runSetup();
