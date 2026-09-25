import assert from "node:assert/strict";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { INTELLIGENCE_CONFIG, resolveProjectTimezone } from "./config/intelligence";

async function runPhase3AFoundationVerification() {
  console.log("===============================================================================");
  console.log(" AUTOMATIONX V3 — PHASE 3A DATA FOUNDATION & MIGRATION VERIFICATION");
  console.log("===============================================================================\n");

  const client = await pool.connect();

  try {
    // -------------------------------------------------------------------------
    // [Test 1] Schema Migration Bookkeeping & Table Existence
    // -------------------------------------------------------------------------
    console.log("[Test 1] Migration Registration & Table Existence in PostgreSQL");
    const migRes = await client.query(
      "SELECT version, executed_at FROM schema_migrations WHERE version = '051_phase3_conversation_intelligence.sql';"
    );
    assert.equal(migRes.rows.length, 1, "Migration 051 must be recorded in schema_migrations");
    console.log(`  ✓ PASS: Migration 051 recorded at ${migRes.rows[0].executed_at}`);

    const targetTables = [
      "daily_project_intelligence",
      "knowledge_gap_candidates",
      "bot_failure_events",
      "bot_improvement_proposals",
    ];

    const tablesRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[]);",
      [targetTables]
    );
    const existingTableNames = new Set(tablesRes.rows.map((r: any) => r.table_name));
    for (const tbl of targetTables) {
      assert(existingTableNames.has(tbl), `Table '${tbl}' must exist in current schema`);
    }
    console.log("  ✓ PASS: All 4 Phase 3 derived intelligence tables exist");

    // -------------------------------------------------------------------------
    // [Test 2] Foreign Key Integrity to projects(id) ON DELETE CASCADE
    // -------------------------------------------------------------------------
    console.log("\n[Test 2] Foreign Key Constraints & Cascade Semantics");
    const fkRes = await client.query(`
      SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name, rc.delete_rule
      FROM information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' 
        AND tc.table_schema = current_schema()
        AND tc.table_name = ANY($1::text[])
        AND kcu.column_name = 'project_id';
    `, [targetTables]);

    for (const tbl of targetTables) {
      const fk = fkRes.rows.find((r: any) => r.table_name === tbl);
      assert(fk, `Table '${tbl}' must have foreign key on project_id`);
      assert.equal(fk.foreign_table_name, "projects", `FK must target 'projects' table for '${tbl}'`);
      assert.equal(fk.foreign_column_name, "id", `FK must target 'projects.id' for '${tbl}'`);
      assert.equal(fk.delete_rule, "CASCADE", `FK delete rule must be CASCADE for '${tbl}'`);
    }
    console.log("  ✓ PASS: All 4 tables enforce foreign key ON DELETE CASCADE to projects(id)");

    // -------------------------------------------------------------------------
    // [Test 3] Index Verification for Project-Scoped Queries
    // -------------------------------------------------------------------------
    console.log("\n[Test 3] Project-Scoped Composite & Filtered Indexes");
    const idxRes = await client.query(`
      SELECT indexname, tablename, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = ANY($1::text[]);
    `, [targetTables]);

    const indexNames = new Set(idxRes.rows.map((r: any) => r.indexname));
    const requiredIndexes = [
      "idx_daily_intel_proj_date",
      "idx_kg_candidates_proj_status",
      "idx_kg_candidates_proj_created",
      "idx_kg_candidates_cluster",
      "idx_bot_failures_proj_class",
      "idx_bot_failures_proj_created",
      "idx_bot_proposals_proj_status",
      "idx_bot_proposals_proj_created",
    ];

    for (const idx of requiredIndexes) {
      assert(indexNames.has(idx), `Index '${idx}' must exist in schema`);
    }
    console.log(`  ✓ PASS: All ${requiredIndexes.length} project-scoped indexes verified`);

    // -------------------------------------------------------------------------
    // [Test 4] Unique Constraints & Deterministic Idempotency
    // -------------------------------------------------------------------------
    console.log("\n[Test 4] Deterministic Database Constraints & Uniqueness");
    // Get test project
    const projRes = await client.query("SELECT id FROM projects LIMIT 1;");
    assert(projRes.rows.length > 0, "At least one project must exist for constraint testing");
    const testProjectId = projRes.rows[0].id;
    const testDate = "2099-01-01";

    // 4a. daily_project_intelligence unique(project_id, date)
    await client.query("DELETE FROM daily_project_intelligence WHERE project_id = $1 AND date = $2;", [testProjectId, testDate]);
    await client.query(
      `INSERT INTO daily_project_intelligence (project_id, date, timezone, total_conversations)
       VALUES ($1, $2, 'Asia/Bangkok', 10);`,
      [testProjectId, testDate]
    );

    // Duplicate insert without ON CONFLICT must throw unique violation
    let duplicateRejected = false;
    try {
      await client.query(
        `INSERT INTO daily_project_intelligence (project_id, date, timezone, total_conversations)
         VALUES ($1, $2, 'Asia/Bangkok', 20);`,
        [testProjectId, testDate]
      );
    } catch (err: any) {
      if (err.code === "23505") { // unique_violation
        duplicateRejected = true;
      }
    }
    assert.equal(duplicateRejected, true, "daily_project_intelligence must reject duplicate (project_id, date)");

    // Safe UPSERT must work cleanly
    await client.query(
      `INSERT INTO daily_project_intelligence (project_id, date, timezone, total_conversations)
       VALUES ($1, $2, 'Asia/Bangkok', 25)
       ON CONFLICT (project_id, date) DO UPDATE SET total_conversations = EXCLUDED.total_conversations;`,
      [testProjectId, testDate]
    );
    const upsertCheck = await client.query(
      "SELECT total_conversations FROM daily_project_intelligence WHERE project_id = $1 AND date = $2;",
      [testProjectId, testDate]
    );
    assert.equal(upsertCheck.rows[0].total_conversations, 25, "UPSERT must update total_conversations cleanly");
    await client.query("DELETE FROM daily_project_intelligence WHERE project_id = $1 AND date = $2;", [testProjectId, testDate]);
    console.log("  ✓ PASS: daily_project_intelligence enforces UNIQUE(project_id, date) and supports safe UPSERT");

    // 4b. knowledge_gap_candidates turn uniqueness
    const testQuery = "How do I reset my credentials?";
    await client.query("DELETE FROM knowledge_gap_candidates WHERE project_id = $1 AND query_text = $2;", [testProjectId, testQuery]);
    const kg1 = await client.query(
      `INSERT INTO knowledge_gap_candidates (project_id, query_text, normalized_query, score, status, model_version)
       VALUES ($1, $2, $2, 0.75, 'open', 'v1') RETURNING id;`,
      [testProjectId, testQuery]
    );
    assert(kg1.rows.length > 0);

    // CHECK constraint on status
    let invalidStatusRejected = false;
    try {
      await client.query(
        `INSERT INTO knowledge_gap_candidates (project_id, query_text, normalized_query, score, status)
         VALUES ($1, 'Another query', 'another query', 0.5, 'invalid_status');`,
        [testProjectId]
      );
    } catch (err: any) {
      if (err.code === "23514") { // check_violation
        invalidStatusRejected = true;
      }
    }
    assert.equal(invalidStatusRejected, true, "knowledge_gap_candidates must reject invalid status values");
    await client.query("DELETE FROM knowledge_gap_candidates WHERE id = $1;", [kg1.rows[0].id]);
    console.log("  ✓ PASS: knowledge_gap_candidates enforces CHECK constraint on lifecycle status");

    // 4c. bot_failure_events taxonomy CHECK constraint
    for (const validClass of [
      "knowledge_missing", "retrieval_failed", "tool_errored", "routing_mismatch",
      "policy_blocked", "evasive_response", "late_escalation", "context_omission"
    ]) {
      const bfe = await client.query(
        `INSERT INTO bot_failure_events (project_id, failure_class, severity, evidence_source)
         VALUES ($1, $2, 'medium', 'unit-test') RETURNING id;`,
        [testProjectId, validClass]
      );
      await client.query("DELETE FROM bot_failure_events WHERE id = $1;", [bfe.rows[0].id]);
    }

    let invalidClassRejected = false;
    try {
      await client.query(
        `INSERT INTO bot_failure_events (project_id, failure_class, severity, evidence_source)
         VALUES ($1, 'unknown_hallucinated_class', 'medium', 'unit-test');`,
        [testProjectId]
      );
    } catch (err: any) {
      if (err.code === "23514") invalidClassRejected = true;
    }
    assert.equal(invalidClassRejected, true, "bot_failure_events must reject unapproved failure classes");
    console.log("  ✓ PASS: bot_failure_events strictly validates 8 approved taxonomy classes");

    // 4d. bot_improvement_proposals lifecycle CHECK constraint
    for (const validStatus of ["draft", "evaluating", "approved", "deployed", "rejected"]) {
      const bip = await client.query(
        `INSERT INTO bot_improvement_proposals (project_id, title, description, target_area, content_hash, status)
         VALUES ($1, 'Test Proposal', 'Test Description', 'prompt', 'hash123', $2) RETURNING id;`,
        [testProjectId, validStatus]
      );
      await client.query("DELETE FROM bot_improvement_proposals WHERE id = $1;", [bip.rows[0].id]);
    }
    let invalidPropStatusRejected = false;
    try {
      await client.query(
        `INSERT INTO bot_improvement_proposals (project_id, title, description, target_area, content_hash, status)
         VALUES ($1, 'Test', 'Test', 'prompt', 'hash123', 'auto_published');`,
        [testProjectId]
      );
    } catch (err: any) {
      if (err.code === "23514") invalidPropStatusRejected = true;
    }
    assert.equal(invalidPropStatusRejected, true, "bot_improvement_proposals must reject unapproved status values");
    console.log("  ✓ PASS: bot_improvement_proposals validates governed lifecycle statuses");

    // -------------------------------------------------------------------------
    // [Test 5] Configuration & Timezone Dynamic Contract
    // -------------------------------------------------------------------------
    console.log("\n[Test 5] Configuration & Dynamic Timezone Contract");
    // Weights sum to 1.00
    const w = INTELLIGENCE_CONFIG.weights;
    const weightSum = w.lowRetrieval + w.customerRephrasing + w.evasiveResponse + w.immediateTakeover;
    assert.equal(Math.round(weightSum * 100) / 100, 1.0, "Weights must sum to 1.00");
    assert.equal(w.lowRetrieval, 0.35, "lowRetrieval weight must be 0.35");
    assert.equal(w.customerRephrasing, 0.25, "customerRephrasing weight must be 0.25");
    assert.equal(w.evasiveResponse, 0.20, "evasiveResponse weight must be 0.20");
    assert.equal(w.immediateTakeover, 0.20, "immediateTakeover weight must be 0.20");
    assert.equal(INTELLIGENCE_CONFIG.thresholds.knowledgeGapScore, 0.50, "Gap threshold must be 0.50");

    // Timezone resolver avoids hardcoded Bangkok
    assert.equal(resolveProjectTimezone("America/New_York"), "America/New_York");
    assert.equal(resolveProjectTimezone("Europe/London"), "Europe/London");
    assert.equal(resolveProjectTimezone("Asia/Bangkok"), "Asia/Bangkok");
    assert.equal(resolveProjectTimezone(null), process.env.DEFAULT_TIMEZONE || "UTC");
    assert.equal(resolveProjectTimezone(""), process.env.DEFAULT_TIMEZONE || "UTC");
    console.log("  ✓ PASS: Discovery weights verified (0.35/0.25/0.20/0.20) and timezone resolver is dynamic");

    console.log("\n===============================================================================");
    console.log(" ALL 5/5 PHASE 3A DATA FOUNDATION VERIFICATION SUITES PASSED!");
    console.log("===============================================================================");
  } finally {
    client.release();
    await pool.end();
  }
}

runPhase3AFoundationVerification().catch((err) => {
  console.error("Phase 3A Foundation Verification failed:", err);
  process.exit(1);
});
