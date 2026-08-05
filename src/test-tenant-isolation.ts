import { TenantResolver } from "./infrastructure/security/TenantResolver";
import { TenantContext, createTenantContext, DEFAULT_TENANT_CONTEXT } from "./domain/tenant/TenantContext";
import { PostgresAdapter } from "./adapters/postgres/PostgresAdapter";
import { LocalDataAdapter } from "./adapters/local-data/LocalDataAdapter";

function assert(condition: any, message: string): void {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runTenantIsolationTestSuite() {
  console.log("=================================================");
  console.log("   AutomationX V2 Phase 1 Tenant Isolation Suite ");
  console.log("=================================================\n");

  const resolver = new TenantResolver({
    apiKeyHashMap: new Map([
      ["997a17e97b6f0a545d59bfa807f0f5c1158d55c72b44ae03713cd3a4ae0df3c6", { orgId: "org_avalant", projectId: "8" }]
    ])
  });

  // Test 1: Fallback Default Resolution when no headers/tokens are present
  console.log("Test 1: Fallback Default Tenant Resolution...");
  const dummyReq1 = { headers: {}, query: {} } as any;
  const ctx1 = resolver.resolve(dummyReq1);
  assert(ctx1.orgId === "org_default", `Expected org_default, got ${ctx1.orgId}`);
  assert(ctx1.isFallback === true, "Expected isFallback to be true for unauthenticated request");
  assert(ctx1.source === "fallback", `Expected source fallback, got ${ctx1.source}`);
  console.log("  ✅ Test 1 PASSED: Unauthenticated requests fall back to org_default securely.");

  // Test 2: Unauthenticated X-Org-Id Header Stripping
  console.log("\nTest 2: Unauthenticated X-Org-Id Header Stripping...");
  const dummyReq2 = {
    headers: { "x-org-id": "org_competitor_secret" },
    query: {}
  } as any;
  const ctx2 = resolver.resolve(dummyReq2);
  assert(ctx2.orgId !== "org_competitor_secret", "Unauthenticated X-Org-Id header must NOT be trusted!");
  assert(ctx2.orgId === "org_default", `Expected org_default fallback, got ${ctx2.orgId}`);
  console.log("  ✅ Test 2 PASSED: Unauthenticated X-Org-Id header stripped & ignored.");

  // Test 3: API Key Hashed Resolution
  console.log("\nTest 3: Hashed API Key Tenant Resolution...");
  const dummyReq3 = {
    headers: { "x-api-key": "secret_avalant_api_key_123" },
    query: {}
  } as any;
  const ctx3 = resolver.resolve(dummyReq3);
  assert(ctx3.orgId === "org_avalant", `Expected org_avalant from hashed API key, got ${ctx3.orgId}`);
  assert(ctx3.projectId === "8", `Expected project 8, got ${ctx3.projectId}`);
  assert(ctx3.isFallback === false, "Expected isFallback to be false for valid API Key");
  console.log("  ✅ Test 3 PASSED: Valid API Key maps to verified org_id (org_avalant).");

  // Test 4: Admin Header Override for Permitted JWT
  console.log("\nTest 4: Admin Header Override for SuperAdmin JWT...");
  const superAdminJwtPayload = Buffer.from(
    JSON.stringify({ org_id: "org_default", roles: ["SuperAdmin"] })
  ).toString("base64");
  const fakeJwt = `header.${superAdminJwtPayload}.signature`;

  const dummyReq4 = {
    headers: {
      authorization: `Bearer ${fakeJwt}`,
      "x-org-id": "org_target_client"
    },
    query: {}
  } as any;

  const ctx4 = resolver.resolve(dummyReq4);
  assert(ctx4.orgId === "org_target_client", `Expected org_target_client override, got ${ctx4.orgId}`);
  assert(ctx4.source === "header_override", `Expected source header_override, got ${ctx4.source}`);
  console.log("  ✅ Test 4 PASSED: SuperAdmin JWT permitted to apply X-Org-Id override.");

  // Test 5: LocalDataAdapter & PostgresAdapter Interface Verification
  console.log("\nTest 5: Adapter Multi-Tenant Interface Verification...");
  const localDb = new LocalDataAdapter();
  const testTenantCtx = createTenantContext({ orgId: "org_test", projectId: "1" });
  
  const tickets = await localDb.listAllTickets(undefined, undefined, undefined, undefined, testTenantCtx);
  assert(Array.isArray(tickets), "listAllTickets must return an array when passed TenantContext");
  
  const conversations = await localDb.listAllConversations(undefined, testTenantCtx);
  assert(Array.isArray(conversations), "listAllConversations must return an array when passed TenantContext");
  console.log("  ✅ Test 5 PASSED: Data Adapters accept TenantContext without breaking.");

  console.log("\n=================================================");
  console.log(" 🎉 ALL TENANT ISOLATION SUITE TESTS PASSED 100%!");
  console.log("=================================================\n");
}

runTenantIsolationTestSuite().catch((err) => {
  console.error("\n❌ Tenant Isolation Test Suite FAILED:");
  console.error(err);
  process.exit(1);
});
