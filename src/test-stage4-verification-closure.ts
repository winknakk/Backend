/**
 * Stage 4 Verification & Case Closure Unit Tests
 * Run with: npx tsx src/test-stage4-verification-closure.ts
 */
import assert from "node:assert/strict";
import {
  detectConfirmationIntent,
  detectCloseIntent,
  evaluateFailureScope,
} from "./domain/ticket/CustomerConfirmation";
import {
  canTransition,
  lifecycleToPlaneStatus,
  planeStatusToLifecycle,
} from "./domain/ticket/TicketLifecycle";
import { CustomerNotificationService } from "./services/CustomerNotificationService";

const TCK = "TCK-2026-91111";

console.log("Starting Stage 4 Verification & Case Closure Tests...\n");

// --- 1. Customer Verification Intent (Pass vs Fail) ---
// Pass variants
assert.equal(detectConfirmationIntent("ผ่านค่ะ"), "CONFIRMED");
assert.equal(detectConfirmationIntent("ผ่านแล้ว"), "CONFIRMED");
assert.equal(detectConfirmationIntent("ทดสอบผ่านเรียบร้อยค่ะ"), "CONFIRMED");
assert.equal(detectConfirmationIntent("ใช้งานได้แล้ว"), "CONFIRMED");
assert.equal(detectConfirmationIntent(`ใช้งานได้แล้ว ${TCK}`), "CONFIRMED");
assert.equal(detectConfirmationIntent("ok ผ่าน"), "CONFIRMED");

// Fail variants
assert.equal(detectConfirmationIntent("ไม่ผ่านค่ะ"), "REJECTED");
assert.equal(detectConfirmationIntent("ยังไม่ผ่าน"), "REJECTED");
assert.equal(detectConfirmationIntent("เทสไม่ผ่าน"), "REJECTED");
assert.equal(detectConfirmationIntent("ยังมีปัญหาอยู่"), "REJECTED");
assert.equal(detectConfirmationIntent(`ยังมีปัญหาอยู่ ${TCK}`), "REJECTED");
assert.equal(detectConfirmationIntent("ยังกดปุ่มไม่ได้เหมือนเดิม"), "REJECTED");
console.log("✅ 1. Customer verification intent (Pass/Fail) assertions passed.");

// --- 2. Failure Scope Classification (Same Bug vs New Bug) ---
// Same Bug (Original issue still persisting)
assert.equal(
  evaluateFailureScope("ยังกดปุ่มบันทึกไม่ได้เหมือนเดิมค่ะ"),
  "SAME_BUG"
);
assert.equal(
  evaluateFailureScope("ยังเข้าไม่ได้เลย ขึ้น error 500 จุดเดิม"),
  "SAME_BUG"
);
assert.equal(
  evaluateFailureScope("ไม่ผ่านค่ะ อาการยังไม่หาย"),
  "SAME_BUG"
);

// New Bug (Out of scope / separate issue)
assert.equal(
  evaluateFailureScope("อันเดิมหายแล้วแต่พอเปิดหน้ารายงานกลับเจอ error"),
  "NEW_BUG"
);
assert.equal(
  evaluateFailureScope("จุดเดิมได้แล้วแต่ไปเจออีกจุดหนึ่งเข้าไม่ได้"),
  "NEW_BUG"
);
assert.equal(
  evaluateFailureScope("อันนี้ผ่านแล้วค่ะ แต่มีปัญหาใหม่อยากให้ช่วยดูอีกหน้า"),
  "NEW_BUG"
);
assert.equal(
  evaluateFailureScope("เรื่องเดิมเรียบร้อยแล้วค่ะ แต่พบปัญหาใหม่ที่เมนูอื่น"),
  "NEW_BUG"
);
console.log("✅ 2. Failure Scope Classification (Same Bug vs New Bug) passed.");

// --- 3. Two-Step Close Protocol ---
// In step 1 (does it work now?):
assert.equal(detectConfirmationIntent("ผ่านแล้ว"), "CONFIRMED");

// In step 2 (close question is pending):
assert.equal(detectCloseIntent("ยืนยัน", true).kind, "CONFIRM_CLOSE");
assert.equal(detectCloseIntent(`ยืนยันปิดเคส ${TCK}`).kind, "CONFIRM_CLOSE");
assert.equal(detectCloseIntent("ผ่านแล้ว", true).kind, "CONFIRM_CLOSE");
assert.equal(detectCloseIntent("ยังไม่ปิด", true).kind, "DECLINE_CLOSE");
assert.equal(detectCloseIntent("ไม่ผ่าน", true).kind, "DECLINE_CLOSE");
console.log("✅ 3. Two-step close protocol assertions passed.");

// --- 4. Plane Status Mapping in Stage 3 & Stage 4 ---
assert.equal(planeStatusToLifecycle("Customer Test", "IN_PROGRESS"), "RESOLVED");
assert.equal(planeStatusToLifecycle("Delivery to Customer", "IN_PROGRESS"), "RESOLVED");
assert.equal(planeStatusToLifecycle("Waiting for Customer", "IN_PROGRESS"), "RESOLVED");
assert.equal(planeStatusToLifecycle("AppSup Test", "IN_PROGRESS"), "WAITING_INTERNAL");
assert.equal(planeStatusToLifecycle("Test Failed", "TRIAGED"), "IN_PROGRESS");

// Outbound Plane Status
assert.equal(lifecycleToPlaneStatus("RESOLVED"), "Delivery to Customer");
assert.equal(lifecycleToPlaneStatus("CUSTOMER_CONFIRMED"), "Delivery to Customer");
assert.equal(lifecycleToPlaneStatus("CLOSED"), "Close");
assert.equal(lifecycleToPlaneStatus("REOPENED"), "Re-Open");
console.log("✅ 4. Plane bidirectional status mapping passed.");

// --- 5. Valid Transitions for Actors ---
// Customer hops in Stage 4
assert.equal(canTransition("RESOLVED", "CUSTOMER_CONFIRMED", "customer").allowed, true);
assert.equal(canTransition("CUSTOMER_CONFIRMED", "CLOSED", "customer").allowed, true);
assert.equal(canTransition("RESOLVED", "REOPENED", "customer").allowed, true);

// System transitions
assert.equal(canTransition("REOPENED", "IN_PROGRESS", "system").allowed, true);

// Plane cannot close on behalf of customer
assert.equal(canTransition("RESOLVED", "CLOSED", "plane").allowed, false);
assert.equal(canTransition("CUSTOMER_CONFIRMED", "CLOSED", "plane").allowed, false);

console.log("✅ 5. Actor transitions and two-step safety verified.");

// --- 6. Quick Replies Check ---
const resolutionChips = CustomerNotificationService.defaultQuickReplies("resolution_confirmation", TCK);
assert.deepEqual(resolutionChips.map((c) => c.text), [`ใช้งานได้แล้ว ${TCK}`, `ยังมีปัญหาอยู่ ${TCK}`]);
assert.ok(resolutionChips[0].label.includes("ผ่าน"), "Chip label must indicate pass");
assert.ok(resolutionChips[1].label.includes("ไม่ผ่าน"), "Chip label must indicate fail");

console.log("✅ 6. Quick Reply chips format verified.\n");
console.log("🎉 ALL STAGE 4 VERIFICATION & CLOSURE UNIT TESTS PASSED SUCCESSFULLY!");
