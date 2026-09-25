import assert from "node:assert/strict";
import Fastify from "fastify";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { CustomerIntelligenceService } from "./services/CustomerIntelligenceService";
import { DailyIntelligenceService } from "./services/DailyIntelligenceService";
import { resolveProjectTimezone } from "./config/intelligence";
import { registerConversationIntelligenceRoutes } from "./api/routes/conversationIntelligence";

async function runPhase3BSuite() {
  console.log("===============================================================================");
  console.log(" AUTOMATIONX V3 — PHASE 3B DAILY & CUSTOMER INTELLIGENCE VERIFICATION SUITE");
  console.log("===============================================================================\n");

  const client = await pool.connect();
  let passCount = 0;

  try {
    // Setup test projects and seed fixtures
    const pRes = await client.query("SELECT id, timezone FROM projects ORDER BY id LIMIT 2;");
    assert(pRes.rows.length >= 2, "At least 2 projects required for isolation verification");
    const project1Id = Number(pRes.rows[0].id);
    const project2Id = Number(pRes.rows[1].id);

    const testDate = "2099-05-15";

    // ---------------------------------------------------------------------------
    // [Test 1] Daily Intelligence: Timezone Boundaries & Dynamic Resolution
    // ---------------------------------------------------------------------------
    console.log("[Test 1] Daily Intelligence: Timezone boundaries & non-Bangkok handling");
    {
      // 1. Timezone fallback & custom resolution
      assert.equal(resolveProjectTimezone("America/New_York"), "America/New_York");
      assert.equal(resolveProjectTimezone("UTC"), "UTC");
      assert.equal(resolveProjectTimezone(null), process.env.DEFAULT_TIMEZONE || "UTC");
      assert.equal(resolveProjectTimezone(""), process.env.DEFAULT_TIMEZONE || "UTC");

      // 2. PostgreSQL AT TIME ZONE verification
      const nyRes = await client.query(
        `SELECT 
           ($1 || ' 00:00:00')::timestamp AT TIME ZONE 'America/New_York' AS start_ny,
           ($1 || ' 23:59:59.999')::timestamp AT TIME ZONE 'America/New_York' AS end_ny;`,
        [testDate]
      );
      assert(nyRes.rows[0].start_ny instanceof Date);
      assert(nyRes.rows[0].end_ny instanceof Date);

      const bkkRes = await client.query(
        `SELECT 
           ($1 || ' 00:00:00')::timestamp AT TIME ZONE 'Asia/Bangkok' AS start_bkk,
           ($1 || ' 23:59:59.999')::timestamp AT TIME ZONE 'Asia/Bangkok' AS end_bkk;`,
        [testDate]
      );
      assert.notEqual(
        nyRes.rows[0].start_ny.toISOString(),
        bkkRes.rows[0].start_bkk.toISOString(),
        "New York and Bangkok day boundaries in UTC must differ"
      );

      console.log("  ✓ PASS: Dynamic timezone resolution verified with no hard-coded Bangkok requirement");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 2] Daily Intelligence: Deterministic Rollup & UPSERT Idempotency
    // ---------------------------------------------------------------------------
    // [Test 2] Daily Intelligence: Deterministic Calculation, UPSERT & Deflection Rate Semantics
    // ---------------------------------------------------------------------------
    console.log("\n[Test 2] Daily Intelligence: Deterministic calculation, UPSERT & deflection rate semantics");
    {
      const dailyService = new DailyIntelligenceService(pool);

      // Clean up test date records
      await client.query("DELETE FROM daily_project_intelligence WHERE date = $1::date;", [testDate]);

      // 2a. Targeted Test: zero eligible bot denominator => 0.0
      const emptyResult = await dailyService.calculateDailyRollup(project1Id, testDate);
      assert.equal(emptyResult.projectId, project1Id);
      assert.equal(emptyResult.date, testDate);
      assert.equal(emptyResult.totalConversations, 0);
      assert.equal(emptyResult.totalTickets, 0);
      assert.equal(emptyResult.resolvedTickets, 0);
      assert.equal(emptyResult.slaBreaches, 0);
      assert.equal(emptyResult.humanHandoffs, 0);
      assert.equal(emptyResult.botDeflectionRate, 0.0, "Zero eligible bot conversations must produce 0.0 deflection rate");
      assert.equal(emptyResult.avgLatencyMs, 0.0);
      assert(emptyResult.narrativeSummary.includes("0 conversations"), "Narrative must reflect calculated figures");

      // Verify row exists in daily_project_intelligence
      const dbCheck1 = await client.query(
        "SELECT count(*)::int AS count FROM daily_project_intelligence WHERE project_id = $1 AND date = $2::date;",
        [project1Id, testDate]
      );
      assert.equal(dbCheck1.rows[0].count, 1, "Exactly one daily intelligence row must exist");

      // Re-run calculateDailyRollup (idempotency check)
      const rerunResult = await dailyService.calculateDailyRollup(project1Id, testDate);
      assert.equal(rerunResult.id, emptyResult.id, "Rerun must update the same row via UPSERT, not duplicate");

      // 2b. Targeted Test: bot-resolved/no-handoff (Conversation 1)
      const c1Res = await client.query(
        `INSERT INTO conversations (project_id, channel, status, handled_by, created_at, updated_at)
         VALUES ($1, 'webchat', 'resolved', 'ai', $2::timestamptz, $2::timestamptz)
         RETURNING id;`,
        [project1Id, `${testDate} 10:00:00+00`]
      );
      const conv1Id = c1Res.rows[0].id;

      // Calculate rollup with 1 bot-resolved/no-handoff conversation
      const rollupAfterC1 = await dailyService.calculateDailyRollup(project1Id, testDate);
      assert.equal(rollupAfterC1.botDeflectionRate, 1.0, "1 bot-resolved conv with no handoff must yield deflection rate = 1.0");

      // 2c. Targeted Test: bot-resolved/with-handoff (Conversation 2)
      const c2Res = await client.query(
        `INSERT INTO conversations (project_id, channel, status, handled_by, created_at, updated_at)
         VALUES ($1, 'webchat', 'resolved', 'human', $2::timestamptz, $2::timestamptz)
         RETURNING id;`,
        [project1Id, `${testDate} 11:00:00+00`]
      );
      const conv2Id = c2Res.rows[0].id;

      await client.query(
        `INSERT INTO conversation_handoffs (conversation_id, project_id, from_handler, to_handler, from_owner, to_owner, trigger_type, started_at)
         VALUES ($1, $2, 'ai', 'human', 'ai', 'operator-1', 'escalation', $3::timestamptz);`,
        [conv2Id, project1Id, `${testDate} 10:30:00+00`]
      );

      // Calculate rollup: Numerator = 1 (conv1), Denominator = 2 (conv1 + conv2) => 0.5000
      const rollupAfterC2 = await dailyService.calculateDailyRollup(project1Id, testDate);
      assert.equal(rollupAfterC2.botDeflectionRate, 0.5, "1 bot-resolved and 1 handed-off conv must yield deflection rate = 0.5");

      // 2d. Targeted Test: bot conversation outside the daily boundary (Conversation 3)
      const outsideDate = "2099-06-01";
      const c3Res = await client.query(
        `INSERT INTO conversations (project_id, channel, status, handled_by, created_at, updated_at)
         VALUES ($1, 'webchat', 'resolved', 'ai', $2::timestamptz, $2::timestamptz)
         RETURNING id;`,
        [project1Id, `${outsideDate} 10:00:00+00`]
      );
      const conv3Id = c3Res.rows[0].id;

      // Rollup for testDate must remain unchanged at 0.5 (conv3 is outside boundary)
      const rollupCheckBoundary = await dailyService.calculateDailyRollup(project1Id, testDate);
      assert.equal(rollupCheckBoundary.botDeflectionRate, 0.5, "Conversation on 2099-06-01 must not leak into 2099-05-15 rollup");

      // Rollup for outsideDate should independently reflect conv3 => 1.0
      const rollupOutside = await dailyService.calculateDailyRollup(project1Id, outsideDate);
      assert.equal(rollupOutside.botDeflectionRate, 1.0, "2099-06-01 rollup must independently calculate 1.0");

      // Clean up test conversations & records
      await client.query("DELETE FROM conversation_handoffs WHERE conversation_id IN ($1, $2, $3);", [conv1Id, conv2Id, conv3Id]);
      await client.query("DELETE FROM conversations WHERE id IN ($1, $2, $3);", [conv1Id, conv2Id, conv3Id]);
      await client.query("DELETE FROM daily_project_intelligence WHERE date IN ($1::date, $2::date);", [testDate, outsideDate]);

      console.log("  ✓ PASS: Daily intelligence deflection rate verifies approved day boundary, handoff exclusion, and zero denominator");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 3] Customer Intelligence: Deterministic Formulas & Approved Repeat Problem Semantics
    // ---------------------------------------------------------------------------
    console.log("\n[Test 3] Customer Intelligence: Deterministic facts & approved repeat problem semantics");
    {
      const customerService = new CustomerIntelligenceService(pool);

      // 3a. Customer with 0 conversations
      const nonExistentCustomer = "cust-nonexistent-999999";
      const zeroIntel = await customerService.getCustomerIntelligence(nonExistentCustomer, [project1Id]);
      assert(zeroIntel !== null);
      assert.equal(zeroIntel.totalConversations, 0);
      assert.equal(zeroIntel.totalTickets, 0);
      assert.equal(zeroIntel.frictionRatio, 0.0, "Zero conversations must yield frictionRatio = 0.0 (no NaN/null)");
      assert.equal(zeroIntel.resolutionEfficiency, 0.0, "Zero tickets must yield resolutionEfficiency = 0.0");
      assert.equal(zeroIntel.repeatProblemCount, 0);
      assert.equal(zeroIntel.lastActivityAt, null);

      // Setup customer test identity
      const testCustomerRef = `cust-test-${Date.now()}`;
      const identRes = await client.query(
        `INSERT INTO identities (channel, channel_ref, created_at)
         VALUES ('line', $1, NOW()) RETURNING id;`,
        [testCustomerRef]
      );
      const testIdentId = identRes.rows[0].id;

      const convRes = await client.query(
        `INSERT INTO conversations (project_id, channel, status, handled_by, identity_id, created_at)
         VALUES ($1, 'line', 'open', 'ai', $2, NOW()) RETURNING id;`,
        [project1Id, testIdentId]
      );
      const testConvId = convRes.rows[0].id;

      // 3b. Targeted Test: reopened-only ticket (reopened_count = 1, duplicate_of_ticket_id = null, issue_category = null)
      // Approved contract: reopened-only tickets count in reopenedTickets, but NOT in repeatProblemCount!
      const t1Res = await client.query(
        `INSERT INTO tickets (conversation_id, project_id, ticket_number, subject, status, reopened_count, sla_breached, created_at)
         VALUES ($1, $2, $3, 'Reopened Ticket Subject', 'RESOLVED', 1, true, NOW()) RETURNING id;`,
        [testConvId, project1Id, `TCK-REOPEN-${Date.now()}`]
      );
      const ticket1Id = t1Res.rows[0].id;

      const intelReopenOnly = await customerService.getCustomerIntelligence(testCustomerRef, [project1Id]);
      assert(intelReopenOnly !== null);
      assert.equal(intelReopenOnly.reopenedTickets, 1, "reopenedTickets must be 1");
      assert.equal(
        intelReopenOnly.repeatProblemCount,
        0,
        "Reopened-only ticket must NOT count as repeatProblemCount (no duplicate, no recurring category)"
      );

      // 3c. Targeted Test: duplicate ticket (duplicate_of_ticket_id IS NOT NULL)
      const t2Res = await client.query(
        `INSERT INTO tickets (conversation_id, project_id, ticket_number, subject, status, duplicate_of_ticket_id, created_at)
         VALUES ($1, $2, $3, 'Duplicate Ticket Subject', 'OPEN', $4, NOW()) RETURNING id;`,
        [testConvId, project1Id, `TCK-DUP-${Date.now()}`, ticket1Id]
      );
      const ticket2Id = t2Res.rows[0].id;

      const intelDuplicate = await customerService.getCustomerIntelligence(testCustomerRef, [project1Id]);
      assert(intelDuplicate !== null);
      assert.equal(intelDuplicate.repeatProblemCount, 1, "duplicate_of_ticket_id IS NOT NULL must increment repeatProblemCount to 1");

      // 3d. Targeted Test: recurring issue category within 30 days
      // First category ticket created 10 days ago
      const tCat1Res = await client.query(
        `INSERT INTO tickets (conversation_id, project_id, ticket_number, subject, status, issue_category, created_at)
         VALUES ($1, $2, $3, 'Category Ticket 1', 'OPEN', 'hardware_defect', NOW() - INTERVAL '10 days') RETURNING id;`,
        [testConvId, project1Id, `TCK-CAT1-${Date.now()}`]
      );
      const ticketCat1Id = tCat1Res.rows[0].id;

      // Second category ticket with same category created today (10 days delta <= 30 days)
      const tCat2Res = await client.query(
        `INSERT INTO tickets (conversation_id, project_id, ticket_number, subject, status, issue_category, created_at)
         VALUES ($1, $2, $3, 'Category Ticket 2', 'OPEN', 'hardware_defect', NOW()) RETURNING id;`,
        [testConvId, project1Id, `TCK-CAT2-${Date.now()}`]
      );
      const ticketCat2Id = tCat2Res.rows[0].id;

      // Repeat problems should now be: ticket2 (duplicate) + ticketCat2 (recurring category within 30 days) = 2
      const intelRecurringCat = await customerService.getCustomerIntelligence(testCustomerRef, [project1Id]);
      assert(intelRecurringCat !== null);
      assert.equal(
        intelRecurringCat.repeatProblemCount,
        2,
        "Recurring issue_category within 30 days must be counted in repeatProblemCount"
      );

      // 3e. Targeted Test: issue category outside 30 days (> 30 days delta does NOT count)
      // Ticket A created 45 days ago
      const tCatOldRes = await client.query(
        `INSERT INTO tickets (conversation_id, project_id, ticket_number, subject, status, issue_category, created_at)
         VALUES ($1, $2, $3, 'Category Ticket Old', 'OPEN', 'network_timeout', NOW() - INTERVAL '45 days') RETURNING id;`,
        [testConvId, project1Id, `TCK-OLD-${Date.now()}`]
      );
      const ticketCatOldId = tCatOldRes.rows[0].id;

      // Ticket B created today (45 days delta > 30 days)
      const tCatNewRes = await client.query(
        `INSERT INTO tickets (conversation_id, project_id, ticket_number, subject, status, issue_category, created_at)
         VALUES ($1, $2, $3, 'Category Ticket New', 'OPEN', 'network_timeout', NOW()) RETURNING id;`,
        [testConvId, project1Id, `TCK-NEW-${Date.now()}`]
      );
      const ticketCatNewId = tCatNewRes.rows[0].id;

      // Repeat problems must still be 2 (network_timeout was > 30 days apart, not recurring in window)
      const intelOutsideWindow = await customerService.getCustomerIntelligence(testCustomerRef, [project1Id]);
      assert(intelOutsideWindow !== null);
      assert.equal(
        intelOutsideWindow.repeatProblemCount,
        2,
        "Issue category recurrence outside 30-day window (> 30 days) must NOT count as repeat problem"
      );

      // Clean up seed tickets & conversation
      await client.query("DELETE FROM tickets WHERE id IN ($1, $2, $3, $4, $5, $6);", [
        ticket1Id,
        ticket2Id,
        ticketCat1Id,
        ticketCat2Id,
        ticketCatOldId,
        ticketCatNewId,
      ]);
      await client.query("DELETE FROM conversations WHERE id = $1;", [testConvId]);
      await client.query("DELETE FROM identities WHERE id = $1;", [testIdentId]);

      console.log("  ✓ PASS: Customer intelligence repeat problem verifies duplicate_of_ticket_id, 30-day window, and reopen isolation");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 4] Tenant Isolation: Cross-Project Access Rejection
    // ---------------------------------------------------------------------------
    console.log("\n[Test 4] Tenant Isolation: Cross-project customer access rejected");
    {
      const customerService = new CustomerIntelligenceService(pool);

      // Seed customer in project 2
      const proj2CustomerRef = `cust-proj2-${Date.now()}`;
      const ident2Res = await client.query(
        `INSERT INTO identities (channel, channel_ref, created_at)
         VALUES ('webchat', $1, NOW()) RETURNING id;`,
        [proj2CustomerRef]
      );
      const ident2Id = ident2Res.rows[0].id;

      const conv2Res = await client.query(
        `INSERT INTO conversations (project_id, channel, status, handled_by, identity_id, created_at)
         VALUES ($1, 'webchat', 'open', 'ai', $2, NOW()) RETURNING id;`,
        [project2Id, ident2Id]
      );
      const conv2Id = conv2Res.rows[0].id;

      // Operator only authorized for project 1 tries to access project 2 customer
      const isolatedIntel = await customerService.getCustomerIntelligence(proj2CustomerRef, [project1Id]);
      assert.strictEqual(isolatedIntel, null, "Operator with scope [project1] must NOT access customer in project2");

      // Clean up
      await client.query("DELETE FROM conversations WHERE id = $1;", [conv2Id]);
      await client.query("DELETE FROM identities WHERE id = $1;", [ident2Id]);

      console.log("  ✓ PASS: Customer intelligence strictly rejects cross-project data leakage");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 5] Fastify Route Integration & CoT Suppression
    // ---------------------------------------------------------------------------
    console.log("\n[Test 5] Fastify Route Integration: Project scoping & CoT suppression");
    {
      const app = Fastify();

      // Mock auth and tenantScope hooks matching backend architecture
      app.decorateRequest("principal", null as any);
      app.decorateRequest("tenantScope", null as any);

      // Inject custom tenantScope based on test headers
      app.addHook("onRequest", async (req: any) => {
        const testUser = req.headers["x-test-user"];
        if (testUser === "operator-project1") {
          req.principal = { subject: "op1@test.com", kind: "operator", role: "agent" };
          req.tenantScope = { unrestricted: false, projectIds: [project1Id] };
        } else if (testUser === "superadmin") {
          req.principal = { subject: "admin@test.com", kind: "operator", role: "super_admin" };
          req.tenantScope = { unrestricted: true, projectIds: null };
        }
      });

      await app.register(registerConversationIntelligenceRoutes);

      // 5a. Operator 1 requests daily intelligence for project 1 -> 200 OK
      const resProj1 = await app.inject({
        method: "GET",
        url: `/api/admin/intelligence/daily?projectId=${project1Id}&date=${testDate}`,
        headers: { "x-test-user": "operator-project1" },
      });
      assert.equal(resProj1.statusCode, 200);
      const jsonProj1 = JSON.parse(resProj1.body);
      assert.equal(jsonProj1.success, true);
      assert(jsonProj1.daily);
      assert.equal(jsonProj1.daily.projectId, project1Id);

      // 5b. Operator 1 requests daily intelligence for project 2 -> 403 Forbidden
      const resProj2 = await app.inject({
        method: "GET",
        url: `/api/admin/intelligence/daily?projectId=${project2Id}&date=${testDate}`,
        headers: { "x-test-user": "operator-project1" },
      });
      assert.equal(resProj2.statusCode, 403);

      // 5c. Forged x-project-id header cannot bypass principal authorization
      const resForged = await app.inject({
        method: "GET",
        url: `/api/admin/intelligence/daily?projectId=${project2Id}`,
        headers: {
          "x-test-user": "operator-project1",
          "x-project-id": String(project2Id),
        },
      });
      assert.equal(resForged.statusCode, 403, "Forged header must not bypass authorized principal scope");

      // 5d. CoT Suppression: Ensure response contains 0 reasoning or thinking keys
      const rawBody = resProj1.body;
      assert(!rawBody.includes("thinking_content"), "Response must NOT contain thinking_content");
      assert(!rawBody.includes("reasoning_steps"), "Response must NOT contain reasoning_steps");
      assert(!rawBody.includes("chain_of_thought"), "Response must NOT contain chain_of_thought");

      // Clean up test date records
      await client.query("DELETE FROM daily_project_intelligence WHERE date = $1::date;", [testDate]);

      console.log("  ✓ PASS: Route endpoints enforce principal project bounds and eliminate CoT leakage");
      passCount++;
    }

    console.log("\n===============================================================================");
    console.log(` ALL ${passCount}/${passCount} PHASE 3B INTELLIGENCE TESTS PASSED!`);
    console.log("===============================================================================");
  } finally {
    client.release();
    await pool.end();
  }
}

runPhase3BSuite().catch((err) => {
  console.error("Phase 3B Suite failed:", err);
  process.exit(1);
});
