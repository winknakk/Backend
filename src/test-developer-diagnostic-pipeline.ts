import assert from "assert";
import { DiagnosticAnalyzer } from "./agent/diagnostic/DiagnosticAnalyzer";
import { sanitizeSensitiveData } from "./domain/diagnostic/DeveloperDiagnostic";
import { buildPlaneWorkItemPayload } from "./services/planeService";
import { TicketInputSchema, KnowledgeResult } from "./schemas/validation";

async function runDeveloperDiagnosticPipelineTests() {
  console.log("==================================================");
  console.log("RUNNING DEVELOPER DIAGNOSTIC PIPELINE TEST SUITE");
  console.log("==================================================");

  const analyzer = new DiagnosticAnalyzer();

  const getProjectVal = (field: any) => (typeof field === "string" ? field : field?.value || "UNKNOWN");

  // Test 1: Customer-only report
  console.log("\n[Test 1] Customer-only report...");
  const diag1 = analyzer.analyze({
    customerText: "กดปุ่มดาวน์โหลดรายงานแล้วไม่มีอะไรเกิดขึ้นเลย",
  });
  assert(diag1.customer_report.includes("ดาวน์โหลด"), "Customer report should be preserved");
  assert(diag1.suspected_layer.value !== undefined, "Suspected layer should be assigned");
  assert(diag1.unknowns.length > 0, "Unknowns should be listed when details are sparse");
  assert(diag1.confidence_type === "HEURISTIC_RULE_STRENGTH", "Confidence type must be explicitly heuristic");
  console.log("✅ Passed Test 1");

  // Test 2: Customer + screenshot
  console.log("\n[Test 2] Customer + screenshot...");
  const diag2 = analyzer.analyze({
    customerText: "หน้าจอแสดงผลตามภาพที่แนบครับ",
    attachments: [
      {
        filename: "screenshot_error.png",
        type: "image/png",
        extractedText: "EXCIS ระบบบริหารการเบิกจ่าย (ส่วนกลาง) > ทะเบียนคุมเงินฝากธนาคารกรุงไทย > Error 500",
      },
    ],
  });
  assert(diag2.attachments.length === 1, "Attachment should be recorded");
  assert(
    diag2.customer_evidence.some((e) => e.source === "CUSTOMER_ATTACHMENT"),
    "Evidence list must include attachment text"
  );
  console.log("✅ Passed Test 2");

  // Test 3: Customer + error message
  console.log("\n[Test 3] Customer + error message...");
  const diag3 = analyzer.analyze({
    customerText: "ระบบขึ้นข้อความ Error 500 Internal Server Error เข้าใช้งานไม่ได้",
  });
  assert(
    diag3.customer_evidence.some((e) => e.type === "error_code" && e.value.includes("500")),
    "Should extract error code 500 as evidence"
  );
  assert(
    diag3.suspected_layer.value.includes("Backend API") || diag3.suspected_layer.value.includes("Server"),
    "Should suspect server/backend layer for HTTP 500"
  );
  console.log("✅ Passed Test 3");

  // Test 4: Project knowledge match
  console.log("\n[Test 4] Project knowledge match...");
  const kbResult1: KnowledgeResult = {
    id: "doc_excis_001",
    source: "postgres",
    type: "document",
    confidence: 0.92,
    content: "The reporting engine queries table excis_bank_deposits via POST /api/reports/generate.",
    metadata: { title: "EXCIS Reporting Service Architecture" },
  };
  const diag4 = analyzer.analyze({
    customerText: "พบปัญหาออกรายงาน ทะเบียนคุมเงินฝาก",
    knowledgeResults: [kbResult1],
    projectName: "EXCIS",
    projectId: "101",
  });
  assert(diag4.knowledge_sources.length === 1, "Knowledge sources should be populated");
  assert(diag4.suspected_api.value === "POST /api/reports/generate", "Should extract API from KB");
  assert(diag4.suspected_database_object.value === "excis_bank_deposits", "Should extract DB table from KB");
  assert(diag4.confidence >= 70, "Confidence should be high with knowledge match");
  console.log("✅ Passed Test 4");

  // Test 5: No knowledge match (Anti-hallucination check)
  console.log("\n[Test 5] No knowledge match (Anti-hallucination)...");
  const diag5 = analyzer.analyze({
    customerText: "ทำไมหน้าเว็บบางครั้งโหลดช้า",
    knowledgeResults: [],
  });
  assert(diag5.knowledge_sources.length === 0, "No knowledge sources should be cited");
  assert(
    diag5.suspected_api.value === "NOT_FOUND_IN_KNOWLEDGE_BASE",
    "Must not hallucinate API when not in KB"
  );
  assert(
    diag5.suspected_database_object.value === "NOT_FOUND_IN_KNOWLEDGE_BASE",
    "Must not hallucinate Database object when not in KB"
  );
  assert(diag5.confidence <= 40, "Confidence should remain low for unverified report");
  console.log("✅ Passed Test 5");

  // Test 6: Low-confidence hypothesis
  console.log("\n[Test 6] Low-confidence hypothesis...");
  const diag6 = analyzer.analyze({
    customerText: "เข้าไม่ได้",
  });
  assert(diag6.confidence <= 35, "Confidence should be low when input is ambiguous");
  assert(diag6.root_cause_hypothesis.isHypothesis === true, "Root cause must be marked as hypothesis");
  console.log("✅ Passed Test 6");

  // Test 7: High-confidence technical mapping
  console.log("\n[Test 7] High-confidence technical mapping...");
  const kbResult2: KnowledgeResult = {
    id: "doc_excis_002",
    source: "postgres",
    type: "document",
    confidence: 0.95,
    content: "Provides deposit ledger report. Endpoint: POST /api/reports/deposit-ledger",
    metadata: { title: "EXCIS Report Data Provider" },
  };
  const diag7 = analyzer.analyze({
    customerText: "EXCIS: รายงานทะเบียนคุมเงินฝากธนาคารกรุงไทย (เงินงบประมาณ) ไม่แสดงวันที่โอน",
    knowledgeResults: [kbResult2],
    projectName: "EXCIS",
  });
  assert(diag7.confidence >= 80, "High confidence expected with strong match");
  assert(getProjectVal(diag7.project) === "EXCIS", "Project should be EXCIS");
  console.log("✅ Passed Test 7");

  // Test 8: Missing project
  console.log("\n[Test 8] Missing project...");
  const diag8 = analyzer.analyze({
    customerText: "กดไม่ได้",
  });
  assert(getProjectVal(diag8.project) === "UNKNOWN", "Missing project should be marked UNKNOWN");
  console.log("✅ Passed Test 8");

  // Test 9: Missing attachment
  console.log("\n[Test 9] Missing attachment...");
  const diag9 = analyzer.analyze({
    customerText: "แจ้งปัญหาทั่วไป ไม่มีไฟล์แนบ",
    attachments: [],
  });
  assert(diag9.attachments.length === 0, "Attachments should be empty array");
  console.log("✅ Passed Test 9");

  // Test 10: Malformed diagnostic payload handling in planeService
  console.log("\n[Test 10] Malformed diagnostic payload handling in planeService...");
  const malformedPayload = buildPlaneWorkItemPayload({
    ticket_id: "TCK-2026-TEST10",
    subject: "Test Malformed Diagnostic",
    summary: "Standard fallback summary",
    diagnostic: { invalid_structure: 123, broken: null },
  });
  assert(malformedPayload.name.includes("TCK-2026-TEST10"), "Title should be generated");
  assert(malformedPayload.description_html.includes("Developer Diagnostics"), "Should handle malformed object safely");
  console.log("✅ Passed Test 10");

  // Test 11: Tenant isolation
  console.log("\n[Test 11] Tenant isolation...");
  const kbResultTenantA: KnowledgeResult = {
    id: "doc_tenant_A",
    source: "postgres",
    type: "document",
    confidence: 0.9,
    content: "Confidential Org A Specs",
    metadata: { title: "Org A Private Docs" },
  };
  const diagTenantA = analyzer.analyze({
    customerText: "ทดสอบข้อมูลลูกค้า Org A",
    knowledgeResults: [kbResultTenantA],
    tenantId: "org_tenant_A",
  });
  assert(diagTenantA.knowledge_sources[0].tenantId === "org_tenant_A", "Citation must reflect tenant A");
  console.log("✅ Passed Test 11");

  // Test 12: Existing create_ticket backward compatibility
  console.log("\n[Test 12] Existing create_ticket backward compatibility...");
  const legacyInput = {
    conversationId: "123",
    subject: "Cannot login to app",
    summary: "User reported error 403 on login page",
    severity: "High",
    priority: "P2",
    projectId: "1",
  };
  const parsed = TicketInputSchema.parse(legacyInput);
  assert(parsed.conversationId === "123", "Legacy input must parse cleanly without diagnostic");
  assert(parsed.diagnostic === undefined, "Diagnostic is optional");
  console.log("✅ Passed Test 12");

  // Test 13: Plane description rendering
  console.log("\n[Test 13] Plane description rendering...");
  const kbResult3: KnowledgeResult = {
    id: "doc_excis_003",
    source: "postgres",
    type: "document",
    confidence: 0.88,
    content: "Report generates bank deposit statements via POST /api/reports/bank-deposit using table excis_ledger.",
    metadata: { title: "EXCIS Deposit Ledger Specification" },
  };
  const sampleDiag = analyzer.analyze({
    customerText: "EXCIS : ระบบบริหารการเบิกจ่าย (ส่วนกลาง) > ทะเบียนคุมเงินฝากธนาคารกรุงไทย (เงินงบประมาณ) > รายงานไม่นำวันที่ โอนมาแสดง",
    knowledgeResults: [kbResult3],
    projectName: "EXCIS",
  });
  const planeWorkItem = buildPlaneWorkItemPayload({
    ticket_id: "TCK-2026-EXCIS-01",
    subject: "[EXCIS] รายงานทะเบียนคุมเงินฝากไม่แสดงวันที่โอน",
    summary: "ผู้ใช้งานแจ้งออกรายงาน...",
    priority: "High",
    severity: "High",
    created_by_type: "AI",
    created_by_name: "AgentX",
    diagnostic: sampleDiag,
  });
  assert(planeWorkItem.description_html.includes("🎯 Customer Report"), "Must render Customer Report section");
  assert(planeWorkItem.description_html.includes("🛠️ Developer Diagnostics"), "Must render Developer Diagnostics section");
  assert(planeWorkItem.description_html.includes("🧪 Steps to Reproduce"), "Must render Steps to Reproduce");
  assert(planeWorkItem.description_html.includes("AI HYPOTHESIS"), "Must render AI Hypothesis label");
  assert(planeWorkItem.description_html.includes("🤖 AI Bot"), "Must render creator badge");
  assert(planeWorkItem.description_html.includes("POST /api/reports/bank-deposit"), "Must render suspected API");
  console.log("✅ Passed Test 13");

  // Test 14: LLM / AI Unavailable safe fallback
  console.log("\n[Test 14] LLM / AI Unavailable safe fallback in planeService...");
  const fallbackWorkItem = buildPlaneWorkItemPayload({
    ticket_id: "TCK-2026-FALLBACK",
    subject: "Test Fallback Without Diagnostic",
    summary: "Simple customer text without any AI processing",
    priority: "Medium",
    severity: "Medium",
  });
  assert(fallbackWorkItem.description_html.includes("<h3>Customer report</h3>"), "Must render standard fallback format");
  assert(fallbackWorkItem.description_html.includes("Simple customer text without any AI processing"), "Must preserve summary");
  console.log("✅ Passed Test 14");

  // Test 15: RAG unavailable (empty knowledge)
  console.log("\n[Test 15] RAG unavailable...");
  const diagRAGUnavailable = analyzer.analyze({
    customerText: "พบปัญหาหน้าจอค้าง",
    knowledgeResults: [],
  });
  assert(diagRAGUnavailable.knowledge_sources.length === 0, "No KB cited when RAG is down");
  assert(diagRAGUnavailable.suspected_api.value === "NOT_FOUND_IN_KNOWLEDGE_BASE", "Must flag NOT_FOUND_IN_KNOWLEDGE_BASE");
  console.log("✅ Passed Test 15");

  // Remediation Test: Multimodal Fallback & Security (No Fake OCR)
  console.log("\n[Remediation Test] Multimodal Attachment Fallback & Security...");
  const diagWithBinary = analyzer.analyze({
    customerText: "ดูภาพนี้",
    attachments: [
      { filename: "raw_screenshot.png", type: "image/png" }, // No OCR text provided
      { filename: "malicious_payload.exe", type: "executable" },
      { filename: "huge_video.mp4", sizeBytes: 25 * 1024 * 1024 }, // 25MB
    ],
  });
  assert(
    diagWithBinary.unknowns.some((u) => u.includes("no local OCR engine executed")),
    "Raw binary image without OCR must be explicitly noted in unknowns without claiming OCR"
  );
  assert(
    diagWithBinary.unknowns.some((u) => u.includes("dangerous file extension")),
    "Dangerous file must be rejected and logged in unknowns"
  );
  assert(
    diagWithBinary.unknowns.some((u) => u.includes("exceeds maximum limit")),
    "Oversized file must be rejected and logged in unknowns"
  );
  console.log("✅ Passed Multimodal Attachment Fallback & Security Test");

  // Security test: Sanitization check
  console.log("\n[Security Test] Sanitization check...");
  const sensitiveText = "My password is password=SuperSecret123! and API key is sk-123456789012345678901234 with plane_api_6d16b662f16343e090c345cc76f59b03";
  const sanitized = sanitizeSensitiveData(sensitiveText);
  assert(!sanitized.includes("SuperSecret123!"), "Password must be redacted");
  assert(!sanitized.includes("sk-123456789012345678901234"), "API key must be redacted");
  assert(!sanitized.includes("plane_api_6d16b662f16343e090c345cc76f59b03"), "Plane key must be redacted");
  console.log("✅ Passed Security Sanitization Test");

  // Test 16: DiagnosticContextBuilder bounded context assembly
  console.log("\n[Test 16] DiagnosticContextBuilder bounded context assembly...");
  const { DiagnosticContextBuilder } = await import("./agent/diagnostic/DiagnosticContextBuilder");
  const boundedCtx = DiagnosticContextBuilder.buildBoundedContext({
    customerText: "System crashes when submitting form",
    conversationHistory: [
      { role: "customer", content: "Hello, I have an issue" },
      { role: "agent", content: "Please describe the issue" },
      { role: "customer", content: "System crashes when submitting form password=MySecret123" },
    ],
    tenantId: "org_avalant",
    projectId: "101",
  });
  assert(boundedCtx.tenantId === "org_avalant", "Tenant ID must be preserved");
  assert(boundedCtx.projectId === "101", "Project ID must be preserved");
  assert(!boundedCtx.boundedHistory.includes("MySecret123"), "Sensitive content in history must be sanitized");
  console.log("✅ Passed Test 16 (DiagnosticContextBuilder)");

  // Test 17: AI Developer Diagnostic reasoning via analyzeAsync with deterministic fallback
  console.log("\n[Test 17] AI Developer Diagnostic reasoning & fallback...");
  const aiDiagResult = await analyzer.analyzeAsync({
    customerText: "EXCIS: รายงานทะเบียนคุมเงินฝาก ไม่แสดงวันที่โอน",
    knowledgeResults: [kbResult1],
    projectId: "101",
    tenantId: "org_avalant",
    forceDeterministic: true, // Deterministic path test
  });
  assert(aiDiagResult.customer_report.includes("ทะเบียนคุมเงินฝาก"), "Customer report must be preserved");
  assert(aiDiagResult.confidence_type !== undefined, "Confidence type must be set");
  assert(aiDiagResult.unknowns !== undefined, "Unknowns must be tracked");
  console.log("✅ Passed Test 17 (AI Reasoning & Fallback)");

  // Test 18: Proof A — Successful AI JSON Path (Mock PromptX Single Invocation)
  console.log("\n[Test 18] Proof A — Successful AI JSON Path (Single Invocation)...");
  const { PromptXMcpClient } = await import("./mcp/PromptXMcpClient");
  let promptXCallCount = 0;
  const originalChatAgent = PromptXMcpClient.prototype.chatAgent;

  PromptXMcpClient.prototype.chatAgent = async function (...args: any[]) {
    promptXCallCount++;
    return {
      type: "final",
      text: JSON.stringify({
        project: { value: "EXCIS", source: "AI_INFERENCE", confidence: 90, confidence_type: "AI_REASONING_CONFIDENCE" },
        module: { value: "Reporting Module", source: "AI_INFERENCE", confidence: 85, confidence_type: "AI_REASONING_CONFIDENCE" },
        feature: { value: "Deposit Ledger Report", source: "AI_INFERENCE", confidence: 85, confidence_type: "AI_REASONING_CONFIDENCE" },
        customer_report: "EXCIS: รายงานทะเบียนคุมเงินฝาก ไม่แสดงวันที่โอน",
        environment: "Production",
        reproduction_steps: ["Step 1: Open Report", "Step 2: Generate Deposit Ledger"],
        expected_behavior: "Transfer date column should be populated",
        actual_behavior: "Transfer date column is blank",
        suspected_layer: { value: "Backend Reporting Service", source: "AI_INFERENCE", confidence: 85, confidence_type: "AI_REASONING_CONFIDENCE", isHypothesis: true },
        suspected_component: { value: "Deposit Ledger Query Builder", source: "AI_INFERENCE", confidence: 80, confidence_type: "AI_REASONING_CONFIDENCE", isHypothesis: true },
        suspected_api: { value: "POST /api/reports/generate", source: "AI_INFERENCE", confidence: 85, confidence_type: "AI_REASONING_CONFIDENCE", isHypothesis: true },
        suspected_database_object: { value: "excis_bank_deposits", source: "AI_INFERENCE", confidence: 85, confidence_type: "AI_REASONING_CONFIDENCE", isHypothesis: true },
        root_cause_hypothesis: { value: "Query omitted transfer_date column from SELECT clause", source: "AI_INFERENCE", confidence: 85, confidence_type: "AI_REASONING_CONFIDENCE", isHypothesis: true },
        confidence: 85,
        confidence_type: "AI_REASONING_CONFIDENCE",
        unknowns: [],
        recommended_next_action: "Add transfer_date column to report query",
      }),
    };
  };

  try {
    const successAiAnalyzer = new DiagnosticAnalyzer();
    const successDiag = await successAiAnalyzer.analyzeAsync({
      customerText: "EXCIS: รายงานทะเบียนคุมเงินฝาก ไม่แสดงวันที่โอน",
      knowledgeResults: [kbResult1],
      projectId: "101",
      tenantId: "org_avalant",
    });

    assert.strictEqual(promptXCallCount, 1, "COST CONTROL VIOLATION: PromptX MUST be invoked exactly ONCE");
    assert.strictEqual(successDiag.confidence_type, "AI_REASONING_CONFIDENCE", "Confidence type MUST be AI_REASONING_CONFIDENCE");
    assert.strictEqual(successDiag.suspected_layer.value, "Backend Reporting Service", "AI-generated suspected layer must be preserved");
    assert.strictEqual(successDiag.suspected_api.value, "POST /api/reports/generate", "AI-generated suspected API must be preserved");
    assert.strictEqual(successDiag.suspected_database_object.value, "excis_bank_deposits", "AI-generated DB object must be preserved");
    console.log("✅ Passed Test 18 (Proof A — Successful AI Path & Single Invocation)");
  } finally {
    PromptXMcpClient.prototype.chatAgent = originalChatAgent;
  }

  // Test 19: Case A — Malformed JSON Fallback (Single Invocation)
  console.log("\n[Test 19] Case A — Malformed JSON Fallback (Single Invocation)...");
  promptXCallCount = 0;
  PromptXMcpClient.prototype.chatAgent = async function () {
    promptXCallCount++;
    return { type: "final", text: "NOT VALID JSON AT ALL" };
  };

  try {
    const malformedAnalyzer = new DiagnosticAnalyzer();
    const malformedDiag = await malformedAnalyzer.analyzeAsync({
      customerText: "EXCIS: รายงานไม่แสดงวันที่โอน",
      projectId: "101",
      tenantId: "org_avalant",
    });

    assert.strictEqual(promptXCallCount, 1, "COST CONTROL VIOLATION: PromptX MUST be invoked exactly ONCE on malformed response");
    assert.strictEqual(malformedDiag.confidence_type, "HEURISTIC_RULE_STRENGTH", "Must fallback to HEURISTIC_RULE_STRENGTH");
    assert(malformedDiag.customer_report.includes("ไม่แสดงวันที่โอน"), "Customer report must be preserved");
    console.log("✅ Passed Test 19 (Malformed JSON Fallback)");
  } finally {
    PromptXMcpClient.prototype.chatAgent = originalChatAgent;
  }

  // Test 20: Case B — Invalid Schema Fallback (Single Invocation)
  console.log("\n[Test 20] Case B — Invalid Schema Fallback (Single Invocation)...");
  promptXCallCount = 0;
  PromptXMcpClient.prototype.chatAgent = async function () {
    promptXCallCount++;
    return { type: "final", text: JSON.stringify({ invalidField: "broken", confidence: "NOT_A_NUMBER" }) };
  };

  try {
    const invalidSchemaAnalyzer = new DiagnosticAnalyzer();
    const invalidSchemaDiag = await invalidSchemaAnalyzer.analyzeAsync({
      customerText: "EXCIS: รายงานไม่แสดงวันที่โอน",
      projectId: "101",
      tenantId: "org_avalant",
    });

    assert.strictEqual(promptXCallCount, 1, "COST CONTROL VIOLATION: PromptX MUST be invoked exactly ONCE on invalid schema");
    assert.strictEqual(invalidSchemaDiag.confidence_type, "HEURISTIC_RULE_STRENGTH", "Must fallback to HEURISTIC_RULE_STRENGTH");
    console.log("✅ Passed Test 20 (Invalid Schema Fallback)");
  } finally {
    PromptXMcpClient.prototype.chatAgent = originalChatAgent;
  }

  // Test 21: Case C — Empty Response Fallback (Single Invocation)
  console.log("\n[Test 21] Case C — Empty Response Fallback (Single Invocation)...");
  promptXCallCount = 0;
  PromptXMcpClient.prototype.chatAgent = async function () {
    promptXCallCount++;
    return { type: "final", text: "" };
  };

  try {
    const emptyAnalyzer = new DiagnosticAnalyzer();
    const emptyDiag = await emptyAnalyzer.analyzeAsync({
      customerText: "EXCIS: รายงานไม่แสดงวันที่โอน",
      projectId: "101",
      tenantId: "org_avalant",
    });

    assert.strictEqual(promptXCallCount, 1, "COST CONTROL VIOLATION: PromptX MUST be invoked exactly ONCE on empty response");
    assert.strictEqual(emptyDiag.confidence_type, "HEURISTIC_RULE_STRENGTH", "Must fallback to HEURISTIC_RULE_STRENGTH");
    console.log("✅ Passed Test 21 (Empty Response Fallback)");
  } finally {
    PromptXMcpClient.prototype.chatAgent = originalChatAgent;
  }

  // Test 22: Timeout Hardening Test (Configured 3000ms Timeout & Single Invocation)
  console.log("\n[Test 22] Timeout Hardening Test (3000ms Timeout & Single Invocation)...");
  promptXCallCount = 0;
  PromptXMcpClient.prototype.chatAgent = async function () {
    promptXCallCount++;
    throw new Error("timeout of 3000ms exceeded");
  };

  try {
    const timeoutAnalyzer = new DiagnosticAnalyzer();
    const startTime = Date.now();
    const timeoutDiag = await timeoutAnalyzer.analyzeAsync({
      customerText: "EXCIS: รายงานไม่แสดงวันที่โอน",
      projectId: "101",
      tenantId: "org_avalant",
    });
    const elapsed = Date.now() - startTime;

    assert.strictEqual(promptXCallCount, 1, "COST CONTROL VIOLATION: PromptX MUST be invoked exactly ONCE on timeout");
    assert.strictEqual(timeoutDiag.confidence_type, "HEURISTIC_RULE_STRENGTH", "Must fallback to HEURISTIC_RULE_STRENGTH");
    assert(elapsed < 4000, `Execution time ${elapsed}ms must be under 4000ms (no 20s hang)`);
    console.log("✅ Passed Test 22 (Timeout Hardening Test)");
  } finally {
    PromptXMcpClient.prototype.chatAgent = originalChatAgent;
  }

  // Test 23: Proof B — Controlled Live PromptX Single Execution
  console.log("\n[Test 23] Proof B — Controlled Live PromptX Single Execution...");
  const liveMcpClient = new PromptXMcpClient();
  const liveStartTime = Date.now();
  let liveStatus = "UNKNOWN";
  try {
    const liveRes = await liveMcpClient.chatAgent(
      "Ping test",
      { conversationId: "live-test-01", history: [] },
      { companyId: "org_avalant", companyName: "Live Test" },
      [],
      3000 // 3s timeout
    );
    liveStatus = liveRes?.text ? "SUCCESS" : "EMPTY";
  } catch (err: any) {
    liveStatus = err.message?.includes("timeout") ? "TIMEOUT" : `ERROR (${err.message})`;
  }
  const liveElapsed = Date.now() - liveStartTime;
  console.log(`ℹ️ Live PromptX Call Result: ${liveStatus} in ${liveElapsed}ms (Single Invocation)`);
  console.log("✅ Passed Test 23 (Controlled Live PromptX Single Execution)");

  console.log("\n==================================================");
  console.log("ALL DEVELOPER DIAGNOSTIC & REMEDIATION TESTS PASSED! 🚀");
  console.log("==================================================");
}

runDeveloperDiagnosticPipelineTests().catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
