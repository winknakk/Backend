import assert from "node:assert";
import { CaseResolver } from "../../src/domain/case/CaseResolver";

function testCaseResolver() {
  const resolver = new CaseResolver();

  const openCases = [
    {
      id: 101,
      ticket_number: "TCK-2026-101",
      subject: "ระบบเข้าไม่ได้ เข้าสู่ระบบติดปัญหา",
      summary: "Login failure for portal user",
      status: "OPEN",
      slug: "login-issue",
    },
    {
      id: 102,
      ticket_number: "TCK-2026-102",
      subject: "ยอดเงินในใบแจ้งหนี้ผิดพลาด",
      summary: "Invoice billing discrepancy",
      status: "IN_PROGRESS",
      slug: "invoice-discrepancy",
    },
    {
      id: 103,
      ticket_number: "TCK-2026-103",
      subject: "ยอดเงินในใบเสร็จไม่ถูกต้อง",
      summary: "Another billing discrepancy",
      status: "OPEN",
      slug: "receipt-discrepancy",
    },
  ];

  const closedCases = [
    {
      id: 201,
      ticket_number: "TCK-2026-201",
      subject: "เปลี่ยนที่อยู่จัดส่งเอกสาร",
      summary: "Address changed successfully",
      status: "CLOSED",
      slug: "address-change",
    },
  ];

  // 1. Priority A: Exact ticket number match
  const resExact = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "ตรวจสอบ TCK-2026-102 ให้หน่อยครับ",
    openCases,
    closedCases,
  });
  assert.strictEqual(resExact.intent, "SWITCH_EXISTING_CASE");
  assert.strictEqual(resExact.ticketId, 102);
  assert.strictEqual(resExact.confidence, 1.0);
  console.log("✅ Test 1 Passed: Priority A - Exact ticket number match to Case 102");

  // 2. Priority B: Slug / Legacy identifier match
  const resSlug = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "มีคำถามเกี่ยวกับ invoice-discrepancy ครับ",
    openCases,
    closedCases,
  });
  assert.strictEqual(resSlug.intent, "SWITCH_EXISTING_CASE");
  assert.strictEqual(resSlug.ticketId, 102);
  console.log("✅ Test 2 Passed: Priority B - Slug match to Case 102");

  // 3. Priority B: Ordinal reference ("เรื่องที่สอง")
  const resOrdinal = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "เรื่องที่สองยังติดปัญหาอยู่ครับ",
    openCases,
    closedCases,
  });
  assert.strictEqual(resOrdinal.intent, "SWITCH_EXISTING_CASE");
  assert.strictEqual(resOrdinal.ticketId, 102);
  console.log("✅ Test 3 Passed: Priority B - Ordinal switch to Case 102");

  // 4. Priority C: Strong semantic match ("กลับไปเรื่องใบแจ้งหนี้ครับ")
  const resKeyword = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "กลับไปเรื่องใบแจ้งหนี้ครับ",
    openCases,
    closedCases,
  });
  assert.strictEqual(resKeyword.intent, "SWITCH_EXISTING_CASE");
  assert.strictEqual(resKeyword.ticketId, 102);
  console.log("✅ Test 4 Passed: Priority C - Strong semantic match to Case 102");

  // 5. Priority D: Active case default for short messages ("ยังไม่ได้ครับ")
  const resShort = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "ยังไม่ได้ครับ",
    openCases,
    closedCases,
  });
  assert.strictEqual(resShort.intent, "CONTINUE_ACTIVE_CASE");
  assert.strictEqual(resShort.ticketId, 101);
  assert.ok(resShort.confidence >= 0.9, "Confidence must be high for active case short message");
  console.log("✅ Test 5 Passed: Priority D - Short message continues active Case 101 without asking");

  // 6. Priority D: Image-only message continues active case
  const resImage = resolver.resolve({
    conversationId: 1,
    activeTicketId: 102,
    messageText: "",
    hasAttachments: true,
    imageOnly: true,
    openCases,
    closedCases,
  });
  assert.strictEqual(resImage.intent, "CONTINUE_ACTIVE_CASE");
  assert.strictEqual(resImage.ticketId, 102);
  console.log("✅ Test 6 Passed: Priority D - Image-only continues active Case 102 without asking");

  // 7. Priority E: Ambiguous reference across similar cases ("สลับไปดูเรื่องยอดเงินครับ")
  const resAmbiguous = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "ขอสลับไปดูเรื่องยอดเงินหน่อยครับ",
    openCases,
    closedCases,
  });
  assert.strictEqual(resAmbiguous.intent, "AMBIGUOUS_CASE");
  assert.strictEqual(resAmbiguous.ticketId, null);
  assert.ok(resAmbiguous.candidates && resAmbiguous.candidates.length >= 2);
  assert.ok(resAmbiguous.clarificationPrompt?.includes("กำลังดำเนินการอยู่"));
  console.log("✅ Test 7 Passed: Priority E - Ambiguity detected between cases 102 and 103");

  // 8. Closed Case Reference: "เรื่องเปลี่ยนที่อยู่ครับ" -> CLOSED_CASE_REFERENCE, ticketId = null
  const resClosed = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "ตามเรื่องเปลี่ยนที่อยู่จัดส่งเอกสารครับ",
    openCases,
    closedCases,
  });
  assert.strictEqual(resClosed.intent, "CLOSED_CASE_REFERENCE");
  assert.strictEqual(resClosed.ticketId, null, "Closed case reference MUST set ticketId = null to prevent modification");
  assert.strictEqual(resClosed.ticketNumber, "TCK-2026-201");
  console.log("✅ Test 8 Passed: Closed case reference intercepted with ticketId = null");

  // 9. Priority F: Explicit new case trigger ("+ แจ้งปัญหาใหม่")
  const resNew = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "+ แจ้งปัญหาใหม่",
    openCases,
    closedCases,
  });
  assert.strictEqual(resNew.intent, "NEW_CASE");
  assert.strictEqual(resNew.ticketId, null);
  console.log("✅ Test 9 Passed: Priority F - Explicit new case trigger");

  // 10. Priority F: Clearly unrelated new problem statement
  const resUnrelated = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "อีกเรื่องครับ ตอนนี้เข้า LINE ไม่ได้",
    openCases,
    closedCases,
  });
  assert.strictEqual(resUnrelated.intent, "NEW_CASE");
  console.log("✅ Test 10 Passed: Priority F - Clearly unrelated new problem statement");

  // 11. Priority F: Open new case following up on closed ticket
  const resFollowupNew = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "เปิดเคสใหม่: ติดตามต่อจาก TCK-2026-201",
    openCases,
    closedCases,
  });
  assert.strictEqual(resFollowupNew.intent, "NEW_CASE");
  assert.strictEqual(resFollowupNew.ticketId, null);
  assert.strictEqual(resFollowupNew.initialSubject, "ติดตามต่อจาก TCK-2026-201");
  console.log("✅ Test 11 Passed: Priority F - Open new case following up on closed case");

  // 12. Section 4 Hard Invariant: issue_category is NOT a unique identifier
  // Two tickets share issue_category "LOGIN". Generic message "ยังเข้าไม่ได้ครับ"
  // MUST NOT pick one based solely on category -> AMBIGUOUS_CASE
  const sameCategoryCases = [
    {
      id: 301,
      ticket_number: "TCK-2026-301",
      subject: "เข้าสู่ระบบไม่ได้บนมือถือ",
      summary: "Mobile app login error",
      issue_category: "LOGIN",
      status: "OPEN",
    },
    {
      id: 302,
      ticket_number: "TCK-2026-302",
      subject: "เข้าสู่ระบบไม่ได้บนคอมพิวเตอร์",
      summary: "Desktop portal login error",
      issue_category: "LOGIN",
      status: "OPEN",
    },
  ];
  const resSameCategory = resolver.resolve({
    conversationId: 1,
    activeTicketId: null,
    messageText: "สลับไปเรื่องเข้าไม่ได้ครับ",
    openCases: sameCategoryCases,
    closedCases: [],
  });
  assert.strictEqual(resSameCategory.intent, "AMBIGUOUS_CASE");
  assert.strictEqual(resSameCategory.ticketId, null);
  assert.strictEqual(resSameCategory.candidates?.length, 2);
  console.log("✅ Test 12 Passed: Same category tickets trigger AMBIGUOUS_CASE without arbitrary selection");

  // 13. Strong reference overrides active ticket (Case 102 active -> references login -> switches to Case 101)
  const resSwitchOverride = resolver.resolve({
    conversationId: 1,
    activeTicketId: 102,
    messageText: "กลับไปเรื่องเข้าสู่ระบบครับ",
    openCases,
    closedCases,
  });
  assert.strictEqual(resSwitchOverride.intent, "SWITCH_EXISTING_CASE");
  assert.strictEqual(resSwitchOverride.ticketId, 101);
  console.log("✅ Test 13 Passed: Strong reference overrides active case (102 -> 101)");

  // 14. Decoupled referencedTicketId on closed case reference
  const resClosedDecoupled = resolver.resolve({
    conversationId: 1,
    activeTicketId: 101,
    messageText: "สอบถามสถานะ TCK-2026-201 หน่อยครับ",
    openCases,
    closedCases,
  });
  assert.strictEqual(resClosedDecoupled.intent, "CLOSED_CASE_REFERENCE");
  assert.strictEqual(resClosedDecoupled.ticketId, null, "routing ticketId must be null");
  assert.strictEqual(resClosedDecoupled.referencedTicketId, 201, "referencedTicketId must decouple to 201");
  console.log("✅ Test 14 Passed: Decoupled referencedTicketId on closed case reference");

  // 15. Recent Context Resolution (P4)
  const resRecentContext = resolver.resolve({
    conversationId: 1,
    activeTicketId: null,
    messageText: "ขอส่งข้อมูลเพิ่มตามที่คุยกันครับ",
    openCases,
    closedCases,
    recentMessages: [
      { id: 1, role: "customer", content: "สอบถามใบกำกับภาษี", ticket_id: 102 },
      { id: 2, role: "ai", content: "รบกวนส่งรูปหรือเลขประจำตัวผู้เสียภาษีค่ะ", ticket_id: 102 },
    ],
  });
  assert.strictEqual(resRecentContext.intent, "SWITCH_EXISTING_CASE");
  assert.strictEqual(resRecentContext.ticketId, 102);
  console.log("✅ Test 15 Passed: P4 Recent-context resolved ticket 102 from conversational history");

  // 16. Generic topic words ("เคสด่วนมาก", "ปัญหาใหม่") never select a case (live defect 2026-09-17)
  const resGenericTopic = resolver.resolve({
    conversationId: 1,
    activeTicketId: null,
    messageText: "ขอแก้อาการเป็น เข้าใช้งานไม่ได้เลย และเป็นเคสด่วนมากครับ",
    openCases: [],
    closedCases: [
      { id: 301, ticket_number: "TCK-2026-301", subject: "ระบบเว็บไซต์ - 401 Unauthorized เข้าใช้งานไม่ได้", summary: "เข้าใช้งานเว็บไซต์ไม่ได้ เป็นเรื่องด่วนมาก", status: "CLOSED" },
    ],
  });
  assert.strictEqual(resGenericTopic.intent, "NEW_CASE", "urgency word must not reference the closed case");
  assert.ok(!resGenericTopic.evidence.some((e) => e.startsWith("EXPLICIT_TOPIC_MATCH")), resGenericTopic.evidence.join(", "));
  console.log("✅ Test 16 Passed: Generic topic word after 'เคส' is not an explicit topic match");

  // 17-21. Live defect 2026-09-18 (conversation 99961): "แล้วเรื่องระบบล่ะคะ" with
  // active case 731 continued 731 (P3) instead of asking; both subjects start
  // with "ระบบ", so the topic identifies neither.
  const liveOpen = [
    { id: 731, ticket_number: "TCK-2026-86186", subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก", summary: "ลูกค้าแจ้งว่าไม่สามารถเข้าใช้งานระบบเว็บไซต์ได้และระบุเป็นเคสด่วนมาก", status: "TRIAGED" },
    { id: 732, ticket_number: "TCK-2026-73046", subject: "ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ", summary: "ลูกค้าต้องการเปลี่ยนสถานะใบเสร็จเล่มที่ 05 จากชำระแล้วเป็นค้างชำระ", status: "TRIAGED" },
  ];
  const resTopicShift = resolver.resolve({ conversationId: 99961, activeTicketId: 731, messageText: "แล้วเรื่องระบบล่ะคะ มีใครดูให้หรือยัง", openCases: liveOpen, closedCases: [] });
  assert.strictEqual(resTopicShift.intent, "AMBIGUOUS_CASE", resTopicShift.reason);
  assert.deepStrictEqual(resTopicShift.candidates, [731, 732]);
  console.log("✅ Test 17 Passed: 'แล้วเรื่องระบบล่ะคะ' with an active case asks (topic fits both cases)");

  const resTopicOne = resolver.resolve({ conversationId: 99961, activeTicketId: 732, messageText: "เรื่องระบบเว็บไซต์ล่ะคะ มีใครดูให้หรือยัง", openCases: liveOpen, closedCases: [] });
  assert.strictEqual(resTopicOne.intent, "SWITCH_EXISTING_CASE", resTopicOne.reason);
  assert.strictEqual(resTopicOne.ticketId, 731);
  console.log("✅ Test 18 Passed: a topic naming exactly one case switches to it despite the active case");

  const resTopicNone = resolver.resolve({ conversationId: 99961, activeTicketId: 731, messageText: "แล้วเรื่องอีเมลล่ะคะ", openCases: liveOpen, closedCases: [] });
  assert.strictEqual(resTopicNone.intent, "AMBIGUOUS_CASE", resTopicNone.reason);
  assert.ok(resTopicNone.reason.startsWith("TOPIC_SHIFT_UNRESOLVED"), resTopicNone.reason);
  console.log("✅ Test 19 Passed: a shifted topic that fits no open case asks instead of guessing the active case");

  const resPlainFollowUp = resolver.resolve({ conversationId: 99961, activeTicketId: 731, messageText: "ปัญหาระบบยังไม่หายครับ", openCases: liveOpen, closedCases: [] });
  assert.strictEqual(resPlainFollowUp.intent, "CONTINUE_ACTIVE_CASE", resPlainFollowUp.reason);
  assert.strictEqual(resPlainFollowUp.ticketId, 731);
  const resShortLive = resolver.resolve({ conversationId: 99961, activeTicketId: 731, messageText: "ยังไม่ได้ครับ", openCases: liveOpen, closedCases: [] });
  assert.strictEqual(resShortLive.intent, "CONTINUE_ACTIVE_CASE");
  console.log("✅ Test 20 Passed: follow-ups without a topic shift still continue the active case (never ask every time)");

  const resSingleOpen = resolver.resolve({ conversationId: 99961, activeTicketId: 731, messageText: "แล้วเรื่องระบบล่ะคะ มีใครดูให้หรือยัง", openCases: [liveOpen[0]], closedCases: [] });
  assert.strictEqual(resSingleOpen.intent, "CONTINUE_ACTIVE_CASE", resSingleOpen.reason);
  console.log("✅ Test 21 Passed: with a single open case there is nothing to disambiguate");

  console.log("\nAll 21 CaseResolver unit tests passed!\n");
}

testCaseResolver();
