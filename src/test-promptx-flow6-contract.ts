/**
 * test-promptx-flow6-contract.ts
 *
 * Deterministic Contract Test Suite for Flow 6 & PromptX Main AI Core Integration.
 *
 * Requirements:
 * - 0 live PromptX API calls (pure, offline)
 * - 0 DB mutations / no live database required
 * - 0 external LINE / Plane calls
 * - Directly evaluates step_parse_gate JS code extracted from Main AI Core Flow.json
 * - Tests CaseResolver + LineCaseContextService + Gatekeeper contracts
 * - Covers all 12 required scenarios
 */

import fs from "fs";
import path from "path";
import assert from "assert";
import { caseResolver, type CaseCandidate } from "./domain/case/CaseResolver";
import { buildCaseHint, ambiguityChips, followUpReportText } from "./services/LineCaseContextService";

// 1. Extract step_parse_gate code from Main AI Core Flow.json
const flowPath = path.resolve(__dirname, "../../../workflow-tooling/promptx_tools/workflow/เริ่มต้นใหม่อีกครั้ง/Main AI Core Flow.json");
const rawJson = fs.readFileSync(flowPath, "utf-8").replace(/^\uFEFF/, "");
const flowData = JSON.parse(rawJson);

function findAction(action: any, name: string): any {
  if (!action) return null;
  if (action.name === name) return action;
  if (action.nextAction) {
    const found = findAction(action.nextAction, name);
    if (found) return found;
  }
  if (action.children) {
    for (const child of action.children) {
      const found = findAction(child, name);
      if (found) return found;
    }
  }
  return null;
}

const parseGateNode = findAction(flowData.flows[0].trigger.nextAction, "step_parse_gate");
if (!parseGateNode || !parseGateNode.settings?.sourceCode?.code) {
  throw new Error("Failed to find step_parse_gate code in Main AI Core Flow.json");
}

// Compile step_parse_gate function
const gateCodeStr = parseGateNode.settings.sourceCode.code;
const gateModule: { exports: { code?: (inputs: any) => Promise<any> } } = { exports: {} };
const compileGateFn = new Function("exports", gateCodeStr);
compileGateFn(gateModule.exports);
const runGateCode = gateModule.exports.code!;

// Mock Test Cases
const CASE_LOGIN: CaseCandidate = {
  id: 8618,
  ticket_number: "TCK-2026-86186",
  subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก",
  summary: "เข้าเว็บไซต์ไม่ได้ ขึ้นหน้า error",
  status: "IN_PROGRESS",
  created_at: "2026-09-17T08:17:34.000Z",
};

const CASE_EXPENSE: CaseCandidate = {
  id: 7301,
  ticket_number: "TCK-2026-73046",
  subject: "ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ",
  summary: "ต้องการย้อนสถานะใบเสร็จเล่มที่ 05",
  status: "IN_PROGRESS",
  created_at: "2026-09-17T09:37:31.000Z",
};

const CASE_CLOSED_WEB: CaseCandidate = {
  id: 8396,
  ticket_number: "TCK-2026-83960",
  subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้",
  summary: "เข้าเว็บไซต์ไม่ได้ เป็นเรื่องด่วนมาก",
  status: "CLOSED",
  created_at: "2026-09-15T04:00:00.000Z",
};

const CASE_SIMILAR_WEB: CaseCandidate = {
  id: 8619,
  ticket_number: "TCK-2026-86187",
  subject: "ระบบเว็บไซต์ - เกิดข้อผิดพลาด 500",
  summary: "เปิดหน้าเว็บไซต์แล้วขึ้นข้อผิดพลาด 500",
  status: "IN_PROGRESS",
  created_at: "2026-09-17T08:20:00.000Z",
};

