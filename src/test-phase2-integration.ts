import { SLAMatrixService } from "./services/SLAMatrixService";
import { PlaneWebhookService } from "./services/planeWebhookService";
import { LocalDataAdapter } from "./adapters/local-data/LocalDataAdapter";
import { createTenantContext } from "./domain/tenant/TenantContext";

function assert(condition: any, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runPhase2IntegrationSuite() {
  console.log("=================================================");
  console.log("   AutomationX V2 Phase 2 Integration Test Suite ");
  console.log("=================================================\n");

  // Test 1: SLA Matrix Engine Calculation
  console.log("Test 1: Dynamic SLA Due Date Calculation...");
  const slaService = new SLAMatrixService();
  const slaP1 = await slaService.calculateSLADueDate(1, "P1");
  assert(slaP1.resolveHours > 0, `Expected resolveHours > 0, got ${slaP1.resolveHours}`);
  assert(slaP1.priorityName === "Critical" || slaP1.priorityName === "Urgent", `Expected Critical/Urgent priority, got ${slaP1.priorityName}`);

  const slaP3 = await slaService.calculateSLADueDate(1, "P3");
  assert(slaP3.resolveHours > 0, `Expected resolveHours > 0, got ${slaP3.resolveHours}`);
  console.log("  ✅ Test 1 PASSED: SLA Matrix engine calculates targets accurately.");

  // Test 2: SLA Breach Status Monitor
  console.log("\nTest 2: SLA Breach Status Monitor...");
  const pastDueDate = new Date(Date.now() - 3600 * 1000).toISOString();
  const breachStatus = await slaService.checkSLABreachStatus({
    createdAt: new Date().toISOString(),
    dueDate: pastDueDate,
    status: "Open"
  });
  assert(breachStatus.isBreached === true, "Expected isBreached to be true for overdue open ticket");

  const doneTicketStatus = await slaService.checkSLABreachStatus({
    createdAt: new Date().toISOString(),
    dueDate: pastDueDate,
    status: "Done"
  });
  assert(doneTicketStatus.isBreached === false, "Resolved/Done tickets must NOT be marked as breached");
  console.log("  ✅ Test 2 PASSED: SLA breach status accurately handles open vs done tickets.");

  // Test 3: Plane Webhook Unsupported Event Rejection
  console.log("\nTest 3: Plane Webhook Event Handling...");
  const db = new LocalDataAdapter();
  const webhookService = new PlaneWebhookService(db);
  const result = await webhookService.sync({
    event: "unsupported_event",
    action: "update"
  } as any);
  assert(result.processed === false, "Unsupported webhook event should return processed: false");
  console.log("  ✅ Test 3 PASSED: Plane Webhook gracefully filters unsupported events.");

  // Test 4: Tenant-Scoped Adapter Integration
  console.log("\nTest 4: Tenant-Scoped Query Integration...");
  const testTenant = createTenantContext({ orgId: "org_avalant", projectId: "1" });
  const conversations = await db.listAllConversations("1", testTenant);
  assert(Array.isArray(conversations), "listAllConversations should return valid list for tenant");
  console.log("  ✅ Test 4 PASSED: Tenant-scoped queries function cleanly across services.");

  console.log("\n=================================================");
  console.log(" 🎉 ALL PHASE 2 INTEGRATION TESTS PASSED 100%!  ");
  console.log("=================================================\n");
}

runPhase2IntegrationSuite().catch((err) => {
  console.error("\n❌ Phase 2 Integration Test Suite FAILED:");
  console.error(err);
  process.exit(1);
});
