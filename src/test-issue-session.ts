import { IssueSessionBuilder } from "./runtime/IssueSessionBuilder";
import { LifecycleState, ConversationState } from "./runtime/IssueSession";
import { RuntimeContext } from "./services/RuntimeContextResolver";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

function runTests() {
  console.log("=========================================");
  console.log("    IssueSession v2 State Machine Tests  ");
  console.log("=========================================\n");

  const mockContext: RuntimeContext = {
    conversationId: 999,
    identityId: 999,
    projectId: 8,
    handledBy: "ai",
    channel: "LINE"
  };

  const mockConv: ConversationState = {
    id: 999,
    status: "open",
    handledBy: "ai",
    channel: "LINE"
  };

  // Test 1: Fluent Builder instantiation
  console.log("Test 1: Builder compiles successfully...");
  const session = new IssueSessionBuilder()
    .withContext(mockContext)
    .withConversation(mockConv)
    .build();

  assert(session.sessionId !== undefined, "Session ID should be generated");
  assert(session.state === LifecycleState.BOOTSTRAPPING, "Initial state should be BOOTSTRAPPING");
  assert(session.context.projectId === 8, "Project ID should map correctly");
  assert(session.conversation.status === "open", "Conversation status should map correctly");
  console.log("✅ Passed!");

  // Test 2: Builder validation throws on missing context
  console.log("Test 2: Builder validation checks...");
  try {
    new IssueSessionBuilder().withConversation(mockConv).build();
    assert(false, "Should throw error on missing context");
  } catch (err: any) {
    assert(err.message.includes("RuntimeContext"), "Error should mention RuntimeContext");
  }
  console.log("✅ Passed!");

  // Test 3: State transition validation (legal paths)
  console.log("Test 3: Valid state transitions...");
  session.transitionTo(LifecycleState.HYDRATING);
  assert(session.state === LifecycleState.HYDRATING, "State should transition to HYDRATING");
  
  session.transitionTo(LifecycleState.READY);
  assert(session.state === LifecycleState.READY, "State should transition to READY");
  
  session.transitionTo(LifecycleState.PROCESSING);
  assert(session.state === LifecycleState.PROCESSING, "State should transition to PROCESSING");
  
  session.transitionTo(LifecycleState.WAITING_TOOL);
  assert(session.state === LifecycleState.WAITING_TOOL, "State should transition to WAITING_TOOL");
  
  session.transitionTo(LifecycleState.PROCESSING);
  assert(session.state === LifecycleState.PROCESSING, "State should transition to PROCESSING");
  
  session.transitionTo(LifecycleState.RESPONDING);
  assert(session.state === LifecycleState.RESPONDING, "State should transition to RESPONDING");
  
  session.transitionTo(LifecycleState.COMPLETED);
  assert(session.state === LifecycleState.COMPLETED, "State should transition to COMPLETED");
  
  session.transitionTo(LifecycleState.DESTROYED);
  assert(session.state === LifecycleState.DESTROYED, "State should transition to DESTROYED");
  console.log("✅ Passed!");

  // Test 4: State transition validation (illegal transitions)
  console.log("Test 4: Illegal state transition prevention...");
  const session2 = new IssueSessionBuilder()
    .withContext(mockContext)
    .withConversation(mockConv)
    .build();

  try {
    session2.transitionTo(LifecycleState.COMPLETED);
    assert(false, "Should prevent illegal transitions");
  } catch (err: any) {
    assert(err.message.includes("Invalid lifecycle state transition"), "Error should explain invalid transition");
  }
  console.log("✅ Passed!");

  // Test 5: Memento snapshotting and rollback
  console.log("Test 5: Snapshot and rollback (Memento pattern)...");
  const session3 = new IssueSessionBuilder()
    .withContext(mockContext)
    .withConversation(mockConv)
    .build();
  
  session3.transitionTo(LifecycleState.HYDRATING);
  const snapshot = session3.takeSnapshot();

  session3.transitionTo(LifecycleState.READY);
  session3.conversation.status = "resolved";

  session3.restoreSnapshot(snapshot);
  assert(session3.state === LifecycleState.HYDRATING, "State should roll back to HYDRATING");
  assert((session3.conversation.status as any) === "open", "Conversation status should roll back to open");
  console.log("✅ Passed!");

  // Test 6: Runtime flags permission check
  console.log("Test 6: Runtime permission context checks...");
  const session4 = new IssueSessionBuilder()
    .withContext(mockContext)
    .withConversation(mockConv)
    .withFlags({ allowToolExecution: false })
    .build();

  assert(session4.canExecuteTool("test_tool") === false, "Tool execution should be denied if flags block it");

  const session5 = new IssueSessionBuilder()
    .withContext(mockContext)
    .withConversation(mockConv)
    .withFlags({ allowToolExecution: true })
    .build();

  assert(session5.canExecuteTool("test_tool") === false, "Tool execution should be denied if state is not PROCESSING");
  session5.transitionTo(LifecycleState.HYDRATING);
  session5.transitionTo(LifecycleState.READY);
  session5.transitionTo(LifecycleState.PROCESSING);
  assert(session5.canExecuteTool("test_tool") === true, "Tool execution should be allowed in PROCESSING state with active permissions");
  console.log("✅ Passed!");

  console.log("\nAll IssueSession v2 tests passed successfully!");
}

runTests();