async function runAllScenarios() {
  console.log("===============================================================================");
  console.log(" deterministic promptx / flow6 contract test suite (12 scenarios)");
  console.log("===============================================================================");

  let passedCount = 0;

  // -------------------------------------------------------------------------
  // Scenario 1: CONTINUE_ACTIVE_CASE
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 1] CONTINUE_ACTIVE_CASE");
    const msg = "เคสนี้ขอส่งรูปภาพหน้าเว็บ error เพิ่มเติมครับ";
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: CASE_LOGIN.id,
      messageText: msg,
      hasAttachments: true,
      openCases: [CASE_LOGIN, CASE_EXPENSE],
      closedCases: [],
      recentMessages: [],
    });
    assert.strictEqual(res.type, "CONTINUE_ACTIVE_CASE");
    assert.strictEqual(res.ticketId, CASE_LOGIN.id);

    const hint = buildCaseHint(res, 2);
    const gateOut = await runGateCode({
      history: "Customer: เข้าเว็บไม่ได้ครับ\nAssistant: กำลังดำเนินการเคส TCK-2026-86186 ค่ะ",
      response: JSON.stringify({
        intent: "SUPPORT",
        ticket_action: "UPDATE",
        ticket_id: "",
        subject: "เพิ่มรูปภาพ error",
        summary: "ขอเพิ่มรูปภาพ error ตอน login",
      }),
      currentMessage: msg,
      pending: [{ active_ticket: "TCK-2026-86186" }],
      caseIntent: hint.intent,
      caseTicket: hint.ticketNumber,
      caseForceNew: String(hint.forceNew),
    });

    assert.strictEqual(gateOut.ticket_action, "UPDATE");
    assert.strictEqual(gateOut.ticket_id, "TCK-2026-86186", "Gate must bind to hint focus ticket");
    assert.strictEqual(gateOut.focus_ticket, "TCK-2026-86186");
    assert.strictEqual(gateOut.force_new, false);
    console.log("  ✓ PASS: CaseResolver + step_parse_gate correctly bound to active case");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 2: SWITCH_EXISTING_CASE
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 2] SWITCH_EXISTING_CASE");
    const msg = "สลับไปที่ TCK-2026-73046";
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: CASE_LOGIN.id,
      messageText: msg,
      openCases: [CASE_LOGIN, CASE_EXPENSE],
      closedCases: [],
      recentMessages: [],
    });
    assert.strictEqual(res.type, "SWITCH_EXISTING_CASE");
    assert.strictEqual(res.ticketId, CASE_EXPENSE.id);
    assert.strictEqual(res.ticketNumber, "TCK-2026-73046");

    const hint = buildCaseHint(res, 2);
    const gateOut = await runGateCode({
      history: "Assistant: อยู่ในเคส TCK-2026-86186",
      response: JSON.stringify({
        intent: "SUPPORT",
        ticket_action: "GET_STATUS",
        ticket_id: "",
      }),
      currentMessage: msg,
      pending: [{ active_ticket: "TCK-2026-86186" }],
      caseIntent: hint.intent,
      caseTicket: hint.ticketNumber,
      caseForceNew: String(hint.forceNew),
    });

    assert.strictEqual(gateOut.ticket_id, "TCK-2026-73046", "Hint ticket must override previous active ticket");
    assert.strictEqual(gateOut.focus_ticket, "TCK-2026-73046");
    console.log("  ✓ PASS: SWITCH_EXISTING_CASE successfully overrides previous active ticket");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 3: NEW_CASE
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 3] NEW_CASE");
    const msg = "ขอแจ้งเรื่องใหม่ครับ ระบบเบิกจ่ายเงินคำนวณยอดผิด";
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: CASE_LOGIN.id,
      messageText: msg,
      openCases: [CASE_LOGIN],
      closedCases: [],
      recentMessages: [],
    });
    assert.strictEqual(res.type, "NEW_CASE");
    assert.strictEqual(res.ticketId, null);

    const hint = buildCaseHint(res, 1);
    assert.strictEqual(hint.forceNew, true, "forceNew must be true when open cases exist");

    const gateOut = await runGateCode({
      history: "Assistant: กำลังดูแลเคส TCK-2026-86186 นะคะ",
      response: JSON.stringify({
        intent: "INCIDENT",
        ticket_action: "CREATE",
        subject: "ระบบเบิกจ่ายเงินคำนวณยอดผิด",
        summary: "ระบบเบิกจ่ายเงินคำนวณยอดผิดพลาด",
      }),
      currentMessage: msg,
      pending: [{ active_ticket: "TCK-2026-86186" }],
      caseIntent: hint.intent,
      caseTicket: hint.ticketNumber,
      caseForceNew: String(hint.forceNew),
    });

    assert.strictEqual(gateOut.force_new, true, "force_new must be preserved in Gatekeeper output");
    assert.strictEqual(gateOut.ticket_action, "CONFIRM_REQUIRED");
    assert.strictEqual(gateOut.parent_ticket_number, "");
    console.log("  ✓ PASS: NEW_CASE forces force_new = true to prevent hub fold");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 4: AMBIGUOUS_CASE
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 4] AMBIGUOUS_CASE (Gateway Edge Intercept & Flow Fallback)");
    const msg = "เรื่องที่แจ้งไปถึงไหนแล้วคะ";
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: null,
      messageText: msg,
      openCases: [CASE_LOGIN, CASE_EXPENSE],
      closedCases: [],
      recentMessages: [],
    });
    assert.strictEqual(res.type, "AMBIGUOUS_CASE");
    assert.strictEqual(res.ticketId, null);

    // Gateway edge intercept generates chips
    const chips = ambiguityChips([CASE_LOGIN, CASE_EXPENSE]);
    assert.strictEqual(chips.length, 3); // 2 cases + 1 "แจ้งเรื่องใหม่"
    assert(chips[0].text.includes("TCK-2026-86186"));
    assert(chips[1].text.includes("TCK-2026-73046"));

    // Verify Gatekeeper fallback if message reaches Gatekeeper without focus ticket
    const gateOut = await runGateCode({
      history: "Customer: สวัสดีค่ะ\nAssistant: สวัสดีค่ะ มีอะไรให้ช่วยเหลือคะ",
      response: JSON.stringify({
        intent: "SUPPORT",
        ticket_action: "GET_STATUS",
        ticket_id: "",
      }),
      currentMessage: msg,
      pending: [],
      caseIntent: "",
      caseTicket: "",
      caseForceNew: "false",
    });
    assert.strictEqual(gateOut.ticket_action, "FIND", "Should safely degrade to FIND without guessing");
    assert.strictEqual(gateOut.ticket_id, "");
    console.log("  ✓ PASS: AMBIGUOUS_CASE generates chips at edge and safely degrades to FIND in Flow");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 5: CLOSED_CASE_REFERENCE
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 5] CLOSED_CASE_REFERENCE (Protection & Follow-up Flow)");
    const msg = "เรื่องเว็บเข้าไม่ได้ถึงไหนแล้วคะ";
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: null,
      messageText: msg,
      openCases: [CASE_EXPENSE], // Only expense is open, web is CLOSED
      closedCases: [CASE_CLOSED_WEB],
      recentMessages: [],
    });
    assert.strictEqual(res.type, "CLOSED_CASE_REFERENCE");
    assert.strictEqual(res.ticketId, null, "MUST NOT route to closed ticket");
    assert.strictEqual(res.referencedTicketId, CASE_CLOSED_WEB.id);

    // Follow-up flow when customer taps [เปิดเคสใหม่จากเรื่องนี้]
    const followUpText = followUpReportText(CASE_CLOSED_WEB);
    assert(followUpText.includes("เปิดเคสใหม่ต่อจากเคส TCK-2026-83960"));

    const gateOut = await runGateCode({
      history: "Assistant: เคสนี้ปิดไปแล้วค่ะ",
      response: JSON.stringify({
        intent: "INCIDENT",
        ticket_action: "CONFIRM_REQUIRED",
        subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้",
        summary: "เข้าเว็บไซต์ไม่ได้ เป็นเรื่องด่วนมาก",
      }),
      currentMessage: followUpText,
      pending: [],
      caseIntent: "NEW_CASE",
      caseTicket: null,
      caseForceNew: "true",
    });

    assert.strictEqual(gateOut.parent_ticket_number, "TCK-2026-83960");
    assert.strictEqual(gateOut.force_new, true);
    console.log("  ✓ PASS: CLOSED_CASE_REFERENCE protected; follow-up links parent_ticket_number");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 6: CLOSE current case
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 6] CLOSE current case");
    const msg = "ปัญหาแก้ได้แล้ว ขอปิดเคสครับ";
    const gateOut = await runGateCode({
      history: "Assistant: กำลังดูแลเคส TCK-2026-86186 อยู่นะคะ",
      response: JSON.stringify({
        intent: "SUPPORT",
        ticket_action: "CLOSE",
        ticket_id: "",
      }),
      currentMessage: msg,
      pending: [{ active_ticket: "TCK-2026-86186" }],
      caseIntent: "CONTINUE_ACTIVE_CASE",
      caseTicket: "TCK-2026-86186",
      caseForceNew: "false",
    });

    assert.strictEqual(gateOut.ticket_action, "CLOSE");
    assert.strictEqual(gateOut.ticket_id, "TCK-2026-86186");
    assert.strictEqual(gateOut.focus_ticket, "TCK-2026-86186");
    console.log("  ✓ PASS: CLOSE current case correctly resolves target from focus_ticket");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 7: CLOSE explicit TCK while another ticket is active
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 7] CLOSE explicit TCK while another ticket is active");
    const msg = "ปิดเคส TCK-2026-73046 ครับ";
    const gateOut = await runGateCode({
      history: "Assistant: กำลังดูแลเคส TCK-2026-86186 อยู่นะคะ",
      response: JSON.stringify({
        intent: "SUPPORT",
        ticket_action: "CLOSE",
        ticket_id: "TCK-2026-73046",
      }),
      currentMessage: msg,
      pending: [{ active_ticket: "TCK-2026-86186" }],
      caseIntent: "SWITCH_EXISTING_CASE",
      caseTicket: "TCK-2026-73046",
      caseForceNew: "false",
    });

    assert.strictEqual(gateOut.ticket_action, "CLOSE");
    assert.strictEqual(gateOut.ticket_id, "TCK-2026-73046", "Explicit ticket must be targeted, not active ticket 86186");
    console.log("  ✓ PASS: Explicit close targets explicit ticket without touching active session ticket");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 8: Unrelated topic with one open case (W3 single-open-case guardrail)
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 8] Unrelated topic with one open case (W3 guardrail)");
    const msg = "ขอยื่นกู้เงินกู้ฉุกเฉินได้ทางไหนคะ";
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: CASE_LOGIN.id,
      messageText: msg,
      openCases: [CASE_LOGIN], // Exactly one open case about website failure
      closedCases: [],
      recentMessages: [],
    });

    // CaseResolver must NOT force route to CONTINUE_ACTIVE_CASE for website!
    assert.notStrictEqual(res.type, "CONTINUE_ACTIVE_CASE", "W3 violation: Unrelated topic must not continue single open case");

    const gateOut = await runGateCode({
      history: "Assistant: ดำเนินการเคส TCK-2026-86186 ค่ะ",
      response: JSON.stringify({
        intent: "FAQ",
        ticket_action: "NONE",
        ticket_id: "",
      }),
      currentMessage: msg,
      pending: [{ active_ticket: "TCK-2026-86186" }],
      caseIntent: "NEW_CASE",
      caseTicket: null,
      caseForceNew: "true",
    });

    assert.strictEqual(gateOut.ticket_action, "NONE");
    assert.strictEqual(gateOut.ticket_id, "");
    assert.strictEqual(gateOut.targetAgent, "faq");
    console.log("  ✓ PASS: W3 guardrail preserved: unrelated query does NOT attach to single open case");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 9: Short continuation with one open case
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 9] Short continuation with one open case");
    const msg = "ยังเหมือนเดิมครับ";
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: CASE_LOGIN.id,
      messageText: msg,
      openCases: [CASE_LOGIN],
      closedCases: [],
      recentMessages: [],
    });
    assert.strictEqual(res.type, "CONTINUE_ACTIVE_CASE");
    assert.strictEqual(res.ticketId, CASE_LOGIN.id);

    const hint = buildCaseHint(res, 1);
    const gateOut = await runGateCode({
      history: "Customer: หน้าเว็บขึ้น error 500\nAssistant: บันทึกเคส TCK-2026-86186 เรียบร้อยแล้วค่ะ",
      response: JSON.stringify({
        intent: "SUPPORT",
        ticket_action: "UPDATE",
        ticket_id: "",
        subject: "ระบบเว็บไซต์ - ยังใช้งานไม่ได้",
        summary: "อาการยังคงเป็นเหมือนเดิม",
      }),
      currentMessage: msg,
      pending: [{ active_ticket: "TCK-2026-86186" }],
      caseIntent: hint.intent,
      caseTicket: hint.ticketNumber,
      caseForceNew: String(hint.forceNew),
    });

    assert.strictEqual(gateOut.ticket_action, "UPDATE");
    assert.strictEqual(gateOut.ticket_id, "TCK-2026-86186");
    console.log("  ✓ PASS: Short continuation correctly maintains active case context");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 10: Image-only continuation
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 10] Image-only continuation");
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: CASE_LOGIN.id,
      messageText: "",
      hasAttachments: true,
      openCases: [CASE_LOGIN],
      closedCases: [],
      recentMessages: [],
    });
    assert.strictEqual(res.type, "CONTINUE_ACTIVE_CASE");
    assert.strictEqual(res.ticketId, CASE_LOGIN.id);

    const hint = buildCaseHint(res, 1);
    const gateOut = await runGateCode({
      history: "Customer: หน้าเว็บขึ้น error 500\nAssistant: บันทึกเคส TCK-2026-86186 เรียบร้อยแล้วค่ะ",
      response: JSON.stringify({
        intent: "SUPPORT",
        ticket_action: "UPDATE",
        ticket_id: "",
        subject: "ส่งรูปภาพเพิ่มเติม",
        summary: "ผู้ใช้ส่งรูปภาพหลักฐานเพิ่มเติม",
      }),
      currentMessage: "",
      pending: [{ active_ticket: "TCK-2026-86186" }],
      caseIntent: hint.intent,
      caseTicket: hint.ticketNumber,
      caseForceNew: String(hint.forceNew),
    });

    assert.strictEqual(gateOut.ticket_action, "UPDATE");
    assert.strictEqual(gateOut.ticket_id, "TCK-2026-86186");
    console.log("  ✓ PASS: Image-only attachment routes to active case without degradation");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 11: Two similar cases (Ambiguity)
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 11] Two similar cases");
    const msg = "เว็บพังอีกแล้ว";
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: null,
      messageText: msg,
      openCases: [CASE_LOGIN, CASE_SIMILAR_WEB],
      closedCases: [],
      recentMessages: [],
    });
    assert.strictEqual(res.type, "AMBIGUOUS_CASE");
    assert.strictEqual(res.ticketId, null);
    assert(Array.isArray(res.candidates) && res.candidates.length >= 2);
    console.log("  ✓ PASS: Two similar open cases resolve to AMBIGUOUS_CASE instead of picking arbitrarily");
    passedCount++;
  }

  // -------------------------------------------------------------------------
  // Scenario 12: Closed ticket cannot become routing target
  // -------------------------------------------------------------------------
  {
    console.log("\n[Scenario 12] Closed ticket cannot become routing target");
    const msg = "ระบบเว็บที่เคยปิดไปเมื่อวาน ตอนนี้เป็นยังไงบ้าง";
    const res = caseResolver.resolve({
      conversationId: 101,
      activeTicketId: null,
      messageText: msg,
      openCases: [CASE_EXPENSE],
      closedCases: [CASE_CLOSED_WEB],
      recentMessages: [],
    });
    assert.strictEqual(res.type, "CLOSED_CASE_REFERENCE");
    assert.strictEqual(res.ticketId, null, "Closed ticket cannot be routing ticketId");
    assert.strictEqual(res.referencedTicketId, CASE_CLOSED_WEB.id);
    console.log("  ✓ PASS: Closed ticket is strictly protected from being routed to directly");
    passedCount++;
  }

  console.log("\n===============================================================================");
  console.log(` ALL ${passedCount}/12 SCENARIOS PASSED WITH 0 LIVE PROMPTX CALLS!`);
  console.log("===============================================================================");
}

runAllScenarios().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
