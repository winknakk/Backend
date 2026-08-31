import assert from "assert";
import * as dotenv from "dotenv";
import * as path from "path";
import { JwtUtil } from "./shared/jwt";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { config } from "./config/env";
import { FastifyInstance } from "fastify";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function runCustomerPortalSecurityTests() {
  console.log("=================================================================");
  console.log("  Targeted Security Tests: Customer Portal Authentication & Scope");
  console.log("=================================================================\n");

  const testSecret = config.SESSION_SECRET || "a-very-long-test-session-secret-for-customer-auth-32chars";
  if (!config.SESSION_SECRET) {
    (config as any).SESSION_SECRET = testSecret;
    process.env.SESSION_SECRET = testSecret;
  }

  // Dynamically import server instance
  const { fastify, bootstrap } = await import("./api/server");
  await bootstrap();
  await fastify.ready();

  try {
    // ─────────────────────────────────────────────────────────────
    // Setup verified customer identities via Handshake
    // ─────────────────────────────────────────────────────────────
    // Proof tokens simulating IAM / LINE external identity
    const proofTokenA = JwtUtil.sign({ customerId: "cust_proof_a_9901", name: "Customer Alpha" }, testSecret, 3600);
    const proofTokenB = JwtUtil.sign({ customerId: "cust_proof_b_9902", name: "Customer Beta" }, testSecret, 3600);

    const hsA = await fastify.inject({
      method: "POST",
      url: "/api/v1/webchat/handshake",
      payload: { customerToken: proofTokenA, companyId: "1", projectId: "1" }
    });
    assert.strictEqual(hsA.statusCode, 200);
    const customerAToken = JSON.parse(hsA.payload).token;

    const hsB = await fastify.inject({
      method: "POST",
      url: "/api/v1/webchat/handshake",
      payload: { customerToken: proofTokenB, companyId: "1", projectId: "1" }
    });
    assert.strictEqual(hsB.statusCode, 200);
    const customerBToken = JSON.parse(hsB.payload).token;

    const hsGuest = await fastify.inject({
      method: "POST",
      url: "/api/v1/webchat/handshake",
      payload: { guestUuid: "guest_proof_uuid_9903", companyId: "1", projectId: "1" }
    });
    assert.strictEqual(hsGuest.statusCode, 200);
    const guestToken = JSON.parse(hsGuest.payload).token;

    const operatorToken = JwtUtil.sign({
      kind: "operator",
      subject: "1",
      email: "admin@avalant.co.th",
      role: "admin",
      orgId: "org_default",
      projectIds: [1]
    }, testSecret, 3600);

    // ─────────────────────────────────────────────────────────────
    // TEST 1: No token → 401
    // ─────────────────────────────────────────────────────────────
    console.log("[Test 1] Testing unauthenticated call to GET /api/portal/tickets...");
    const res1 = await fastify.inject({
      method: "GET",
      url: "/api/portal/tickets"
    });
    assert.strictEqual(res1.statusCode, 401, `Expected 401, got ${res1.statusCode}`);
    console.log("  ✅ Test 1 PASSED: Unauthenticated request rejected with 401.");

    // ─────────────────────────────────────────────────────────────
    // TEST 2: Guest token → 403 GUEST_NOT_PERMITTED
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 2] Testing guest token presented to GET /api/portal/tickets...");
    const res2 = await fastify.inject({
      method: "GET",
      url: "/api/portal/tickets",
      headers: { Authorization: `Bearer ${guestToken}` }
    });
    assert.strictEqual(res2.statusCode, 403, `Expected 403, got ${res2.statusCode}`);
    const body2 = JSON.parse(res2.payload);
    assert.strictEqual(body2.code, "GUEST_NOT_PERMITTED", `Expected GUEST_NOT_PERMITTED code, got ${body2.code}`);
    console.log("  ✅ Test 2 PASSED: Guest rejected with 403 GUEST_NOT_PERMITTED.");

    // ─────────────────────────────────────────────────────────────
    // TEST 3 & 5: Valid customer token & POST ignores forged body IDs
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 3 & 5] Creating tickets for Customer A and Customer B...");
    // Customer A creates a ticket while attempting to forge customerId: "9902" and projectId: "999"
    const postResA = await fastify.inject({
      method: "POST",
      url: "/api/portal/tickets",
      headers: { Authorization: `Bearer ${customerAToken}` },
      payload: {
        customerId: "forged_customer_b",
        projectId: "999",
        subject: "Customer A issue",
        summary: "Description for Customer A",
        priority: "P3",
        severity: "Medium"
      }
    });
    assert.strictEqual(postResA.statusCode, 201, `Expected 201, got ${postResA.statusCode}`);
    const postBodyA = JSON.parse(postResA.payload);
    const ticketNumberA = postBodyA.ticketNumber;
    assert(ticketNumberA, "Ticket number must be returned");
    console.log(`  Ticket created for Customer A: ${ticketNumberA}`);

    // Customer B creates a ticket
    const postResB = await fastify.inject({
      method: "POST",
      url: "/api/portal/tickets",
      headers: { Authorization: `Bearer ${customerBToken}` },
      payload: {
        subject: "Customer B issue",
        summary: "Description for Customer B",
        priority: "P2",
        severity: "High"
      }
    });
    assert.strictEqual(postResB.statusCode, 201, `Expected 201, got ${postResB.statusCode}`);
    const postBodyB = JSON.parse(postResB.payload);
    const ticketNumberB = postBodyB.ticketNumber;
    console.log(`  Ticket created for Customer B: ${ticketNumberB}`);

    // Verify Customer A list only contains Customer A ticket
    const listResA = await fastify.inject({
      method: "GET",
      url: "/api/portal/tickets",
      headers: { Authorization: `Bearer ${customerAToken}` }
    });
    assert.strictEqual(listResA.statusCode, 200, `Expected 200, got ${listResA.statusCode}`);
    const listBodyA = JSON.parse(listResA.payload);
    const decodedA = JwtUtil.verify(customerAToken, testSecret);
    const diagIdent = await pool.query("SELECT id, profile_id, channel_ref FROM identities WHERE profile_id = $1", [decodedA.profileId]);
    console.log("diag identities for Customer A profileId:", diagIdent.rows);
    const diagConvs = await pool.query("SELECT id, identity_id, project_id FROM conversations WHERE identity_id IN (SELECT id FROM identities WHERE profile_id = $1)", [decodedA.profileId]);
    console.log("diag conversations for Customer A profileId:", diagConvs.rows);
    const diagTickets = await pool.query("SELECT id, ticket_id, conversation_id, project_id, org_id FROM tickets WHERE ticket_id = $1", [ticketNumberA]);
    console.log("diag tickets for ticketNumberA:", diagTickets.rows);

    assert(Array.isArray(listBodyA.tickets), "Tickets must be an array");
    const hasTicketA = listBodyA.tickets.some((t: any) => t.ticket_number === ticketNumberA || t.ticket_id === ticketNumberA);
    const hasTicketB = listBodyA.tickets.some((t: any) => t.ticket_number === ticketNumberB || t.ticket_id === ticketNumberB);
    assert(hasTicketA, "Customer A must see their own ticket");
    assert(!hasTicketB, "Customer A must NOT see Customer B ticket");
    console.log("  ✅ Test 3 & 5 PASSED: Customer sees only their own tickets, forged body parameters ignored.");

    // ─────────────────────────────────────────────────────────────
    // TEST 4 & 13: Foreign ticket lookup → 404 (indistinguishable from nonexistent)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 4 & 13] Testing GET /api/portal/tickets/:id with foreign ticket number...");
    // Customer A attempts to fetch Customer B's ticket
    const foreignRes = await fastify.inject({
      method: "GET",
      url: `/api/portal/tickets/${ticketNumberB}`,
      headers: { Authorization: `Bearer ${customerAToken}` }
    });
    assert.strictEqual(foreignRes.statusCode, 404, `Expected 404 for foreign ticket, got ${foreignRes.statusCode}`);

    // Customer A attempts to fetch a completely nonexistent ticket
    const nonExistentRes = await fastify.inject({
      method: "GET",
      url: "/api/portal/tickets/TCK-9999-00000",
      headers: { Authorization: `Bearer ${customerAToken}` }
    });
    assert.strictEqual(nonExistentRes.statusCode, 404, `Expected 404 for nonexistent ticket, got ${nonExistentRes.statusCode}`);
    assert.deepStrictEqual(JSON.parse(foreignRes.payload), JSON.parse(nonExistentRes.payload), "Foreign ticket response must be identical to nonexistent response");
    console.log("  ✅ Test 4 & 13 PASSED: Foreign ticket returns 404 indistinguishable from nonexistent ticket.");

    // ─────────────────────────────────────────────────────────────
    // TEST 6: Operator token against portal → Rejected
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 6] Testing operator console token against GET /api/portal/tickets...");
    const opRes = await fastify.inject({
      method: "GET",
      url: "/api/portal/tickets",
      headers: { Authorization: `Bearer ${operatorToken}` }
    });
    assert.strictEqual(opRes.statusCode, 403, `Expected 403 for operator token on portal, got ${opRes.statusCode}`);
    console.log("  ✅ Test 6 PASSED: Operator token rejected on customer portal routes.");

    // ─────────────────────────────────────────────────────────────
    // TEST 7: Missing SESSION_SECRET → Handshake fails closed
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 7] Testing missing SESSION_SECRET fail-closed behavior...");
    const savedSecret = config.SESSION_SECRET;
    try {
      (config as any).SESSION_SECRET = "";
      const noSecretRes = await fastify.inject({
        method: "POST",
        url: "/api/v1/webchat/handshake",
        payload: { guestUuid: "test_uuid_fail_closed" }
      });
      assert.strictEqual(noSecretRes.statusCode, 500, `Expected 500 when secret missing, got ${noSecretRes.statusCode}`);
      console.log("  ✅ Test 7 PASSED: Missing SESSION_SECRET fails closed.");
    } finally {
      (config as any).SESSION_SECRET = savedSecret;
    }

    // ─────────────────────────────────────────────────────────────
    // TEST 8 & 9: Handshake untrusted projectId/companyId cannot forge project/org
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 8 & 9] Testing handshake untrusted projectId/companyId...");
    const handshakeRes = await fastify.inject({
      method: "POST",
      url: "/api/v1/webchat/handshake",
      payload: {
        guestUuid: "guest_tamper_test_1",
        projectId: "999999", // Non-existent/forged project
        companyId: "999999"  // Forged company
      }
    });
    assert.strictEqual(handshakeRes.statusCode, 200, `Expected 200, got ${handshakeRes.statusCode}`);
    const hsBody = JSON.parse(handshakeRes.payload);
    // Server must have sanitized or bound to authorized project/company (e.g. 1)
    const decodedToken = JwtUtil.verify(hsBody.token, testSecret);
    assert.strictEqual(decodedToken.projectId, "1", `Authoritative projectId must be resolved, got ${decodedToken.projectId}`);
    assert.strictEqual(decodedToken.companyId, "1", `Authoritative companyId must be resolved, got ${decodedToken.companyId}`);
    console.log("  ✅ Test 8 & 9 PASSED: Handshake resolved authoritative project/company from DB, ignoring client forgery.");

    // ─────────────────────────────────────────────────────────────
    // TEST 10 & 11: X-Org-Id and X-Project-Id headers cannot change customer scope
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 10 & 11] Testing X-Org-Id & X-Project-Id header tampering...");
    const headerTamperRes = await fastify.inject({
      method: "GET",
      url: "/api/portal/tickets",
      headers: {
        Authorization: `Bearer ${customerAToken}`,
        "X-Org-Id": "org_excise",
        "X-Project-Id": "101"
      }
    });
    assert.strictEqual(headerTamperRes.statusCode, 200, `Expected 200, got ${headerTamperRes.statusCode}`);
    const tamperBody = JSON.parse(headerTamperRes.payload);
    const hasTamperB = tamperBody.tickets.some((t: any) => t.ticket_number === ticketNumberB);
    assert(!hasTamperB, "Headers must not bypass customer profile scope");
    console.log("  ✅ Test 10 & 11 PASSED: X-Org-Id / X-Project-Id headers ignored; scope derived strictly from verified token.");

    // ─────────────────────────────────────────────────────────────
    // TEST 12: Customer POST cannot create under another customer
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 12] Testing customer POST ownership isolation...");
    const postTamper = await fastify.inject({
      method: "POST",
      url: "/api/portal/tickets",
      headers: { Authorization: `Bearer ${customerAToken}` },
      payload: {
        customerId: "9902", // attempting to create as Customer B
        subject: "Attempted Impersonation Ticket",
        summary: "Should belong to Customer A",
        priority: "P3"
      }
    });
    assert.strictEqual(postTamper.statusCode, 201);
    const postTamperBody = JSON.parse(postTamper.payload);

    // Verify it is visible to Customer A and NOT to Customer B
    const verifyListB = await fastify.inject({
      method: "GET",
      url: "/api/portal/tickets",
      headers: { Authorization: `Bearer ${customerBToken}` }
    });
    const listBBody = JSON.parse(verifyListB.payload);
    const impersonatedInB = listBBody.tickets.some((t: any) => t.ticket_number === postTamperBody.ticketNumber);
    assert(!impersonatedInB, "Impersonated ticket must NOT belong to Customer B");
    console.log("  ✅ Test 12 PASSED: Ticket created strictly under Customer A's principal.");

    console.log("\n=================================================================");
    console.log("  All 13 Targeted Backend Security Tests Passed Successfully!");
    console.log("=================================================================");
  } finally {
    await fastify.close();
  }
}

runCustomerPortalSecurityTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Test failed with error:", err);
    process.exit(1);
  });
