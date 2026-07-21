import { IssueSessionBuilder } from "./runtime/IssueSessionBuilder";
import { IssueSessionResolver } from "./runtime/IssueSessionResolver";
import { RuntimeContext } from "./services/RuntimeContextResolver";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

const mockContextA: RuntimeContext = {
  conversationId: 100,
  identityId: 10,
  projectId: 1,
  handledBy: "ai",
  channel: "LINE"
};

const mockContextB: RuntimeContext = {
  conversationId: 200,
  identityId: 20,
  projectId: 2,
  handledBy: "human",
  channel: "LINE"
};

async function simulateRequest(context: RuntimeContext, label: string) {
  const session = new IssueSessionBuilder()
    .withSessionId(`req-${context.conversationId}`)
    .withContext(context)
    .withConversation({
      id: context.conversationId,
      status: "open",
      handledBy: context.handledBy as any,
      channel: context.channel
    })
    .build();

  return await IssueSessionResolver.run(session, async () => {
    assert(IssueSessionResolver.current() === session, `${label}: Initial context mismatch`);
    
    // Simulate multiple nested async delays to verify preservation of store references
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 50) + 10));
    assert(IssueSessionResolver.current() === session, `${label}: Context leaked after first await`);
    
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 50) + 10));
    assert(IssueSessionResolver.current() === session, `${label}: Context leaked after second await`);
    
    return session.context.conversationId;
  });
}

async function runTests() {
  console.log("=========================================");
  console.log("  IssueSession v2 AsyncLocalStorage Tests");
  console.log("=========================================\n");

  console.log("Test 1: Running parallel request loops...");
  
  // Launch 100 concurrent requests with mixed contexts
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(simulateRequest(mockContextA, `Thread A-${i}`));
    promises.push(simulateRequest(mockContextB, `Thread B-${i}`));
  }

  const results = await Promise.all(promises);
  assert(results.length === 100, "Should complete 100 requests");
  
  // Verify that all returned values are correct
  let countA = 0;
  let countB = 0;
  for (const id of results) {
    if (id === 100) countA++;
    else if (id === 200) countB++;
    else throw new Error(`Unexpected conversation ID returned: ${id}`);
  }

  assert(countA === 50, "Thread A count should be 50");
  assert(countB === 50, "Thread B count should be 50");

  console.log("✅ Passed! Implicit context is perfectly isolated across 100 concurrent async threads.");
  console.log("\nAll AsyncLocalStorage propagation tests passed successfully!");
}

runTests().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
