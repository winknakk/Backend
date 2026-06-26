import { CacheService } from "./cache/CacheService";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    Testing Multi-Tenant Cache Service");
  console.log("=========================================");

  const cache = CacheService.getInstance();
  await cache.clear();

  const tenant1 = "company-101";
  const tenant2 = "company-202";

  const key1 = `tenant:${tenant1}:config`;
  const key2 = `tenant:${tenant2}:config`;

  // 1. Initial State: Misses
  console.log("Verifying initial cache misses...");
  const val1 = await cache.get<any>(key1);
  assert(val1 === null, "Should return null on cache miss");

  const val2 = await cache.get<any>(key2);
  assert(val2 === null, "Should return null on cache miss");

  // Verify Miss Metrics
  let metrics = cache.getMetrics();
  assert(metrics[tenant1]?.misses === 1, "Tenant 1 miss count should be 1");
  assert(metrics[tenant2]?.misses === 1, "Tenant 2 miss count should be 1");
  assert(metrics[tenant1]?.hits === 0, "Tenant 1 hit count should be 0");

  // 2. Set Cache Values
  console.log("Setting cached values...");
  const payload1 = { companyId: tenant1, name: "Acme Corp", status: "Active" };
  const payload2 = { companyId: tenant2, name: "Stark Industries", status: "Active" };

  await cache.set(key1, payload1, 10);
  await cache.set(key2, payload2, 10);

  // 3. Cache Hits
  console.log("Verifying cache hits...");
  const hitVal1 = await cache.get<any>(key1);
  assert(hitVal1 !== null && hitVal1.name === "Acme Corp", "Should return cached object");

  const hitVal2 = await cache.get<any>(key2);
  assert(hitVal2 !== null && hitVal2.name === "Stark Industries", "Should return cached object");

  // Verify Hit Metrics
  metrics = cache.getMetrics();
  assert(metrics[tenant1]?.hits === 1, "Tenant 1 hit count should be 1");
  assert(metrics[tenant2]?.hits === 1, "Tenant 2 hit count should be 1");
  assert(metrics[tenant1]?.ratio === 0.5, "Tenant 1 hit ratio should be 0.5 (1 hit / 2 total)");

  // 4. Test Key Separation (no cross-tenant bleed)
  console.log("Verifying key namespacing...");
  await cache.delete(key1);
  const deletedVal1 = await cache.get<any>(key1);
  assert(deletedVal1 === null, "Deleted key should return null");

  const stillVal2 = await cache.get<any>(key2);
  assert(stillVal2 !== null && stillVal2.name === "Stark Industries", "Other tenant key should remain untouched");

  // 5. Test Cache Clear
  console.log("Verifying cache clear...");
  await cache.clear();
  const clearedVal2 = await cache.get<any>(key2);
  assert(clearedVal2 === null, "After clear, all keys should return null");

  await cache.disconnect();

  console.log("✅ Multi-Tenant Cache tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
