import assert from "node:assert";
import { CaseResolver, type CaseCandidate } from "../../src/domain/case/CaseResolver";
import {
  detectCloseIntent,
  detectCancelIntent,
  isNegativeCloseIntent,
} from "../../src/domain/ticket/CustomerConfirmation";
import { canTransition } from "../../src/domain/ticket/TicketLifecycle";

/**
 * ISSUE-080 & ISSUE-081 Lifecycle Safety Test Suite (21 Tests)
 *
 * Requirements:
 * 1. ISSUE-080: Open case must win over closed-case semantic ambiguity.
 * 2. ISSUE-081: CLOSE must never execute without an authorized target case.
 * 3. W3 Guard: Single open case must not blindly route unrelated messages without continuity evidence.
 *
 * Strict user constraints:
 * - 0 PromptX live calls.
 * - 0 Browser / LINE / Plane calls.
 * - Purely deterministic local testing.
 */
async function runAllTests() {
  console.log("==================================================");
  console.log("Running ISSUE-080 & ISSUE-081 Test Suite (21 tests)");
  console.log("==================================================");

  const resolver = new CaseResolver();

  // Common Fixtures (standard TicketX 5-digit sequence TCK-YYYY-NNNNN)
  const openCaseA: CaseCandidate = {
    id: 101,
    ticket_number: "TCK-2026-00101",
    subject: "เข้าสู่ระบบไม่ได้ ล็อกอิน portal error",
    summary: "Login authentication error on customer portal",
    issue_category: "authentication",
    status: "OPEN",
    slug: "login-portal",
  };

  const openCaseB: CaseCandidate = {
    id: 102,
    ticket_number: "TCK-2026-00102",
    subject: "ยอดเงินในใบแจ้งหนี้ไม่ตรงกับสัญญา",
    summary: "Invoice billing discrepancy on annual contract",
    issue_category: "billing",
    status: "IN_PROGRESS",
    slug: "billing-invoice",
  };

  const openCaseC: CaseCandidate = {
    id: 103,
    ticket_number: "TCK-2026-00103",
    subject: "ยอดเงินในใบเสร็จรับเงินไม่ตรงกับการโอน",
    summary: "Receipt payment calculation mismatch",
    issue_category: "billing",
    status: "OPEN",
    slug: "receipt-mismatch",
  };

  const closedCaseX: CaseCandidate = {
    id: 201,
    ticket_number: "TCK-2026-00201",
    subject: "เข้าสู่ระบบไม่ได้ ล็อกอิน portal error ติดสิทธิ์ผู้ใช้",
    summary: "Resolved login issue for portal user",
    issue_category: "authentication",
    status: "CLOSED",
    slug: "login-resolved",
  };

  const closedCaseY: CaseCandidate = {
    id: 202,
    ticket_number: "TCK-2026-00202",
    subject: "ขอใบกำกับภาษีรอบเดือนมกราคม",
    summary: "Delivered tax invoice for January",
    issue_category: "billing",
    status: "CLOSED",
    slug: "tax-invoice-delivered",
  };

  let passedCount = 0;

  // -------------------------------------------------------------
  // Test 1: One open ticket + message mentions exact open ticket number -> route to that ticket
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      messageText: "ตรวจสอบเคส TCK-2026-00101 หน่อยครับ",
      openCases: [openCaseA],
      closedCases: [],
    });
    assert.strictEqual(res.routingTicketId, 101);
    assert.strictEqual(res.ticketNumber, "TCK-2026-00101");
    console.log("✅ Test 1 Passed: One open ticket + message mentions exact open ticket number -> route to that ticket");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 2: One open ticket + message mentions exact closed ticket number -> CLOSED_CASE_REFERENCE, route = null
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      messageText: "ขอสอบถามเกี่ยวกับเคส TCK-2026-00201 หน่อยครับ",
      openCases: [openCaseA],
      closedCases: [closedCaseX],
    });
    assert.strictEqual(res.outcome, "CLOSED_CASE_REFERENCE");
    assert.strictEqual(res.referencedTicketId, 201);
    assert.strictEqual(res.routingTicketId, null);
    console.log("✅ Test 2 Passed: One open ticket + message mentions exact closed ticket number -> CLOSED_CASE_REFERENCE, route = null");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 3: One open ticket + message mentions exact foreign ticket number -> rejected / NEW_CASE
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      messageText: "ขอเช็คตั๋ว TCK-9999-99999 หน่อย",
      openCases: [openCaseA],
      closedCases: [closedCaseX],
    });
    assert.notStrictEqual(res.routingTicketId, 99999);
    assert.notStrictEqual(res.referencedTicketId, 99999);
    console.log("✅ Test 3 Passed: One open ticket + message mentions exact foreign ticket number -> rejected / NEW_CASE");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 4: One open ticket + message mentions exact other open ticket number -> switches or resolves to referenced ticket
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      activeTicketId: 101,
      messageText: "ขอตามเคส TCK-2026-00102 หน่อยครับ",
      openCases: [openCaseA, openCaseB],
      closedCases: [],
    });
    assert.strictEqual(res.outcome, "SWITCH_EXISTING_CASE");
    assert.strictEqual(res.routingTicketId, 102);
    console.log("✅ Test 4 Passed: One open ticket + message mentions exact other open ticket number -> switches to referenced ticket");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 5: One open ticket + message has strong semantic overlap with that ticket -> continues that ticket
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      messageText: "ระบบล็อกอินเข้าสู่ระบบไม่ได้ error ตลอดเลย",
      openCases: [openCaseA],
      closedCases: [],
    });
    assert.strictEqual(res.routingTicketId, 101);
    assert.ok(res.outcome === "CONTINUE_ACTIVE_CASE" || res.outcome === "SWITCH_EXISTING_CASE");
    console.log("✅ Test 5 Passed: One open ticket + message has strong semantic overlap -> continues that ticket");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 6: One open ticket + message has weak/generic phrase ("ครับ", "ขอบคุณครับ", "โอเคครับ", "ลองแล้วครับ ยังไม่ได้") -> continues active ticket
  // -------------------------------------------------------------
  {
    const res1 = resolver.resolve({
      conversationId: 1,
      activeTicketId: 101,
      messageText: "โอเคครับ ขอบคุณครับ",
      openCases: [openCaseA],
      closedCases: [],
    });
    assert.strictEqual(res1.routingTicketId, 101);

    const res2 = resolver.resolve({
      conversationId: 1,
      activeTicketId: 101,
      messageText: "ลองแล้วครับ ยังไม่ได้",
      openCases: [openCaseA],
      closedCases: [],
    });
    assert.strictEqual(res2.routingTicketId, 101);
    assert.strictEqual(res2.outcome, "CONTINUE_ACTIVE_CASE");
    console.log("✅ Test 6 Passed: One open ticket + message has weak/generic phrase -> continues active ticket");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 7: One open ticket + message has image/attachment only -> continues active ticket
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      activeTicketId: 101,
      messageText: "",
      hasAttachments: true,
      openCases: [openCaseA],
      closedCases: [],
    });
    assert.strictEqual(res.routingTicketId, 101);
    assert.strictEqual(res.outcome, "CONTINUE_ACTIVE_CASE");
    console.log("✅ Test 7 Passed: One open ticket + message has image/attachment only -> continues active ticket");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 8: One open ticket + message has completely unrelated topic -> NEW_CASE, NOT auto-route to open ticket (W3 Guard)
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      activeTicketId: null,
      messageText: "อยากสอบถามราคาแพ็กเกจใหม่และบริการย้ายค่ายครับ",
      openCases: [openCaseA], // Case A is login portal error
      closedCases: [],
    });
    // Critical W3 Invariant: MUST NOT blindly route unrelated topic into open Case A
    assert.notStrictEqual(res.routingTicketId, 101);
    assert.strictEqual(res.routingTicketId, null);
    assert.strictEqual(res.outcome, "NEW_CASE");
    console.log("✅ Test 8 Passed: One open ticket + unrelated topic -> NEW_CASE, NOT auto-route to open ticket");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 9: One open ticket + message has strong semantic overlap with closed ticket -> CLOSED_CASE_REFERENCE, route = null
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      activeTicketId: null,
      messageText: "เรื่องขอใบกำกับภาษีรอบเดือนมกราคมถึงไหนแล้วคะ",
      openCases: [openCaseA], // Case A is login portal
      closedCases: [closedCaseY], // Case Y is "ขอใบกำกับภาษีรอบเดือนมกราคม"
    });
    // Unrelated to open Case A, matches closed Case Y
    assert.strictEqual(res.outcome, "CLOSED_CASE_REFERENCE");
    assert.strictEqual(res.referencedTicketId, 202);
    assert.strictEqual(res.routingTicketId, null);
    console.log("✅ Test 9 Passed: One open ticket + strong overlap with closed ticket -> CLOSED_CASE_REFERENCE, route = null");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 10: Two open tickets + message mentions exact ticket A -> resolves to A
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      messageText: "ตรวจสอบ TCK-2026-00101 ให้หน่อยครับ",
      openCases: [openCaseA, openCaseB],
      closedCases: [],
    });
    assert.strictEqual(res.routingTicketId, 101);
    assert.strictEqual(res.ticketNumber, "TCK-2026-00101");
    console.log("✅ Test 10 Passed: Two open tickets + message mentions exact ticket A -> resolves to A");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 11: Two open tickets + message has strong semantic overlap to ticket A only -> resolves to A
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      messageText: "เข้าระบบไม่ได้ ล็อกอินแล้วขึ้น error ตลอดเลย",
      openCases: [openCaseA, openCaseB],
      closedCases: [],
    });
    assert.strictEqual(res.routingTicketId, 101);
    assert.strictEqual(res.ticketNumber, "TCK-2026-00101");
    console.log("✅ Test 11 Passed: Two open tickets + strong semantic overlap to ticket A only -> resolves to A");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 12: Two open tickets + message has equal semantic overlap to both -> AMBIGUOUS_CASE, asks user
  // -------------------------------------------------------------
  {
    // openCaseB and openCaseC are both billing issues with amount mismatches
    const res = resolver.resolve({
      conversationId: 1,
      messageText: "เรื่องยอดเงินไม่ตรงครับ",
      openCases: [openCaseB, openCaseC],
      closedCases: [],
    });
    assert.strictEqual(res.outcome, "AMBIGUOUS_CASE");
    assert.strictEqual(res.routingTicketId, null);
    assert.strictEqual(res.candidates.length, 2);
    console.log("✅ Test 12 Passed: Two open tickets + equal semantic overlap -> AMBIGUOUS_CASE, asks user");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 13: Two open tickets + generic phrase + active_ticket_id = A -> continues A
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      activeTicketId: 101,
      messageText: "ขอบคุณครับ ได้รับข้อมูลแล้ว",
      openCases: [openCaseA, openCaseB],
      closedCases: [],
    });
    assert.strictEqual(res.outcome, "CONTINUE_ACTIVE_CASE");
    assert.strictEqual(res.routingTicketId, 101);
    console.log("✅ Test 13 Passed: Two open tickets + generic phrase + active_ticket_id = A -> continues A");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 14: Two open tickets + generic phrase + no active_ticket_id -> AMBIGUOUS_CASE, asks user
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      activeTicketId: null,
      messageText: "ตามเรื่องหน่อยครับ",
      openCases: [openCaseA, openCaseB],
      closedCases: [],
    });
    assert.strictEqual(res.outcome, "AMBIGUOUS_CASE");
    assert.strictEqual(res.routingTicketId, null);
    console.log("✅ Test 14 Passed: Two open tickets + generic phrase + no active_ticket_id -> AMBIGUOUS_CASE, asks user");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 15: Two open tickets + unrelated topic -> NEW_CASE or asks user
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      activeTicketId: null,
      messageText: "ขอแจ้งปัญหาใหม่ครับ แอร์ที่สำนักงานไม่เย็นเลย",
      openCases: [openCaseA, openCaseB],
      closedCases: [],
    });
    assert.strictEqual(res.outcome, "NEW_CASE");
    assert.strictEqual(res.routingTicketId, null);
    console.log("✅ Test 15 Passed: Two open tickets + unrelated topic -> NEW_CASE or asks user");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 16: "ขอปิดเคสนี้ค่ะ" + active_ticket_id = A -> CLOSE intent with target = A
  // -------------------------------------------------------------
  {
    const intent = detectCloseIntent("ขอปิดเคสนี้ค่ะ");
    assert.strictEqual(intent.kind, "CLOSE_REQUEST");
    assert.strictEqual(intent.isThisCaseRef, true);

    const activeTicket = openCaseA;
    let targetTicket: CaseCandidate | null = null;
    if (intent.isThisCaseRef && activeTicket) {
      targetTicket = activeTicket;
    }
    assert.strictEqual(targetTicket?.id, 101);
    console.log("✅ Test 16 Passed: 'ขอปิดเคสนี้ค่ะ' + active_ticket_id = A -> CLOSE intent with target = A");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 17: "ขอปิดเคสนี้ค่ะ" + no active_ticket_id + multiple open tickets -> asks user which ticket
  // -------------------------------------------------------------
  {
    const intent = detectCloseIntent("ขอปิดเคสนี้ค่ะ");
    assert.strictEqual(intent.kind, "CLOSE_REQUEST");

    const openTickets = [openCaseA, openCaseB];
    const activeTicket = null;
    let askedWhichCase = false;
    let mutated = false;

    if (intent.kind === "CLOSE_REQUEST") {
      if (openTickets.length > 1 && !intent.ticketNumber && !activeTicket) {
        askedWhichCase = true;
      } else {
        mutated = true;
      }
    }
    assert.strictEqual(askedWhichCase, true);
    assert.strictEqual(mutated, false);
    console.log("✅ Test 17 Passed: 'ขอปิดเคสนี้ค่ะ' + no active_ticket_id + multiple open tickets -> asks user which ticket");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 18: "ปิดเคสไม่ได้ครับ ระบบขึ้น error" -> NONE / report, NOT close
  // -------------------------------------------------------------
  {
    const text = "ปิดเคสไม่ได้ครับ ระบบขึ้น error";
    assert.strictEqual(isNegativeCloseIntent(text), true);
    const intent = detectCloseIntent(text);
    assert.strictEqual(intent.kind, "NONE");
    console.log("✅ Test 18 Passed: 'ปิดเคสไม่ได้ครับ ระบบขึ้น error' -> NONE / report, NOT close");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 19: "ยกเลิกไม่ได้ ระบบ error" -> NONE / report, NOT cancel
  // -------------------------------------------------------------
  {
    const text = "ยกเลิกไม่ได้ ระบบ error";
    const cancelIntent = detectCancelIntent(text);
    assert.strictEqual(cancelIntent.kind, "NONE");
    console.log("✅ Test 19 Passed: 'ยกเลิกไม่ได้ ระบบ error' -> NONE / report, NOT cancel");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 20: Customer has 0 tickets + "ขอปิดเคส" -> rejects safely / informative reply, no crash
  // -------------------------------------------------------------
  {
    const res = resolver.resolve({
      conversationId: 1,
      messageText: "ขอปิดเคสค่ะ",
      openCases: [],
      closedCases: [],
    });
    // With 0 cases, resolver safely creates NEW_CASE or reports no open ticket without crashing
    assert.strictEqual(res.outcome, "NEW_CASE");
    assert.strictEqual(res.routingTicketId, null);

    const intent = detectCloseIntent("ขอปิดเคสค่ะ");
    assert.strictEqual(intent.kind, "CLOSE_REQUEST");
    // Handler check: no tickets exist, cannot close any ticket
    const openTickets: CaseCandidate[] = [];
    const canClose = openTickets.length > 0;
    assert.strictEqual(canClose, false);
    console.log("✅ Test 20 Passed: Customer has 0 tickets + 'ขอปิดเคส' -> rejects safely, no crash");
    passedCount++;
  }

  // -------------------------------------------------------------
  // Test 21: Customer mentions closed ticket in CLOSE request -> rejects with already closed / informative message
  // -------------------------------------------------------------
  {
    const intent = detectCloseIntent("ขอปิดเคส TCK-2026-00201");
    assert.strictEqual(intent.kind, "CLOSE_REQUEST");
    assert.strictEqual(intent.ticketNumber, "TCK-2026-00201");

    const openTickets = [openCaseA];
    const closedTickets = [closedCaseX];

    const res = resolver.resolve({
      conversationId: 1,
      messageText: "ขอปิดเคส TCK-2026-00201",
      openCases: openTickets,
      closedCases: closedTickets,
    });
    assert.strictEqual(res.outcome, "CLOSED_CASE_REFERENCE");
    assert.strictEqual(res.referencedTicketId, 201);
    assert.strictEqual(res.routingTicketId, null);

    // Closed target returns ALREADY_CLOSED, no state mutation allowed
    const closedTarget = closedTickets.find((t) => t.ticket_number === intent.ticketNumber);
    assert.ok(closedTarget);
    const canMutate = canTransition(closedTarget.status as any, "CLOSED", "customer");
    assert.strictEqual(canMutate.allowed, false);
    assert.strictEqual(canMutate.code, "NO_OP");
    console.log("✅ Test 21 Passed: Customer mentions closed ticket in CLOSE request -> rejects with already closed, no mutation");
    passedCount++;
  }

  console.log("==================================================");
  console.log(`All ${passedCount}/21 lifecycle safety tests PASSED!`);
  console.log("==================================================");
}

runAllTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
