import assert from "node:assert/strict";
import Fastify from "fastify";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { KnowledgeGapService } from "./services/KnowledgeGapService";
import { INTELLIGENCE_CONFIG } from "./config/intelligence";
import { registerConversationIntelligenceRoutes } from "./api/routes/conversationIntelligence";

async function runPhase3CSuite() {
  console.log("===============================================================================");
  console.log(" AUTOMATIONX V3 — PHASE 3C KNOWLEDGE GAP & CLUSTERING VERIFICATION SUITE");
  console.log("===============================================================================\n");

  const client = await pool.connect();
  let passCount = 0;

  try {
    // 0. Setup test projects
    const pRes = await client.query("SELECT id, timezone FROM projects ORDER BY id LIMIT 2;");
    assert(pRes.rows.length >= 2, "At least 2 projects required for isolation verification");
    const project1Id = Number(pRes.rows[0].id);
    const project2Id = Number(pRes.rows[1].id);

    const kgService = new KnowledgeGapService(pool);

    // ---------------------------------------------------------------------------
    // [Test 1] Signal 1: Low Retrieval Confidence Evaluation
    // ---------------------------------------------------------------------------
    console.log("[Test 1] Signal 1: Low retrieval confidence evaluation");
    {
      // 1a. Positive: confidence < 0.65 -> score = 1.0
      const sigLow = await kgService.evaluateLowRetrieval(project1Id, 99999, 0.45, 2);
      assert.strictEqual(sigLow.score, 1.0, "Retrieval confidence below 0.65 must score 1.0");

      // 1b. Positive: 0 docs returned -> score = 1.0
      const sigEmpty = await kgService.evaluateLowRetrieval(project1Id, 99999, 0.85, 0);
      assert.strictEqual(sigEmpty.score, 1.0, "Zero retrieved documents must score 1.0");

      // 1c. Negative: confidence >= 0.65 with docs -> score = 0.0
      const sigHigh = await kgService.evaluateLowRetrieval(project1Id, 99999, 0.78, 3);
      assert.strictEqual(sigHigh.score, 0.0, "High retrieval confidence (>= 0.65) with docs must score 0.0");

      console.log("  ✓ PASS: Low retrieval confidence evaluated correctly at threshold boundaries");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 2] Signal 2: Customer Rephrasing Evaluation
    // ---------------------------------------------------------------------------
    console.log("\n[Test 2] Signal 2: Customer rephrasing evaluation within 300s window");
    {
      // Seed conversation and prior message
      const convRes = await client.query(
        `INSERT INTO conversations (project_id, channel, status, handled_by, created_at)
         VALUES ($1, 'webchat', 'open', 'ai', NOW()) RETURNING id;`,
        [project1Id]
      );
      const convId = convRes.rows[0].id;

      const t0 = new Date();
      // Prior message sent 60s ago
      const tPrev = new Date(t0.getTime() - 60000);
      await client.query(
        `INSERT INTO messages (conversation_id, role, content, created_at)
         VALUES ($1, 'user', 'ทำไมยอดเงินในบัญชีถึงไม่ปรับปรุง', $2);`,
        [convId, tPrev]
      );

      // 2a. Positive: rephrased query within 300s
      const currentQuery = "ยอดเงินคงเหลือยังไม่อัปเดต ต้องทำอย่างไร";
      const sigRephrase = await kgService.evaluateCustomerRephrasing(project1Id, convId, currentQuery, t0);
      assert.strictEqual(sigRephrase.score, 1.0, "Rephrased customer query within 300s must score 1.0");

      // 2b. Negative: completely unrelated query
      const unrelatedQuery = "ขอสอบถามเวลาทำการของสาขาสยาม";
      const sigUnrelated = await kgService.evaluateCustomerRephrasing(project1Id, convId, unrelatedQuery, t0);
      assert.strictEqual(sigUnrelated.score, 0.0, "Unrelated query must score 0.0");

      // 2c. Negative: outside 300s window (e.g. 400s later)
      const tLate = new Date(t0.getTime() + 400000);
      const sigLate = await kgService.evaluateCustomerRephrasing(project1Id, convId, currentQuery, tLate);
      assert.strictEqual(sigLate.score, 0.0, "Prior message outside 300s window must not trigger rephrasing signal");

      // Clean up
      await client.query("DELETE FROM messages WHERE conversation_id = $1;", [convId]);
      await client.query("DELETE FROM conversations WHERE id = $1;", [convId]);

      console.log("  ✓ PASS: Customer rephrasing window and token similarity verified");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 3] Signal 3: Evasive / Apology Response Evaluation
    // ---------------------------------------------------------------------------
    console.log("\n[Test 3] Signal 3: Evasive response evaluation");
    {
      // 3a. Thai evasion phrases
      const sigThai1 = kgService.evaluateEvasiveResponse("ขออภัยค่ะ ขณะนี้ระบบไม่พบข้อมูลในส่วนนี้ แนะนำให้ติดต่อเจ้าหน้าที่");
      assert.strictEqual(sigThai1.score, 1.0, "Thai apology phrase must score 1.0");

      const sigThai2 = kgService.evaluateEvasiveResponse("เรื่องนี้อยู่นอกเหนือขอบเขตที่บอทจะตอบได้");
      assert.strictEqual(sigThai2.score, 1.0, "Thai out-of-scope phrase must score 1.0");

      // 3b. English evasion phrases
      const sigEng1 = kgService.evaluateEvasiveResponse("I apologize, but I do not have information about your current order.");
      assert.strictEqual(sigEng1.score, 1.0, "English apology phrase must score 1.0");

      // 3c. Direct non-evasive response
      const sigDirect = kgService.evaluateEvasiveResponse("ยอดเงินคงเหลือของคุณคือ 1,500.00 บาทค่ะ");
      assert.strictEqual(sigDirect.score, 0.0, "Definitive informative answer must score 0.0");

      console.log("  ✓ PASS: Evasive response detection deterministic and accurate");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 4] Signal 4: Immediate Takeover Evaluation
    // ---------------------------------------------------------------------------
    console.log("\n[Test 4] Signal 4: Immediate takeover within 120s window");
    {
      const convRes = await client.query(
        `INSERT INTO conversations (project_id, channel, status, handled_by, created_at)
         VALUES ($1, 'webchat', 'open', 'ai', NOW()) RETURNING id;`,
        [project1Id]
      );
      const convId = convRes.rows[0].id;
      const tMsg = new Date();

      // 4a. Negative: no handoff -> score = 0.0
      const sigNoHandoff = await kgService.evaluateImmediateTakeover(project1Id, convId, tMsg);
      assert.strictEqual(sigNoHandoff.score, 0.0, "No handoff must score 0.0");

      // 4b. Positive: handoff within 120s (e.g. at +45s)
      const tHandoff = new Date(tMsg.getTime() + 45000);
      const handoffRes = await client.query(
        `INSERT INTO conversation_handoffs (conversation_id, project_id, from_handler, to_handler, started_at)
         VALUES ($1, $2, 'ai', 'human', $3) RETURNING id;`,
        [convId, project1Id, tHandoff]
      );
      const handoffId = handoffRes.rows[0].id;

      const sigWithHandoff = await kgService.evaluateImmediateTakeover(project1Id, convId, tMsg);
      assert.strictEqual(sigWithHandoff.score, 1.0, "Handoff within 120s from AI must score 1.0");

      // Clean up
      await client.query("DELETE FROM conversation_handoffs WHERE id = $1;", [handoffId]);
      await client.query("DELETE FROM conversations WHERE id = $1;", [convId]);

      console.log("  ✓ PASS: Immediate takeover window and handler direction verified");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 5] Weighted Candidate Scoring & Idempotent Persistence
    // ---------------------------------------------------------------------------
    console.log("\n[Test 5] Weighted candidate scoring & idempotent persistence");
    {
      const convRes = await client.query(
        `INSERT INTO conversations (project_id, channel, status, handled_by, created_at)
         VALUES ($1, 'webchat', 'open', 'ai', NOW()) RETURNING id;`,
        [project1Id]
      );
      const convId = convRes.rows[0].id;

      const msgRes = await client.query(
        `INSERT INTO messages (conversation_id, role, content, created_at)
         VALUES ($1, 'user', 'ทำไมไม่สามารถโอนเงินระหว่างประเทศได้', NOW()) RETURNING id;`,
        [convId]
      );
      const msgId = msgRes.rows[0].id;

      // 5a. Combination that exceeds threshold (lowRetrieval = 1 [0.35] + evasiveResponse = 1 [0.20] = 0.55 >= 0.50)
      const evalRes1 = await kgService.evaluateAndPersistCandidate({
        projectId: project1Id,
        conversationId: convId,
        messageId: msgId,
        queryText: "ทำไมไม่สามารถโอนเงินระหว่างประเทศได้",
        aiResponseText: "ขออภัยค่ะ ระบบไม่พบข้อมูลการโอนเงินระหว่างประเทศ",
        retrievalConfidence: 0.30,
        retrievedDocsCount: 0,
      });

      assert.strictEqual(evalRes1.isCandidate, true, "Score of 0.55 must qualify as candidate (threshold 0.50)");
      assert(evalRes1.candidate, "Candidate record must be returned");
      assert.strictEqual(evalRes1.candidate.score, 0.55);
      assert.strictEqual(evalRes1.candidate.status, "open");

      const candId = evalRes1.candidate.id;

      // 5b. Idempotent re-run on same turn (ON CONFLICT uq_kg_candidate_turn)
      const evalRes2 = await kgService.evaluateAndPersistCandidate({
        projectId: project1Id,
        conversationId: convId,
        messageId: msgId,
        queryText: "ทำไมไม่สามารถโอนเงินระหว่างประเทศได้",
        aiResponseText: "ขออภัยค่ะ ระบบไม่พบข้อมูลการโอนเงินระหว่างประเทศ",
        retrievalConfidence: 0.30,
        retrievedDocsCount: 0,
      });

      assert.strictEqual(evalRes2.isCandidate, true);
      assert.strictEqual(evalRes2.candidate?.id, candId, "Must return the same candidate ID without duplicate row");

      // Verify row count in DB
      const countRes = await client.query(
        `SELECT count(*)::integer AS total FROM knowledge_gap_candidates WHERE conversation_id = $1;`,
        [convId]
      );
      assert.strictEqual(Number(countRes.rows[0].total), 1, "Exactly one candidate record must exist for this turn");

      // 5c. Sub-threshold score (e.g. only customerRephrasing = 0.25 < 0.50)
      const evalResSub = await kgService.evaluateAndPersistCandidate({
        projectId: project1Id,
        conversationId: convId,
        messageId: 999998,
        queryText: "สอบถามยอดเงิน",
        aiResponseText: "ยอดเงินคงเหลือคือ 2,000 บาท",
        retrievalConfidence: 0.95,
        retrievedDocsCount: 3,
      });
      assert.strictEqual(evalResSub.isCandidate, false, "Sub-threshold score must not qualify as candidate");
      assert.strictEqual(evalResSub.candidate, undefined, "No candidate record created for sub-threshold query");

      // Clean up
      await client.query("DELETE FROM knowledge_gap_candidates WHERE conversation_id = $1;", [convId]);
      await client.query("DELETE FROM messages WHERE conversation_id = $1;", [convId]);
      await client.query("DELETE FROM conversations WHERE id = $1;", [convId]);

      console.log("  ✓ PASS: Weighted scoring formula and idempotent unique constraint verified");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 6] Candidate Review Lifecycle & Tenant Authorization
    // ---------------------------------------------------------------------------
    console.log("\n[Test 6] Candidate review lifecycle & tenant authorization");
    {
      // Insert candidate in project 1
      const cand1Res = await client.query(
        `INSERT INTO knowledge_gap_candidates (
           project_id, query_text, normalized_query, score, evidence, status
         ) VALUES ($1, 'ทดสอบ lifecycle', 'ทดสอบ lifecycle', 0.60, '{}', 'open') RETURNING id;`,
        [project1Id]
      );
      const cand1Id = cand1Res.rows[0].id;

      // 6a. Valid status transition: open -> reviewed
      const updated1 = await kgService.updateCandidateStatus(
        cand1Id,
        "reviewed",
        "กำลังตรวจสอบเอกสาร",
        "operator-1",
        [project1Id]
      );
      assert.strictEqual(updated1?.status, "reviewed");
      assert.strictEqual(updated1?.reviewedBy, "operator-1");
      assert.strictEqual(updated1?.reviewNotes, "กำลังตรวจสอบเอกสาร");
      assert(updated1?.reviewedAt !== null);

      // 6b. Valid status transition: reviewed -> resolved
      const updated2 = await kgService.updateCandidateStatus(
        cand1Id,
        "resolved",
        "เพิ่ม FAQ ในระบบเรียบร้อยแล้ว",
        "operator-2",
        [project1Id]
      );
      assert.strictEqual(updated2?.status, "resolved");
      assert.strictEqual(updated2?.reviewedBy, "operator-2");

      // 6c. Invalid status string rejected
      await assert.rejects(
        async () => {
          await kgService.updateCandidateStatus(cand1Id, "invalid_status" as any, undefined, "op", [project1Id]);
        },
        /Invalid candidate status/,
        "Invalid status must throw descriptive error"
      );

      // 6d. Cross-project authorization rejection
      await assert.rejects(
        async () => {
          // Operator only has access to project 2, attempts to update project 1 candidate
          await kgService.updateCandidateStatus(cand1Id, "ignored", undefined, "op-proj2", [project2Id]);
        },
        /Unauthorized/,
        "Cross-project status update must be rejected with Unauthorized error"
      );

      // Clean up
      await client.query("DELETE FROM knowledge_gap_candidates WHERE id = $1;", [cand1Id]);

      console.log("  ✓ PASS: Candidate review lifecycle transitions and tenant isolation verified");
      passCount++;
    }

    // ---------------------------------------------------------------------------
    // [Test 7] Unanswered Query Clustering & Safeguards
    // ---------------------------------------------------------------------------
    console.log("\n[Test 7] Unanswered query clustering & safeguards");
    {
      const runId = Date.now();
      await client.query("DELETE FROM identities WHERE channel_ref LIKE 'user-cluster-%';");
      await client.query("DELETE FROM knowledge_gap_candidates WHERE query_text LIKE '%สมัครบัตรเครดิต%' OR query_text LIKE '%lifecycle%' OR query_text LIKE '%คำถามลับ%';");

      // Create 2 distinct customer identities in project 1
      const identA = (await client.query(
        `INSERT INTO identities (channel, channel_ref, created_at) VALUES ('webchat', $1, NOW()) RETURNING id;`,
        [`user-cluster-A-${runId}`]
      )).rows[0].id;
      const identB = (await client.query(
        `INSERT INTO identities (channel, channel_ref, created_at) VALUES ('webchat', $1, NOW()) RETURNING id;`,
        [`user-cluster-B-${runId}`]
      )).rows[0].id;

      let candA1: number | null = null;
      let candA2: number | null = null;
      let candA3: number | null = null;
      let candB1: number | null = null;
      let candP2: number | null = null;
      let candOld: number | null = null;
      let convA1: number | null = null;
      let convA2: number | null = null;
      let convB1: number | null = null;
      let convP2: number | null = null;

      try {
        // Create conversations for user A and user B in project 1
        convA1 = (await client.query(
          `INSERT INTO conversations (project_id, channel, status, handled_by, identity_id, created_at) VALUES ($1, 'webchat', 'open', 'ai', $2, NOW()) RETURNING id;`,
          [project1Id, identA]
        )).rows[0].id;
        convA2 = (await client.query(
          `INSERT INTO conversations (project_id, channel, status, handled_by, identity_id, created_at) VALUES ($1, 'webchat', 'open', 'ai', $2, NOW()) RETURNING id;`,
          [project1Id, identA]
        )).rows[0].id;
        convB1 = (await client.query(
          `INSERT INTO conversations (project_id, channel, status, handled_by, identity_id, created_at) VALUES ($1, 'webchat', 'open', 'ai', $2, NOW()) RETURNING id;`,
          [project1Id, identB]
        )).rows[0].id;

        // Also create a conversation in project 2 (for project isolation test)
        convP2 = (await client.query(
          `INSERT INTO conversations (project_id, channel, status, handled_by, created_at) VALUES ($1, 'webchat', 'open', 'ai', NOW()) RETURNING id;`,
          [project2Id]
        )).rows[0].id;

        // 7a. Seed 2 inquiries in project 1 (< minInquiries=3) -> Cluster NOT formed
        candA1 = (await client.query(
          `INSERT INTO knowledge_gap_candidates (project_id, conversation_id, query_text, normalized_query, score, status, created_at)
           VALUES ($1, $2, 'สมัครบัตรเครดิตต้องใช้เอกสารอะไรบ้าง', 'สมัครบัตรเครดิตต้องใช้เอกสารอะไรบ้าง', 0.70, 'open', NOW()) RETURNING id;`,
          [project1Id, convA1]
        )).rows[0].id;

        candA2 = (await client.query(
          `INSERT INTO knowledge_gap_candidates (project_id, conversation_id, query_text, normalized_query, score, status, created_at)
           VALUES ($1, $2, 'ขอเอกสารสมัครบัตรเครดิตหน่อยครับ', 'ขอเอกสารสมัครบัตรเครดิตหน่อยครับ', 0.70, 'open', NOW()) RETURNING id;`,
          [project1Id, convA2]
        )).rows[0].id;

        const clusterResSmall = await kgService.runClusteringForProject(project1Id);
        assert.strictEqual(clusterResSmall.clustersCreated, 0, "Must not form cluster with fewer than 3 inquiries");

        // 7b. Add 3rd inquiry but from same customer profile (unique profiles = 1 < minUniqueProfiles=2) -> Cluster NOT formed
        candA3 = (await client.query(
          `INSERT INTO knowledge_gap_candidates (project_id, conversation_id, query_text, normalized_query, score, status, created_at)
           VALUES ($1, $2, 'อยากทราบเอกสารประกอบการสมัครบัตรเครดิต', 'อยากทราบเอกสารประกอบการสมัครบัตรเครดิต', 0.70, 'open', NOW()) RETURNING id;`,
          [project1Id, convA1]
        )).rows[0].id;

        const clusterResSingleProfile = await kgService.runClusteringForProject(project1Id);
        assert.strictEqual(clusterResSingleProfile.clustersCreated, 0, "Must not form cluster when all inquiries come from single customer profile");

        // 7c. Add 4th inquiry from Customer B (unique profiles = 2 >= minUniqueProfiles, inquiries >= 3) -> Cluster successfully formed!
        candB1 = (await client.query(
          `INSERT INTO knowledge_gap_candidates (project_id, conversation_id, query_text, normalized_query, score, status, created_at)
           VALUES ($1, $2, 'เอกสารที่ต้องใช้ยื่นสมัครบัตรเครดิตมีอะไรบ้าง', 'เอกสารที่ต้องใช้ยื่นสมัครบัตรเครดิตมีอะไรบ้าง', 0.70, 'open', NOW()) RETURNING id;`,
          [project1Id, convB1]
        )).rows[0].id;

        // Also seed an inquiry in Project 2 with identical text to test project isolation
        candP2 = (await client.query(
          `INSERT INTO knowledge_gap_candidates (project_id, conversation_id, query_text, normalized_query, score, status, created_at)
           VALUES ($1, $2, 'สมัครบัตรเครดิตต้องใช้เอกสารอะไรบ้าง', 'สมัครบัตรเครดิตต้องใช้เอกสารอะไรบ้าง', 0.70, 'open', NOW()) RETURNING id;`,
          [project2Id, convP2]
        )).rows[0].id;

        const clusterResSuccess = await kgService.runClusteringForProject(project1Id);
        assert.strictEqual(clusterResSuccess.clustersCreated, 1, "Cluster must form when >= 3 inquiries and >= 2 unique profiles match");
        const cluster = clusterResSuccess.clusters[0];
        assert(cluster.inquiryCount >= 3, "Cluster must have at least 3 inquiries");
        assert(cluster.uniqueProfilesCount >= 2, "Cluster must span at least 2 unique customer profiles");
        assert.strictEqual(cluster.projectId, project1Id, "Cluster must strictly belong to project 1");

        // Verify that Project 2 candidate was NOT clustered with Project 1
        const p2CandCheck = await client.query(
          `SELECT cluster_id FROM knowledge_gap_candidates WHERE id = $1;`,
          [candP2]
        );
        assert.strictEqual(p2CandCheck.rows[0].cluster_id, null, "Candidate in project 2 must never be clustered into project 1 cluster");

        // 7d. Evidence window check: old candidate (> 7 days) must NOT be clustered
        const oldDate = new Date(Date.now() - 10 * 86400000); // 10 days ago
        candOld = (await client.query(
          `INSERT INTO knowledge_gap_candidates (project_id, conversation_id, query_text, normalized_query, score, status, created_at)
           VALUES ($1, $2, 'ขอทราบเอกสารสมัครบัตรเครดิตเพิ่มเติม', 'ขอทราบเอกสารสมัครบัตรเครดิตเพิ่มเติม', 0.70, 'open', $3) RETURNING id;`,
          [project1Id, convA1, oldDate]
        )).rows[0].id;

        // Re-run clustering
        await kgService.runClusteringForProject(project1Id);
        const oldCandCheck = await client.query(
          `SELECT cluster_id FROM knowledge_gap_candidates WHERE id = $1;`,
          [candOld]
        );
        assert.strictEqual(oldCandCheck.rows[0].cluster_id, null, "Candidate older than 7-day evidence window must be excluded from clustering");

        console.log("  ✓ PASS: Semantic clustering safeguards (min 3 inquiries, min 2 profiles, 7d window, tenant isolation) verified");
        passCount++;
      } finally {
        const cIds = [candA1, candA2, candA3, candB1, candP2, candOld].filter((x): x is number => x !== null);
        if (cIds.length > 0) {
          await client.query("DELETE FROM knowledge_gap_candidates WHERE id = ANY($1::int[]);", [cIds]);
        }
        const vIds = [convA1, convA2, convB1, convP2].filter((x): x is number => x !== null);
        if (vIds.length > 0) {
          await client.query("DELETE FROM conversations WHERE id = ANY($1::int[]);", [vIds]);
        }
        await client.query("DELETE FROM identities WHERE id IN ($1, $2);", [identA, identB]);
      }
    }

    // ---------------------------------------------------------------------------
    // [Test 8] Fastify Admin Routes & CoT / Secret Suppression
    // ---------------------------------------------------------------------------
    console.log("\n[Test 8] Fastify Admin Routes & CoT / Secret Suppression");
    {
      const app = Fastify();

      app.decorateRequest("principal", null as any);
      app.decorateRequest("tenantScope", null as any);

      app.addHook("onRequest", async (req: any) => {
        const testUser = req.headers["x-test-user"];
        if (testUser === "operator-project1") {
          req.principal = { subject: "op1@test.com", kind: "operator", role: "agent" };
          req.tenantScope = { unrestricted: false, projectIds: [project1Id] };
          req.user = { username: "op1", role: "agent", project_ids: [project1Id] };
        } else if (testUser === "superadmin") {
          req.principal = { subject: "admin@test.com", kind: "operator", role: "super_admin" };
          req.tenantScope = { unrestricted: true, projectIds: null };
          req.user = { username: "admin", role: "super_admin" };
        }
      });

      await app.register(registerConversationIntelligenceRoutes);

      // Seed a candidate with secret/internal reasoning in evidence
      const candRes = await client.query(
        `INSERT INTO knowledge_gap_candidates (
           project_id, query_text, normalized_query, score, evidence, status
         ) VALUES ($1, 'คำถามลับทดสอบ CoT', 'คำถามลับทดสอบ cot', 0.65, $2::jsonb, 'open') RETURNING id;`,
        [
          project1Id,
          JSON.stringify({
            signals: {
              lowRetrieval: { score: 1.0, details: { rawPrompt: "SECRET_SYSTEM_PROMPT", chainOfThought: "THOUGHT_PROCESS", apiKey: "SK-TEST-123" } },
            },
          }),
        ]
      );
      const candId = candRes.rows[0].id;

      // 8a. GET candidates as operator-project1 -> 200 OK & CoT suppressed
      const getRes = await app.inject({
        method: "GET",
        url: `/api/admin/intelligence/knowledge-gaps/candidates?projectId=${project1Id}`,
        headers: { "x-test-user": "operator-project1" },
      });

      assert.strictEqual(getRes.statusCode, 200);
      const getBody = JSON.parse(getRes.payload);
      assert.strictEqual(getBody.success, true);
      assert(Array.isArray(getBody.candidates));
      const fetchedCand = getBody.candidates.find((c: any) => c.id === candId);
      assert(fetchedCand, "Created candidate must be found");

      // Verify CoT and secrets are suppressed
      const sigDetails = fetchedCand.evidence?.signals?.lowRetrieval?.details;
      assert.strictEqual(sigDetails?.rawPrompt, undefined, "rawPrompt must be suppressed");
      assert.strictEqual(sigDetails?.chainOfThought, undefined, "chainOfThought must be suppressed");
      assert.strictEqual(sigDetails?.apiKey, undefined, "apiKey must be suppressed");

      // 8b. GET candidates for unauthorized project 2 -> 403 Forbidden
      const unauthRes = await app.inject({
        method: "GET",
        url: `/api/admin/intelligence/knowledge-gaps/candidates?projectId=${project2Id}`,
        headers: { "x-test-user": "operator-project1" },
      });
      assert.strictEqual(unauthRes.statusCode, 403, "Access to project 2 must be 403 Forbidden");

      // 8c. PATCH candidate status as operator-project1 -> 200 OK
      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/admin/intelligence/knowledge-gaps/candidates/${candId}/status`,
        headers: { "x-test-user": "operator-project1" },
        payload: { status: "reviewed", reviewNotes: "ตรวจสอบความถูกต้องแล้ว" },
      });
      assert.strictEqual(patchRes.statusCode, 200);
      const patchBody = JSON.parse(patchRes.payload);
      assert.strictEqual(patchBody.candidate.status, "reviewed");
      assert.strictEqual(patchBody.candidate.reviewedBy, "op1");

      // 8d. GET clusters as operator-project1 -> 200 OK
      const clustersRes = await app.inject({
        method: "GET",
        url: `/api/admin/intelligence/knowledge-gaps/clusters?projectId=${project1Id}`,
        headers: { "x-test-user": "operator-project1" },
      });
      assert.strictEqual(clustersRes.statusCode, 200);
      const clustersBody = JSON.parse(clustersRes.payload);
      assert.strictEqual(clustersBody.success, true);
      assert(Array.isArray(clustersBody.clusters));

      // 8e. POST clusters/run as operator-project1 -> 200 OK
      const runRes = await app.inject({
        method: "POST",
        url: `/api/admin/intelligence/knowledge-gaps/clusters/run`,
        headers: { "x-test-user": "operator-project1" },
        payload: { projectId: project1Id },
      });
      assert.strictEqual(runRes.statusCode, 200);
      const runBody = JSON.parse(runRes.payload);
      assert.strictEqual(runBody.success, true);
      assert(typeof runBody.clustersCreated === "number");

      // Clean up
      await client.query("DELETE FROM knowledge_gap_candidates WHERE id = $1;", [candId]);

      console.log("  ✓ PASS: Fastify routes, project isolation, and CoT/secret suppression verified");
      passCount++;
    }

    console.log(`\n===============================================================================`);
    console.log(` ALL PHASE 3C VERIFICATIONS PASSED (${passCount}/8)`);
    console.log(`===============================================================================`);
  } finally {
    client.release();
  }
}

runPhase3CSuite().catch((err) => {
  console.error("\n❌ PHASE 3C SUITE FAILED:", err);
  process.exit(1);
});
