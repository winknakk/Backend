import { MetricAggregator } from "./aiops/dashboard/MetricAggregator";
import { LocalDataAdapter } from "./adapters/local-data/LocalDataAdapter";
import { AuditLog } from "./schemas/validation";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("   AutomationX V2 AIOps Dashboard Tests  ");
  console.log("=========================================");

  const dataDir = path.resolve(__dirname, "../data");
  if (fs.existsSync(dataDir)) {
    const files = fs.readdirSync(dataDir);
    files.forEach((f) => {
      if (f.includes("Test_Corp") || f.includes("test_dashboard_db")) {
        try {
          fs.unlinkSync(path.join(dataDir, f));
        } catch {}
      }
    });
  }

  const adapter = new LocalDataAdapter();

  const cleanDb = () => {
    const files = fs.readdirSync(dataDir);

    // 1. Clean Identities & get identityId
    const identFile = files.find((f) => f.includes("Identities") && f.endsWith(".json"));
    let identityId = "";
    if (identFile) {
      const p = path.join(dataDir, identFile);
      const list = JSON.parse(fs.readFileSync(p, "utf-8"));
      const match = list.find((id: any) => id.channel_ref === "test_user_dashboard_123");
      if (match) {
        identityId = match.id1;
      }
      const filtered = list.filter((id: any) => id.channel_ref !== "test_user_dashboard_123");
      fs.writeFileSync(p, JSON.stringify(filtered, null, 2), "utf-8");
    }

    // 2. Clean Conversations & get conversationIds
    const convFile = files.find((f) => f.includes("Conversations") && f.endsWith(".json"));
    const deletedConvIds = new Set<string>();
    if (convFile) {
      const p = path.join(dataDir, convFile);
      const list = JSON.parse(fs.readFileSync(p, "utf-8"));
      list.forEach((c: any) => {
        if (c.identity_id === identityId || c.identity === identityId || c.id1 === "16") {
          deletedConvIds.add(c.id1);
        }
      });
      const filtered = list.filter((c: any) => !deletedConvIds.has(c.id1));
      fs.writeFileSync(p, JSON.stringify(filtered, null, 2), "utf-8");
    }

    // 3. Clean Traces
    const traceFile = files.find((f) => f.includes("Traces") && f.endsWith(".json"));
    if (traceFile) {
      const p = path.join(dataDir, traceFile);
      const list = JSON.parse(fs.readFileSync(p, "utf-8"));
      const filtered = list.filter(
        (t: any) =>
          !deletedConvIds.has(t.conversationId || "") &&
          !t.sessionId?.includes("sess_16") &&
          !t.conversationId?.includes("conv_1")
      );
      fs.writeFileSync(p, JSON.stringify(filtered, null, 2), "utf-8");
    }

    // 4. Clean Tickets
    const tktFile = files.find((f) => f.includes("Tickets") && f.endsWith(".json"));
    if (tktFile) {
      const p = path.join(dataDir, tktFile);
      const list = JSON.parse(fs.readFileSync(p, "utf-8"));
      const filtered = list.filter(
        (t: any) =>
          !deletedConvIds.has(t.conversation_id || "") &&
          !deletedConvIds.has(t.conversation || "") &&
          t.conversation_id !== "16"
      );
      fs.writeFileSync(p, JSON.stringify(filtered, null, 2), "utf-8");
    }
  };

  cleanDb();

  const conversationId = await adapter.ensureConversation("test_user_dashboard_123", "1", "LINE");
  const sessionId = `sess_${conversationId}`;

  const trace1: AuditLog = {
    traceId: randomUUID(),
    sessionId,
    agentId: "supervisor",
    toolName: "handoff_to_knowledge",
    calledAt: new Date(Date.now() - 10000).toISOString(),
    status: "HANDOFF",
    arguments: { toAgentId: "knowledge" },
    conversationId,
  };

  const trace2: AuditLog = {
    traceId: randomUUID(),
    sessionId,
    agentId: "knowledge",
    toolName: "search_project_docs",
    calledAt: new Date(Date.now() - 5000).toISOString(),
    status: "COMPLETED",
    completedAt: new Date(Date.now() - 3000).toISOString(),
    arguments: { query: "sso" },
    conversationId,
  };

  await adapter.saveTrace(trace1);
  await adapter.saveTrace(trace2);

  console.log("All Traces in DB:", await adapter.listAllTraces());
  console.log("Conversation mapped:", await adapter.getConversation(conversationId));

  await adapter.createTicket(
    {
      conversationId,
      subject: "SSO Expired",
      summary: "User SSO expired",
      severity: "High",
      priority: "P2",
      projectId: "p1",
    },
    new Date(Date.now() - 5000).toISOString(),
    "TCK-DASH-001"
  );

  const aggregator = new MetricAggregator(adapter);

  const metrics = await aggregator.getDashboardMetrics("1");
  console.log("Calculated metrics:", metrics);

  assert(metrics.totalTraces >= 2, "Expected at least 2 traces.");
  assert(metrics.completedTraces >= 1, "Expected at least 1 completed trace.");
  assert(metrics.slaViolations >= 1, "Expected at least 1 SLA violation.");
  assert(metrics.agentRoutingDistribution.supervisor >= 1, "Expected supervisor routing trace.");

  const summaries = await aggregator.getConversationTraceSummaries("1");
  const mySummary = summaries.find((s) => s.conversationId === conversationId);

  assert(mySummary !== undefined, "Expected to find trace summary for our conversation.");
  assert(mySummary!.handoffChain.length === 1, "Expected handoff chain to have 1 hop.");
  assert(mySummary!.handoffChain[0].agentId === "knowledge", "Expected handoff destination to be knowledge.");
  assert(mySummary!.slaViolated === true, "Expected SLA to be violated.");

  cleanDb();

  console.log("\n✅ All AIOps Dashboard tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
