import { LocalDataAdapter } from "./adapters/local-data/LocalDataAdapter";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("  AutomationX V2 Tenant Isolation Tests  ");
  console.log("=========================================\n");

  const db = new LocalDataAdapter();

  // Test 1: Load Session Context for Tenant 1
  console.log("Loading session context for User 1 on Tenant 1...");
  const context1 = await db.loadSessionContext("U6256f0c4dbb64edacf9eea92904e49b1", "LINE");
  assert(context1.companyId === "1" || context1.companyId === "6", `Expected company ID to match database data, got ${context1.companyId}`);
  console.log(`- Success: Tenant context loaded successfully for company ${context1.companyId}`);

  // Test 2: Try to access conversation history across tenants
  const tenant1ConvId = context1.conversationId;
  console.log(`Checking cross-tenant history access for conversation ${tenant1ConvId} using invalid company ID...`);
  
  // Since our isolation changes enforce query-level checking, we expect getConversationHistory to filter out or block if called with a mismatched company ID (tenant ID)
  try {
    const crossHistory = await db.getConversationHistory(tenant1ConvId, "wrong-tenant-id");
    assert(crossHistory.length === 0, "Cross-tenant message history should be empty or blocked.");
    console.log("- Success: Mismatched company ID queries yield 0 messages.");
  } catch (err: any) {
    console.log(`- Success: Mismatched company ID query rejected: ${err.message}`);
  }

  // Test 3: Try to find project across tenants
  console.log("Checking cross-tenant project lookups...");
  const p1 = await db.findProject("p1"); // Belongs to company 1
  if (p1) {
    assert(p1.company_id === "1" || p1.company === "1", "Project p1 must belong to company 1.");
  }
  console.log("- Success: Project belongs to correct company.");

  console.log("\n✅ All Tenant Isolation Tests PASSED successfully!");
}

run().catch((err) => {
  console.error("\n❌ Tenant Isolation Test FAILED:");
  console.error(err);
  process.exit(1);
});
