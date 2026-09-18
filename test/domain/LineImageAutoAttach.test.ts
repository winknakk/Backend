/**
 * Standalone LINE screenshot → the case just opened (2026-09-17): the pure
 * window and decision rules of LineImageAutoAttachService.
 */
import assert from "node:assert/strict";
import { decideAutoAttach, isWithinAutoAttachWindow } from "../../src/services/LineImageAutoAttachService";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err: any) {
    console.error(`❌ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const NOW = Date.parse("2026-09-17T09:41:14Z"); // the screenshot in the live example
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

check("W-01 inside the window (case opened 4 min ago, window 60)", () => {
  assert.equal(isWithinAutoAttachWindow(minutesAgo(4), 60, NOW), true);
  assert.equal(isWithinAutoAttachWindow(minutesAgo(59), 60, NOW), true);
});

check("W-02 outside the window, disabled window, bad dates", () => {
  assert.equal(isWithinAutoAttachWindow(minutesAgo(61), 60, NOW), false);
  assert.equal(isWithinAutoAttachWindow(minutesAgo(4), 0, NOW), false);
  assert.equal(isWithinAutoAttachWindow(null, 60, NOW), false);
  assert.equal(isWithinAutoAttachWindow("not a date", 60, NOW), false);
});

check("D-01 live example: focus case TCK-2026-73046 opened 3m43s earlier, Plane-linked → attach", () => {
  const target = { id: 732, ticket_number: "TCK-2026-73046", subject: "ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ", plane_issue_id: "581e9fb3-c82f-4459-a765-98f7407a8fa4", created_at: "2026-09-17T09:37:31.413Z" };
  assert.equal(decideAutoAttach(target, 60, NOW), "attach");
});

check("D-02 focus case not yet promoted → pending_promotion (promotion collects the image)", () => {
  const target = { id: 1, ticket_number: "TCK-2026-00001", subject: "x", plane_issue_id: null, created_at: minutesAgo(1) };
  assert.equal(decideAutoAttach(target, 60, NOW), "pending_promotion");
  assert.equal(decideAutoAttach({ ...target, plane_issue_id: "mock-1" }, 60, NOW), "pending_promotion");
});

check("D-03 no focus case, or focus case older than the window → skip (ask-first path)", () => {
  assert.equal(decideAutoAttach(null, 60, NOW), "skip");
  const old = { id: 2, ticket_number: "TCK-2026-00002", subject: "x", plane_issue_id: "abc", created_at: minutesAgo(90) };
  assert.equal(decideAutoAttach(old, 60, NOW), "skip");
  assert.equal(decideAutoAttach(old, 120, NOW), "attach");
});

console.log(`\n${passed} checks passed${process.exitCode ? ", with failures" : ""}`);
