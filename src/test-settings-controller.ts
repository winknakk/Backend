process.env.API_KEY = "test-api-key";

import axios from "axios";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { ConfigLoaderService } from "./services/ConfigLoaderService";
import { config } from "./config/env";

const PORT = 3012;
const BASE_URL = `http://localhost:${PORT}/api/v1/admin`;

async function runTests() {
  console.log("=== AX-BE-060: Verification Test Suite ===");

  // 1. Configure env and boot server programmatically
  config.API_KEY = "test-api-key";
  const { fastify, bootstrap } = await import("./api/server");
  await bootstrap();
  await fastify.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`[Test Server] Started programmatically on port ${PORT}`);

  const projectId = "1";
  const authHeaders = {
    headers: {
      "Authorization": "Bearer test-api-key"
    }
  };

  try {
    // 2. Clear previous audit logs for a clean test
    await pool.query("DELETE FROM admin_audit_logs");

    // 3. Test Input Validations (Expect 400 Bad Request)
    console.log("\n--- Testing Validations ---");

    // A. Invalid Priority
    try {
      await axios.post(`${BASE_URL}/projects/${projectId}/sla`, {
        priority: "INVALID_P",
        resolve_hours: 24
      }, authHeaders);
      console.error("❌ Test Failed: Invalid SLA priority did not throw 400");
    } catch (err: any) {
      if (err.response && err.response.status === 400) {
        console.log("✅ Success: Invalid priority rejected correctly:", err.response.data.message);
      } else {
        console.error("❌ Test Failed: Invalid priority returned status", err.response?.status);
      }
    }

    // B. Invalid Timezone
    try {
      await axios.post(`${BASE_URL}/projects/${projectId}/business-hours`, {
        day_of_week: 1,
        start_time: "09:00",
        end_time: "17:00",
        timezone: "Mars/Olympus_Mons"
      }, authHeaders);
      console.error("❌ Test Failed: Invalid timezone did not throw 400");
    } catch (err: any) {
      if (err.response && err.response.status === 400) {
        console.log("✅ Success: Invalid timezone rejected correctly:", err.response.data.message);
      } else {
        console.error("❌ Test Failed: Invalid timezone returned status", err.response?.status);
      }
    }

    // C. Invalid Business Hours (Chronology check)
    try {
      await axios.post(`${BASE_URL}/projects/${projectId}/business-hours`, {
        day_of_week: 1,
        start_time: "17:00",
        end_time: "09:00",
        timezone: "Asia/Bangkok"
      }, authHeaders);
      console.error("❌ Test Failed: Chronologically invalid business hours did not throw 400");
    } catch (err: any) {
      if (err.response && err.response.status === 400) {
        console.log("✅ Success: Chronologically invalid business hours rejected correctly:", err.response.data.message);
      } else {
        console.error("❌ Test Failed: Invalid business hours returned status", err.response?.status);
      }
    }

    // D. Invalid Feature Flags Payload
    try {
      await axios.post(`${BASE_URL}/projects/${projectId}/settings`, {
        featureFlags: {
          enable_auto_escalation: "NOT_A_BOOLEAN"
        }
      }, authHeaders);
      console.error("❌ Test Failed: Invalid feature flag payload did not throw 400");
    } catch (err: any) {
      if (err.response && err.response.status === 400) {
        console.log("✅ Success: Invalid feature flag payload rejected correctly:", err.response.data.message);
      } else {
        console.error("❌ Test Failed: Invalid feature flag payload returned status", err.response?.status);
      }
    }

    // E. Malformed AI Settings (Confidence Threshold > 1.0)
    try {
      await axios.post(`${BASE_URL}/projects/${projectId}/settings`, {
        aiSettings: {
          confidenceThreshold: 1.5
        }
      }, authHeaders);
      console.error("❌ Test Failed: Malformed AI settings did not throw 400");
    } catch (err: any) {
      if (err.response && err.response.status === 400) {
        console.log("✅ Success: Malformed AI settings rejected correctly:", err.response.data.message);
      } else {
        console.error("❌ Test Failed: Malformed AI settings returned status", err.response?.status);
      }
    }

    // 4. Test Transactional Integrity (Expect partial updates not to commit on failure)
    console.log("\n--- Testing Transactional Integrity ---");
    const initialPromptRes = await axios.get(`${BASE_URL}/projects/${projectId}/settings`, authHeaders);
    const initialSystemInstruction = initialPromptRes.data.prompt?.system_instruction || "";

    try {
      await axios.post(`${BASE_URL}/projects/${projectId}/settings`, {
        prompt: {
          systemInstruction: "THIS PROMPT SHOULD NEVER BE SAVED"
        },
        featureFlags: {
          enable_auto_escalation: "NOT_A_BOOLEAN" // will fail validation
        }
      }, authHeaders);
      console.error("❌ Test Failed: Malformed payload did not reject");
    } catch (err: any) {
      // Verify that the prompt was NOT updated in the database
      const verifyPromptRes = await axios.get(`${BASE_URL}/projects/${projectId}/settings`, authHeaders);
      const currentPromptText = verifyPromptRes.data.prompt?.system_instruction || "";
      if (currentPromptText === initialSystemInstruction) {
        console.log("✅ Success: Transaction rolled back successfully, no partial updates committed.");
      } else {
        console.error("❌ Test Failed: Partial update occurred! Prompt was saved despite error:", currentPromptText);
      }
    }

    // 5. Test Audit Logging
    console.log("\n--- Testing Audit Logging ---");
    const testActor = "cto-auditor";
    await axios.post(
      `${BASE_URL}/projects/${projectId}/settings`,
      {
        prompt: {
          systemInstruction: "Modified System Prompt for Audit Test",
          modelName: "gemini-1.5-pro",
          temperature: 0.1
        }
      },
      {
        headers: {
          "Authorization": "Bearer test-api-key",
          "x-actor": testActor
        }
      }
    );

    const auditLogsRes = await pool.query(
      "SELECT * FROM admin_audit_logs WHERE actor = $1 ORDER BY id DESC LIMIT 1",
      [testActor]
    );
    if (auditLogsRes.rows.length > 0) {
      const log = auditLogsRes.rows[0];
      console.log("✅ Success: Audit log generated!");
      console.log(`  Actor: ${log.actor}`);
      console.log(`  Action: ${log.action}`);
      console.log(`  Timestamp: ${log.timestamp}`);
      console.log(`  Old Value Prompt:`, log.old_value?.prompt?.system_instruction);
      console.log(`  New Value Prompt:`, log.new_value?.prompt?.systemInstruction);
    } else {
      console.error("❌ Test Failed: No audit log generated for update action.");
    }

    // 6. Test Cache Invalidation and Reload Behavior
    console.log("\n--- Testing Cache Eviction ---");
    const configLoader = ConfigLoaderService.getInstance();
    const cachedPrompt1 = await configLoader.getPromptConfig(projectId);
    console.log(`  Initial Cache Primed Prompt: "${cachedPrompt1.systemInstruction}"`);

    // Update prompt via API
    const updatedPromptText = "New Cache Evicted Prompt " + Date.now();
    await axios.post(`${BASE_URL}/projects/${projectId}/settings`, {
      prompt: {
        systemInstruction: updatedPromptText
      }
    }, authHeaders);

    // Fetch immediately via ConfigLoaderService (should load fresh from DB since cache was invalidated)
    const cachedPrompt2 = await configLoader.getPromptConfig(projectId);
    if (cachedPrompt2.systemInstruction === updatedPromptText) {
      console.log("✅ Success: Cache eviction worked correctly. Subsequent ConfigLoader read returned fresh value:", cachedPrompt2.systemInstruction);
    } else {
      console.error("❌ Test Failed: ConfigLoader returned stale value:", cachedPrompt2.systemInstruction);
    }

    // 7. Security (Expect 401 Unauthorized for invalid/missing token)
    console.log("\n--- Testing Security / Authentication ---");
    try {
      await axios.get(`${BASE_URL}/projects/${projectId}/settings`);
      console.error("❌ Test Failed: Request without token did not throw 401");
    } catch (err: any) {
      if (err.response && err.response.status === 401) {
        console.log("✅ Success: Request without token rejected with 401.");
      } else {
        console.error("❌ Test Failed: Request without token returned status", err.response?.status);
      }
    }

    try {
      await axios.get(`${BASE_URL}/projects/${projectId}/settings`, {
        headers: { "Authorization": "Bearer WRONG-KEY" }
      });
      console.error("❌ Test Failed: Request with wrong token did not throw 401");
    } catch (err: any) {
      if (err.response && err.response.status === 401) {
        console.log("✅ Success: Request with wrong token rejected with 401.");
      } else {
        console.error("❌ Test Failed: Request with wrong token returned status", err.response?.status);
      }
    }

  } finally {
    // 8. Clean up and close fastify server
    console.log("\nShutting down test server...");
    await fastify.close();
    console.log("Test server stopped.");
  }

  console.log("\n=== All Settings Verification Tests Completed ===");
  process.exit(0);
}

runTests().catch(err => {
  console.error("Fatal Test Error:", err);
  process.exit(1);
});
