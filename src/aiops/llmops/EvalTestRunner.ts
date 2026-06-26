import { DatabaseAdapter } from "../../adapters/types";
import { AgentManager } from "../../agent/AgentRuntime";
import { EvalTestCase, EvalResult } from "../../schemas/aiops";
import { InboundMessage } from "../../schemas/validation";
import { randomUUID } from "crypto";

export class EvalTestRunner {
  private agentManager: AgentManager;
  private dbAdapter: DatabaseAdapter;

  constructor(agentManager: AgentManager, dbAdapter: DatabaseAdapter) {
    this.agentManager = agentManager;
    this.dbAdapter = dbAdapter;
  }

  /**
   * Runs a suite of evaluation test cases for a given tenant.
   */
  async runSuite(testCases: EvalTestCase[], tenantId: string): Promise<EvalResult[]> {
    const results: EvalResult[] = [];

    for (const tc of testCases) {
      try {
        const testUser = `eval_user_${tc.testCaseId}_${randomUUID().substring(0, 8)}`;
        const conversationId = await this.dbAdapter.ensureConversation(testUser, tenantId, "LINE");
        const sessionId = `sess_${conversationId}`;

        // Get/Create session
        const session = await this.agentManager.getOrCreateSession(testUser, tenantId);

        const message: InboundMessage = {
          senderId: testUser,
          channel: "LINE",
          text: tc.inputMessage,
          receivedAt: new Date().toISOString(),
        };

        // Run chat
        await session.chat(message);

        // Fetch traces for this session to evaluate behavior
        const traces = await this.dbAdapter.listTraces(sessionId);

        // Filter out handoff traces and get actual tool calls
        const actualToolCalls = traces
          .filter((t) => t.status !== "HANDOFF" && !t.toolName.startsWith("handoff_to_"))
          .map((t) => t.toolName);

        // Determine actual agent
        // Default to "support" if no agent trace is found
        let actualAgentId = "support";

        // If there are tool calls, the agent who called them is the actual agent
        const lastToolTrace = traces
          .filter((t) => t.status !== "HANDOFF" && !t.toolName.startsWith("handoff_to_"))
          .sort((a, b) => new Date(a.calledAt).getTime() - new Date(b.calledAt).getTime())
          .pop();

        if (lastToolTrace && lastToolTrace.agentId) {
          actualAgentId = lastToolTrace.agentId;
        } else {
          // If no tool was called but there was a handoff trace, the destination is the actual agent
          const lastHandoffTrace = traces
            .filter((t) => t.status === "HANDOFF" || t.toolName.startsWith("handoff_to_"))
            .sort((a, b) => new Date(a.calledAt).getTime() - new Date(b.calledAt).getTime())
            .pop();

          if (lastHandoffTrace) {
            const toAgent =
              lastHandoffTrace.arguments?.toAgentId || lastHandoffTrace.toolName.replace("handoff_to_", "");
            if (toAgent) {
              actualAgentId = toAgent;
            }
          }
        }

        // Calculate accuracy score
        let accuracyScore = 0;
        let success = false;

        if (actualAgentId === tc.expectedAgentId) {
          const expectedTools = tc.expectedToolCalls || [];
          if (expectedTools.length === 0) {
            accuracyScore = 1.0;
            success = true;
          } else {
            // Calculate overlap
            const matchedTools = expectedTools.filter((t) => actualToolCalls.includes(t));
            accuracyScore = matchedTools.length / expectedTools.length;
            success = accuracyScore === 1.0 && actualToolCalls.length === expectedTools.length;
          }
        }

        results.push({
          testCaseId: tc.testCaseId,
          actualAgentId,
          actualToolCalls,
          success,
          accuracyScore,
        });
      } catch (err: any) {
        results.push({
          testCaseId: tc.testCaseId,
          actualAgentId: "error",
          actualToolCalls: [],
          success: false,
          accuracyScore: 0,
          error: err.message || String(err),
        });
      }
    }

    return results;
  }
}
