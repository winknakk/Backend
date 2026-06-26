import { runWithContext, startSpan } from "./observability/tracer";
import { tracerStore } from "./observability/tracerStore";
import { randomUUID } from "crypto";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    Testing Distributed Tracing (OTel)");
  console.log("=========================================");

  const traceId = randomUUID();
  const requestId = randomUUID();
  const conversationId = "test-conv-tracing";

  // 1. Verify context propagation in runWithContext
  console.log("Testing context propagation in runWithContext...");
  let insideContext = false;

  await runWithContext({ traceId, requestId, conversationId }, async () => {
    const store = tracerStore.getStore();
    assert(store !== undefined, "Store context should be active");
    assert(store!.traceId === traceId, `traceId should match, expected ${traceId} got ${store?.traceId}`);
    assert(store!.requestId === requestId, "requestId should match");
    assert(store!.conversationId === conversationId, "conversationId should match");
    insideContext = true;
  });

  assert(insideContext, "Context block must have run");
  assert(tracerStore.getStore() === undefined, "Store context should be clean after runWithContext");

  // 2. Verify startSpan sets and maintains context
  console.log("Testing context propagation in startSpan...");
  let insideSpan = false;

  await startSpan(
    "TestSpan",
    async () => {
      const store = tracerStore.getStore();
      assert(store !== undefined, "Store context should be active inside span");
      assert(store!.traceId === traceId, "traceId should match");
      assert(store!.requestId === requestId, "requestId should match");
      assert(store!.conversationId === conversationId, "conversationId should match");
      assert(store!.spanName === "TestSpan", "Span name should be populated in context");
      insideSpan = true;
    },
    { traceId, requestId, conversationId }
  );

  assert(insideSpan, "Span block must have run");
  assert(tracerStore.getStore() === undefined, "Store context should be clean after span");

  console.log("✅ Distributed Tracing (OTel) tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
