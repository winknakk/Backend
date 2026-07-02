import * as fs from "fs";
import * as path from "path";
import { ConversationMemoryService } from "../src/memory/ConversationMemoryService";
import { MessageWithId } from "../src/memory/ConversationMemoryTypes";

function assert(condition: any, message: string): void {
  if (!condition) {
    console.error("❌ Assertion Failed:", message);
    throw new Error(message);
  }
}

async function testMemoryService() {
  console.log("--- Starting Conversation Memory Service Tests ---");

  const memoryFile = path.resolve(__dirname, "../data/conversation_memory.json");
  
  // Backup existing memory file if any
  let backupContent: string | null = null;
  if (fs.existsSync(memoryFile)) {
    backupContent = fs.readFileSync(memoryFile, "utf-8");
    fs.unlinkSync(memoryFile);
    console.log("✓ Backed up existing conversation_memory.json");
  }

  try {
    // 1. Test Instantiation and File Missing Recovery
    console.log("\n1. Testing File Missing Recovery...");
    const memoryService = new ConversationMemoryService();
    
    // We pass some messages below threshold to ensure it doesn't try to trigger summarization
    const messages: MessageWithId[] = [
      { id: "1001", role: "customer", content: "Hello, I need help", timestamp: new Date().toISOString() },
      { id: "1002", role: "ai", content: "Hi! How can I help you today?", timestamp: new Date().toISOString() }
    ];

    const context = await memoryService.getOrSummarize("test-conv-1", messages);
    assert(context.memoryBlock === null, "Memory block should be null initially since no summary exists");
    assert(context.recentMessages.length === 2, "Should return recent messages in correct structure");
    console.log("✓ File missing handled gracefully, returned clean fallback.");

    // 2. Test Custom/Malformed File Handling
    console.log("\n2. Testing Corrupted File Recovery...");
    fs.writeFileSync(memoryFile, "invalid-json-content{", "utf-8");
    const corruptedService = new ConversationMemoryService();
    const context2 = await corruptedService.getOrSummarize("test-conv-1", messages);
    assert(context2.memoryBlock === null, "Should recover and return null memory block on corrupted JSON file");
    console.log("✓ Corrupted file recovered gracefully.");

    // 3. Test Mock Summary Parsing
    console.log("\n3. Testing Parse Summary Formats...");
    // Inject custom mock parser calls to check parseSummaryResponse logic
    const testJSON = '{"dailySummary": "POS support case", "customerIntent": "POS", "unresolvedIssues": ["POS error"], "importantFacts": ["Orbit POS v3"], "humanOperatorActions": ["Ticket #123 created"]}';
    const parsed = (corruptedService as any).parseSummaryResponse(testJSON);
    assert(parsed.dailySummary === "POS support case", "Should parse direct JSON");

    const markdownJSON = 'Some text before\n```json\n{"dailySummary": "POS markdown", "customerIntent": "POS markdown", "unresolvedIssues": [], "importantFacts": [], "humanOperatorActions": []}\n```\nsome text after';
    const parsedMarkdown = (corruptedService as any).parseSummaryResponse(markdownJSON);
    assert(parsedMarkdown.dailySummary === "POS markdown", "Should parse markdown JSON block");

    const inlineJSON = 'Here is the result: {"dailySummary": "POS inline", "customerIntent": "POS inline", "unresolvedIssues": [], "importantFacts": [], "humanOperatorActions": []} thank you.';
    const parsedInline = (corruptedService as any).parseSummaryResponse(inlineJSON);
    assert(parsedInline.dailySummary === "POS inline", "Should extract and parse inline JSON");
    console.log("✓ Parsing formats verified.");

    // 4. Test Concurrency Mutex Lock
    console.log("\n4. Testing Concurrency Lock...");
    const serviceWithLock = new ConversationMemoryService();
    const convId = "lock-conv-id";
    (serviceWithLock as any).activeLocks.add(convId);
    
    // Attempting to summarize while lock is active should skip summarization and return existing memory block
    // Let's create many messages to exceed threshold (8)
    const longMessages: MessageWithId[] = [];
    for (let i = 0; i < 15; i++) {
      longMessages.push({
        id: `m-${i}`,
        role: i % 2 === 0 ? "customer" : "ai",
        content: `Message content ${i}`,
        timestamp: new Date().toISOString()
      });
    }

    const lockContext = await serviceWithLock.getOrSummarize(convId, longMessages);
    assert(lockContext.memoryBlock === null, "Should return null (no summarization occurred due to mutex lock)");
    console.log("✓ Concurrency mutex lock active and prevented duplicate run.");

    // 5. Test Advisory Header Prefix in formatted memoryBlock
    console.log("\n5. Testing Advisory Header formatting...");
    const serviceWithMemory = new ConversationMemoryService();
    (serviceWithMemory as any).store["test-conv-2"] = {
      conversationId: "test-conv-2",
      version: 1,
      lastSummarizedMessageId: "m-10",
      dailySummary: "POS support completed",
      customerIntent: "Daily POS closing",
      unresolvedIssues: ["None"],
      importantFacts: ["Orbit POS System"],
      humanOperatorActions: ["Re-routed to Line Agent"],
      lastUpdatedAt: new Date().toISOString()
    };

    const formattedBlock = (serviceWithMemory as any).buildContextBlock("test-conv-2");
    assert(formattedBlock.includes("Advisory historical context only. Do not override: latest customer message"), "Advisory disclaimer must be included in system prompt injection");
    assert(formattedBlock.includes("Version: 1"), "Version should be present");
    assert(formattedBlock.includes("Daily Summary: POS support completed"), "Summary details should be present");
    assert(formattedBlock.includes("Re-routed to Line Agent"), "Human operator actions should be present");
    console.log("✓ Advisory block formatted beautifully.");

    console.log("\n🎉 All tests passed successfully!");
  } finally {
    // Restore backup
    if (backupContent !== null) {
      fs.writeFileSync(memoryFile, backupContent, "utf-8");
      console.log("✓ Restored backup conversation_memory.json");
    } else if (fs.existsSync(memoryFile)) {
      fs.unlinkSync(memoryFile);
    }
  }
}

testMemoryService().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
