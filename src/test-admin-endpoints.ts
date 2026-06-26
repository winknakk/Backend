import axios from "axios";

async function runAdminEndpointsTests() {
  console.log("=========================================");
  console.log("  AutomationX V2 Admin Endpoints Tests   ");
  console.log("=========================================\n");

  const port = 3003;
  const baseUrl = `http://localhost:${port}`;

  // Configure environment variables
  process.env.API_KEY = "admin-secret-token-456";
  process.env.WEBHOOK_SECRET = "webhook-key-456";
  process.env.RATE_LIMIT_MAX = "100";
  process.env.RATE_LIMIT_WINDOW_MS = "60000";

  // Dynamic import of the server
  const { fastify, bootstrap } = await import("./api/server");

  await bootstrap();
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`[Test Server] Running at ${baseUrl}`);

  try {
    const authHeaders = { Authorization: `Bearer ${process.env.API_KEY}` };

    // ─── TEST 1: Authentication block on Admin routes ─────────
    console.log("\n--- Test 1: Authentication verification ---");
    const adminRoutes = ["/metrics", "/traces", "/tools", "/agents"];

    for (const route of adminRoutes) {
      console.log(`Checking ${route} blocked without token...`);
      try {
        await axios.get(`${baseUrl}${route}`);
        throw new Error(`Route ${route} should have failed without Bearer token`);
      } catch (err: any) {
        console.log(`- ${route} missing token response: ${err.response?.status} (Expected: 401)`);
        if (err.response?.status !== 401) throw new Error(`Failed auth check for ${route}`);
      }

      console.log(`Checking ${route} blocked with invalid token...`);
      try {
        await axios.get(`${baseUrl}${route}`, { headers: { Authorization: "Bearer wrong-token" } });
        throw new Error(`Route ${route} should have failed with invalid Bearer token`);
      } catch (err: any) {
        console.log(`- ${route} invalid token response: ${err.response?.status} (Expected: 401)`);
        if (err.response?.status !== 401) throw new Error(`Failed auth check for ${route}`);
      }
    }

    // ─── TEST 2: GET /tools ──────────────────────────────────
    console.log("\n--- Test 2: GET /tools ---");
    const toolsRes = await axios.get(`${baseUrl}/tools`, { headers: authHeaders });
    console.log(`- Status: ${toolsRes.status} (Expected: 200)`);
    console.log("- Tools count:", toolsRes.data.length);
    if (!Array.isArray(toolsRes.data) || toolsRes.data.length === 0) {
      throw new Error("Tools endpoint returned empty or non-array data");
    }
    console.log(
      "- Tools list:",
      toolsRes.data.map((t: any) => t.name)
    );

    // ─── TEST 3: GET /agents ─────────────────────────────────
    console.log("\n--- Test 3: GET /agents ---");
    const agentsRes = await axios.get(`${baseUrl}/agents`, { headers: authHeaders });
    console.log(`- Status: ${agentsRes.status} (Expected: 200)`);
    console.log("- Agents count:", agentsRes.data.length);
    if (!Array.isArray(agentsRes.data) || agentsRes.data.length === 0) {
      throw new Error("Agents endpoint returned empty or non-array data");
    }
    console.log("- Agents list:", agentsRes.data);

    // ─── TEST 4: GET /traces ─────────────────────────────────
    console.log("\n--- Test 4: GET /traces ---");
    const tracesRes = await axios.get(`${baseUrl}/traces`, { headers: authHeaders });
    console.log(`- Status: ${tracesRes.status} (Expected: 200)`);
    if (!Array.isArray(tracesRes.data)) {
      throw new Error("Traces endpoint returned non-array data");
    }
    console.log("- Traces found:", tracesRes.data.length);

    // ─── TEST 5: GET /metrics ────────────────────────────────
    console.log("\n--- Test 5: GET /metrics ---");
    const metricsRes = await axios.get(`${baseUrl}/metrics`, { headers: authHeaders });
    console.log(`- Status: ${metricsRes.status} (Expected: 200)`);
    console.log("- Metrics body:", JSON.stringify(metricsRes.data, null, 2));

    const metrics = metricsRes.data;
    if (typeof metrics.requestCount !== "number" || typeof metrics.errors !== "number" || !metrics.latency) {
      throw new Error("Metrics endpoint returned incorrect structure");
    }

    console.log("\n✅ All Admin API Endpoints Tests PASSED successfully!");
  } catch (err: any) {
    console.error("\n❌ Admin Endpoints Test FAILED:");
    console.error(err.message);
    if (err.response) {
      console.error("Response status:", err.response.status);
      console.error("Response data:", err.response.data);
    }
    process.exit(1);
  } finally {
    console.log("\nClosing test server...");
    await fastify.close();
    console.log("Test server closed.");
  }
}

runAdminEndpointsTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
