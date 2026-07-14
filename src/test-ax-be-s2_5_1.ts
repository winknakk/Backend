import "./test-env-setup";
import axios from "axios";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { fastify } from "./api/server";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log("============================================================");
  console.log("             Sprint 2.5-1 Integration Tests                 ");
  console.log("============================================================\n");

  const port = 3012;
  await fastify.listen({ port, host: "127.0.0.1" });
  console.log(`Server listening on port ${port}`);

  await pool.query("DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE ticket_id LIKE 'TCK-S251-%')");
  await pool.query("DELETE FROM tickets WHERE ticket_id LIKE 'TCK-S251-%'");
  await pool.query("DELETE FROM conversations WHERE id = 991");

  await pool.query("INSERT INTO conversations (id, project_id, identity_id, status, channel) VALUES (991, 1, 1, 'open', 'LINE')");

  console.log("Running Test 1: API response contract with enrichmentState and aiConfidenceMetrics...");
  const res = await axios.post(`http://127.0.0.1:${port}/api/v1/internal/tickets`, {
    conversationId: "991",
    subject: "Sprint 2.5-1 Test Ticket",
    summary: "Checking if enrichmentState and aiConfidenceMetrics exist in response",
    priority: "P2",
    severity: "low",
  });

  assert(res.data.success === true, "Creation should be successful");
  assert(res.data.data !== undefined, "Response should contain data block");
  const data = res.data.data;
  assert(data.enrichmentState === "PENDING", "Ticket enrichment should start as PENDING");
  assert(data.aiConfidenceMetrics !== undefined, "aiConfidenceMetrics must be present");
  assert(data.aiConfidenceMetrics.title === 0, "Initial title confidence should be 0");
  console.log("Test 1 passed successfully.");

  console.log("\nRunning Test 2: Backend ticket SSE endpoint is not exposed...");
  const ticketId = data.ticketId;
  const sseRes = await axios.get(`http://127.0.0.1:${port}/api/v1/internal/tickets/${ticketId}/events`, {
    validateStatus: () => true,
  });
  assert(sseRes.status === 404, "Ticket SSE endpoint should not be owned by backend");
  console.log("Test 2 passed successfully.");

  await fastify.close();
  console.log("\nAll Sprint 2.5-1 Integration Tests Passed!");
}

runTests().catch((err) => {
  console.error("Sprint 2.5-1 Tests Failed:", err);
  process.exit(1);
});
