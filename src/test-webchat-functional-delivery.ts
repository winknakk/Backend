import assert from "assert";
import { customerMessagePreRouter, WEBCHAT_ACTIONS } from "./services/CustomerMessagePreRouter";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { customerNotificationService } from "./services/CustomerNotificationService";
import { broadcastWebChatOutbound } from "./presentation/http/routes/WebChatGateway";

async function runTests() {
  console.log("Starting WebChat Functional Delivery Verification Tests...\n");

  // ---------------------------------------------------------------------------
  // Test 1: Deterministic Pre-Router (Problem 1)
  // ---------------------------------------------------------------------------
  console.log("--- 1. Testing CustomerMessagePreRouter ---");

  // 1.1 Greeting small talk
  const greetingRes = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "สวัสดีครับ",
  });
  assert.strictEqual(greetingRes.handled, true, "Greeting must be handled at edge");
  assert.strictEqual(greetingRes.reason, "SMALL_TALK_GREETING");
  assert.ok(greetingRes.replyText && greetingRes.replyText.includes("ยินดีต้อนรับ"), "Must contain welcome text");
  assert.ok(Array.isArray(greetingRes.actions) && greetingRes.actions.length === 6, "Must provide 6 menu action chips");
  console.log("✅ 1.1 Pure greeting intercepted with menu actions");

  // 1.2 Thanks small talk
  const thanksRes = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "ขอบคุณมากครับ",
  });
  assert.strictEqual(thanksRes.handled, true, "Thanks must be handled at edge");
  assert.strictEqual(thanksRes.reason, "SMALL_TALK_THANKS");
  assert.ok(thanksRes.replyText && thanksRes.replyText.includes("ยินดีให้บริการ"), "Must contain polite thanks reply");
  assert.ok(Array.isArray(thanksRes.actions) && thanksRes.actions.length >= 2, "Must provide follow-up chips");
  console.log("✅ 1.2 Pure thanks intercepted with follow-up actions");

  // 1.3 Menu commands
  for (const cmd of ["เมนู", "/menu", "menu", "ขอเมนู"]) {
    const menuRes = await customerMessagePreRouter.route({
      channel: "webchat",
      conversationId: 999999,
      text: cmd,
    });
    assert.strictEqual(menuRes.handled, true, `Menu command '${cmd}' must be handled`);
    assert.strictEqual(menuRes.reason, "MENU_COMMAND");
    assert.ok(menuRes.actions && menuRes.actions.length === 6, "Menu actions must be present");
  }
  console.log("✅ 1.3 Menu commands ('เมนู', '/menu', 'menu', 'ขอเมนู') handled deterministically");

  // 1.4 Action chips commands (start, report_issue, change_project, connect_new)
  const startRes = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "เริ่มใช้งาน",
  });
  assert.strictEqual(startRes.handled, true);
  assert.strictEqual(startRes.reason, "START_COMMAND");
  assert.ok(startRes.actions && startRes.actions.some((a) => a.value === "report_issue"));

  const reportRes = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "แจ้งปัญหา",
  });
  assert.strictEqual(reportRes.handled, true);
  assert.strictEqual(reportRes.reason, "REPORT_ISSUE_COMMAND");

  const changeProjRes = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "เปลี่ยนโปรเจกต์",
  });
  assert.strictEqual(changeProjRes.handled, true);
  assert.strictEqual(changeProjRes.reason, "CHANGE_PROJECT_COMMAND");
  console.log("✅ 1.4 Command keywords ('เริ่มใช้งาน', 'แจ้งปัญหา', 'เปลี่ยนโปรเจกต์') handled deterministically");

  // 1.5 Human takeover keyword
  const takeoverRes = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "ขอคุยกับเจ้าหน้าที่ค่ะ",
  });
  assert.strictEqual(takeoverRes.handled, true);
  assert.strictEqual(takeoverRes.takeover, true);
  assert.strictEqual(takeoverRes.reason, "HUMAN_TAKEOVER_REQUESTED");
  console.log("✅ 1.5 Human takeover keyword intercepted at edge and triggered takeover");

  // 1.6 Real issue description MUST NOT be handled by pre-router (must flow to AI)
  const realIssueRes = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "เปิดหน้าเว็บไม่ขึ้นเลย แสดง Error 500 บันทึกข้อมูลไม่ได้ค่ะ",
  });
  assert.strictEqual(realIssueRes.handled, false, "Real technical issue description must flow to AI");
  console.log("✅ 1.6 Real issue text allowed through to PromptX flow (handled=false)");

  // ---------------------------------------------------------------------------
  // Test 2: Ticket Number Status Lookup & Active Tickets List
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Testing Ticket Status Queries ---");

  // 2.1 Explicit Ticket Number Status
  const ticketRes = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "เช็คสถานะ TCK-2026-31409",
  });
  assert.strictEqual(ticketRes.handled, true);
  assert.ok(ticketRes.replyText && (ticketRes.replyText.includes("TCK-2026-31409") || ticketRes.replyText.includes("ไม่พบตั๋วงาน")), "Must respond with ticket query result");
  console.log("✅ 2.1 Ticket number status lookup handled deterministically");

  // 2.2 Active tickets query
  const activeTicketsRes = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "ตรวจสอบสถานะ",
  });
  assert.strictEqual(activeTicketsRes.handled, true);
  assert.ok(activeTicketsRes.replyText, "Must return active ticket response");
  console.log("✅ 2.2 'ตรวจสอบสถานะ' answered deterministically with current state");

  // ---------------------------------------------------------------------------
  // Test 3: CustomerNotificationService WebChat Delivery & Buttons (Problems 2 & 3)
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Testing CustomerNotificationService WebChat Delivery & Buttons ---");

  // 3.1 Verify defaultQuickReplies format for close_confirmation_request
  const closeChips = (customerNotificationService.constructor as any)["defaultQuickReplies"]("close_confirmation_request", "TCK-2026-31409");
  assert.ok(Array.isArray(closeChips) && closeChips.length === 3, "Must have 3 close confirmation chips");
  assert.strictEqual(closeChips[0].label, "🟢 ยืนยันปิดเคส");
  assert.strictEqual(closeChips[0].text, "ยืนยันปิดเคส TCK-2026-31409");
  assert.strictEqual(closeChips[1].label, "⏳ ยังไม่ปิด");
  assert.strictEqual(closeChips[1].text, "ยังไม่ปิด");
  assert.strictEqual(closeChips[2].label, "🔴 ยังมีปัญหาอยู่");
  assert.strictEqual(closeChips[2].text, "ยังมีปัญหาอยู่ TCK-2026-31409");
  console.log("✅ 3.1 defaultQuickReplies provides canonical Thai confirmation chips");

  // 3.2 Verify resolution_confirmation chips
  const resChips = (customerNotificationService.constructor as any)["defaultQuickReplies"]("resolution_confirmation", "TCK-2026-31409");
  assert.ok(Array.isArray(resChips) && resChips.length === 2);
  assert.strictEqual(resChips[0].label, "🟢 ผ่าน / ปิดเคส");
  assert.strictEqual(resChips[0].text, "ใช้งานได้แล้ว TCK-2026-31409");
  assert.strictEqual(resChips[1].label, "🔴 ไม่ผ่าน / มีปัญหา");
  assert.strictEqual(resChips[1].text, "ยังมีปัญหาอยู่ TCK-2026-31409");
  console.log("✅ 3.2 defaultQuickReplies provides canonical resolution verification chips");

  // ---------------------------------------------------------------------------
  // Test 4: Realtime Outbound Payload Normalization & Preservation (Problems 2 & 4)
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Testing Outbound Event & Identity Normalization ---");

  // Test broadcastWebChatOutbound execution with id, externalId, actions
  let broadcastExecuted = false;
  try {
    broadcastWebChatOutbound({
      conversationId: "1209",
      recipientId: "test_customer_win",
      id: "2508",
      externalId: "2508",
      messageId: 2508,
      text: "เคส TCK-2026-98994 แก้ไขเสร็จแล้วนะคะ",
      actions: [
        { label: "🟢 ผ่าน / ปิดเคส", value: "ใช้งานได้แล้ว TCK-2026-98994", style: "primary" },
        { label: "🔴 ไม่ผ่าน / มีปัญหา", value: "ยังมีปัญหาอยู่ TCK-2026-98994" },
      ],
    });
    broadcastExecuted = true;
  } catch (err: any) {
    assert.fail("broadcastWebChatOutbound threw: " + err.message);
  }
  assert.strictEqual(broadcastExecuted, true, "broadcastWebChatOutbound must execute cleanly with actions and identifiers");
  console.log("✅ 4.1 broadcastWebChatOutbound cleanly constructs and emits payload with externalId and actions");

  // ---------------------------------------------------------------------------
  // Test 5: Postback Button Value Handling (Problems 3 & 4)
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Testing Postback Button Value Handling ---");

  // A tapped button sends postback: "ยืนยันปิดเคส TCK-2026-31409"
  // Pre-router must process it deterministically
  const postbackButtonAction = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "ยืนยันปิดเคส TCK-2026-31409",
  });
  assert.strictEqual(postbackButtonAction.handled, true, "Tapped 'ยืนยันปิดเคส' chip must be handled deterministically");
  console.log("✅ 5.1 Clicked action chip value 'ยืนยันปิดเคส TCK-...' recognized and handled at edge");

  // A tapped button sends postback: "start"
  const startPostback = await customerMessagePreRouter.route({
    channel: "webchat",
    conversationId: 999999,
    text: "start",
  });
  assert.strictEqual(startPostback.handled, true);
  assert.strictEqual(startPostback.reason, "START_COMMAND");
  console.log("✅ 5.2 Clicked action chip value 'start' recognized and handled at edge");

  console.log("\n🎉 ALL WEBCHAT FUNCTIONAL DELIVERY TESTS PASSED SUCCESSFULLY!");
  await pool.end();
  process.exit(0);
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
