import axios from "axios";
import { MetricsService } from "./observability/MetricsService";
import { CacheService } from "./cache/CacheService";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    Testing Prometheus Metrics Exporter");
  console.log("=========================================");

  const port = 3009;
  const baseUrl = `http://localhost:${port}`;

  // Configure environment variables
  process.env.API_KEY = "test-api-key";
  process.env.WEBHOOK_SECRET = "test-webhook-secret";

  // Import after setting env vars
  const { fastify, bootstrap } = await import("./api/server");

  // Record some mock metrics
  console.log("Recording mock metrics...");
  const metrics = MetricsService.getInstance();
  metrics.recordRequest();
  metrics.recordRequest();
  metrics.recordError();
  metrics.recordLatency(120);
  metrics.recordLatency(240);
  metrics.recordAgentCall("support");
  metrics.recordToolCall("create_ticket");
  metrics.recordRoutingDecision("handoff_to_human");

  // Record cache hits/misses
  const cache = CacheService.getInstance();
  await cache.get("tenant:project_1:config");
  await cache.set("tenant:project_1:config", { active: true }, 60);
  await cache.get("tenant:project_1:config");

  await bootstrap();
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`[Test Server] Running at ${baseUrl}`);

  try {
    console.log("Fetching /metrics/prometheus...");
    const res = await axios.get(`${baseUrl}/metrics/prometheus`);
    assert(res.status === 200, "Response status should be 200");
    assert(String(res.headers["content-type"])?.includes("text/plain"), "Content-Type must be text/plain");

    const text = res.data;
    console.log("\n--- Prometheus Response ---\n", text, "\n---------------------------\n");

    // Assert key Prometheus metrics are present
    assert(text.includes("automationx_requests_total 2"), "Should report requestCount correctly");
    assert(text.includes("automationx_errors_total 1"), "Should report errors correctly");
    assert(text.includes("automationx_request_latency_seconds_sum 0.36"), "Should report latency sum in seconds");
    assert(text.includes("automationx_request_latency_seconds_count 2"), "Should report latency count correctly");
    assert(text.includes('automationx_agent_calls_total{agent="support"} 1'), "Should report agent calls correctly");
    assert(text.includes('automationx_tool_calls_total{tool="create_ticket"} 1'), "Should report tool calls correctly");
    assert(text.includes('automationx_routing_decisions_total{decision="handoff_to_human"} 1'), "Should report routing decisions correctly");
    assert(text.includes('automationx_cache_hits_total{tenant="project_1"} 1'), "Should report cache hits");
    assert(text.includes('automationx_cache_misses_total{tenant="project_1"} 1'), "Should report cache misses");
    assert(text.includes("automationx_queue_depth 0"), "Should report queue depth");

    console.log("✅ Prometheus Metrics Exporter tests PASSED successfully!");
  } catch (err: any) {
    console.error("Test failed:", err.message);
    process.exit(1);
  } finally {
    await fastify.close();
    await cache.disconnect();
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
