import { pool } from "./adapters/postgres/PostgresAdapter";
import { ConfigLoaderService } from "./services/ConfigLoaderService";
import { CacheService } from "./cache/CacheService";

function assert(condition: any, message: string): void {
  if (!condition) {
    throw new Error(`[Assertion Failed] ${message}`);
  }
}

async function runPhase2Tests() {
  console.log("============================================================");
  console.log("AutomationX V3 Phase 2 configuration dynamic load test runner");
  console.log("============================================================");

  const configLoader = ConfigLoaderService.getInstance();
  const cache = CacheService.getInstance();

  try {
    // 1. Clear any cached configuration keys
    await configLoader.invalidateProjectCache("1");

    // 2. Load Prompts
    console.log("Testing Prompt Config Load...");
    const prompt = await configLoader.getPromptConfig("1");
    assert(prompt !== null, "Prompt config should not be null");
    assert(prompt.modelName === "gemini-1.5-pro", "Model name should be gemini-1.5-pro");
    assert(prompt.temperature === 0.00, "Prompt temperature should be 0.00");
    assert(prompt.systemInstruction.includes("helpful AI Assistant"), "System instruction mismatch");

    // Verify cache exists in Redis
    const cachedPrompt = await cache.get<any>("config:project:1:prompt");
    assert(cachedPrompt !== null, "Prompt config should be cached in Redis");
    assert(cachedPrompt.modelName === "gemini-1.5-pro", "Cached model name mismatch");

    // 3. Load SLA Policies
    console.log("Testing SLA Policy Config Load...");
    const sla = await configLoader.getSlaPolicy("1");
    assert(sla !== null, "SLA policy should not be null");
    assert(sla.policies.length === 4, "Should have 4 SLA policies (P1-P4)");
    
    const p1Policy = sla.policies.find(p => p.priority === "P1");
    assert(p1Policy !== null, "P1 priority policy should exist");
    assert(p1Policy?.resolveHours === 4, "P1 resolve hours must be 4");

    // Verify cache exists in Redis
    const cachedSla = await cache.get<any>("config:project:1:sla");
    assert(cachedSla !== null, "SLA config should be cached in Redis");

    // 4. Test Cache Invalidation and Dynamic DB Updates
    console.log("Testing Cache Invalidation & Dynamic DB Updates...");
    
    // Modify prompt config in PostgreSQL
    await pool.query(
      `UPDATE project_prompts 
       SET system_instruction = 'You are an updated enterprise assistant' 
       WHERE project_id = $1`,
      [1]
    );

    // Call configLoader BEFORE cache invalidation: should still return cached stale value
    const stalePrompt = await configLoader.getPromptConfig("1");
    assert(stalePrompt.systemInstruction.includes("helpful AI Assistant"), "Should return stale cached instruction before invalidation");

    // Invalidate project config cache
    await configLoader.invalidateProjectCache("1");

    // Call configLoader AFTER cache invalidation: should return new updated database value
    const updatedPrompt = await configLoader.getPromptConfig("1");
    assert(updatedPrompt.systemInstruction.startsWith("You are an updated enterprise assistant"), "Should return updated system instruction from database");

    // Verify updated value is cached in Redis
    const newlyCachedPrompt = await cache.get<any>("config:project:1:prompt");
    assert(newlyCachedPrompt.systemInstruction.startsWith("You are an updated enterprise assistant"), "Updated prompt config should be cached in Redis");

    // Restore original prompt config in PostgreSQL
    await pool.query(
      `UPDATE project_prompts 
       SET system_instruction = 'You are an helpful AI Assistant designed to resolve tickets and support customers.' 
       WHERE project_id = $1`,
      [1]
    );
    await configLoader.invalidateProjectCache("1");

    console.log("============================================================");
    console.log("All V3 Phase 2 Configuration Loader Tests Passed!");
    console.log("============================================================");
    process.exit(0);
  } catch (err: any) {
    console.error("============================================================");
    console.error("Phase 2 Configuration Loader Tests Failed:", err.message);
    console.error("============================================================");
    process.exit(1);
  }
}

runPhase2Tests();
