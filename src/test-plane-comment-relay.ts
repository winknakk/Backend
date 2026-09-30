/**
 * Demo 2.5 — Plane comment "@ลูกค้า …" → customer's LINE; everything else
 * stays an internal note. Pure: fake HTTP client, fake notifier, fixed clock.
 *
 *   npx tsx src/test-plane-comment-relay.ts
 */
import { CustomerNotificationService } from "./services/CustomerNotificationService";
import { PlaneCommentRelay, customerMessageFromComment, planeCommentText, commentsFromResponse } from "./services/PlaneCommentRelay";

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "ผ่าน" : "พลาด"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}

async function main() {
  console.log("\nC1 — which comments are for the customer");
  check("C1a '@ลูกค้า …' → message without the marker", customerMessageFromComment({ comment_stripped: "@ลูกค้า แก้ไขเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ" }) === "แก้ไขเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ");
  check("C1b '@ ลูกค้า:' and '@customer -' work too", customerMessageFromComment({ comment_stripped: "@ ลูกค้า: ลองใหม่ได้เลยค่ะ" }) === "ลองใหม่ได้เลยค่ะ" && customerMessageFromComment({ comment_stripped: "@Customer - fixed" }) === "fixed");
  check("C1c internal note → null", customerMessageFromComment({ comment_stripped: "น่าจะเป็นบั๊กโค้ดส่วน X" }) === null);
  check("C1d marker in the middle does not count", customerMessageFromComment({ comment_stripped: "ฝากบอก @ลูกค้า ด้วย" }) === null);
  check("C1e marker only → null", customerMessageFromComment({ comment_stripped: "@ลูกค้า   " }) === null);
  check("C1f bot's own comments never relay", customerMessageFromComment({ comment_html: "<p><strong>✅ ลูกค้ายืนยันปิดเคส · TCK-2026-10001</strong></p><p>ข้อความลูกค้า: \"@ลูกค้า\"</p>" }) === null);
  check(
    "C1g HTML-only comment is read (tags, <br>, entities)",
    planeCommentText({ comment_html: "<p>@ลูกค้า แก้แล้ว &amp; ทดสอบแล้ว<br>ลองใหม่ได้เลยค่ะ</p>" }) === "@ลูกค้า แก้แล้ว & ทดสอบแล้ว\nลองใหม่ได้เลยค่ะ"
  );
  check("C1h list shapes: array and {results}", commentsFromResponse([{ id: "a" }]).length === 1 && commentsFromResponse({ results: [{ id: "a" }, { id: "b" }] }).length === 2 && commentsFromResponse({}).length === 0);

  console.log("\nC2 — what the customer sees");
  const svc = new CustomerNotificationService() as any;
  const body = svc.body("team_comment", "TCK-2026-62090", "k", null, "แก้ไขเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ", null);
  check("C2a '💬 ข้อความจากทีมงาน (TCK)' + the engineer's words", body === "💬 ข้อความจากทีมงาน (TCK-2026-62090)\nแก้ไขเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ", JSON.stringify(body));

  console.log("\nC3 — relay against a fake Plane");
  const NOW = Date.parse("2026-09-30T10:00:00Z");
  let clock = NOW;
  const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
  let listing: any = {
    results: [
      { id: "c1", comment_stripped: "@ลูกค้า แก้ไขเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ", created_at: iso(5) },
      { id: "c2", comment_stripped: "เช็ค log แล้ว น่าจะเป็น DB lock", created_at: iso(4) },
      { id: "c0", comment_stripped: "@ลูกค้า ข้อความเก่าเมื่อวานซืน", created_at: iso(60 * 30) },
    ],
  };
  let status: number | null = null;
  const urls: string[] = [];
  const http = {
    get: async (url: string) => {
      urls.push(url);
      if (status) throw Object.assign(new Error("HTTP " + status), { response: { status, headers: { "retry-after": "30" } } });
      return { data: listing };
    },
  } as any;
  const ledger = new Set<string>();
  const sent: any[] = [];
  const notifier = {
    send: async (req: any) => {
      const key = `${req.notificationType}|${req.idempotencyKey}`;
      if (ledger.has(key)) return { sent: false, duplicate: true };
      ledger.add(key);
      sent.push(req);
      return { sent: true };
    },
  } as any;
  const relay = new PlaneCommentRelay(http, notifier, () => clock);
  const ticket = { id: 1, ticket_number: "TCK-2026-62090", conversation_id: 55, project_id: 1, org_id: "org" };
  const target = { apiBase: "https://plane.test", workspaceSlug: "ws", planeProjectId: "pp", issueId: "iss", apiKey: "k" };

  let r = await relay.relay(ticket, target);
  check("C3a only the fresh '@ลูกค้า' comment is sent", r.sent === 1 && sent.length === 1 && sent[0].detail === "แก้ไขเซิร์ฟเวอร์เรียบร้อยแล้วค่ะ" && sent[0].notificationType === "team_comment" && sent[0].conversationId === 55, JSON.stringify(sent));
  check("C3b idempotency key is the Plane comment id", sent[0].idempotencyKey === "plane_comment:c1");
  check("C3c GETs the issue's comments endpoint", urls[0] === "https://plane.test/api/v1/workspaces/ws/projects/pp/issues/iss/comments/", urls[0]);

  r = await relay.relay(ticket, target);
  check("C3d a second poll within 60 s makes no request", !r.checked && urls.length === 1);

  clock += 61_000;
  listing.results.push({ id: "c3", comment_stripped: "@ลูกค้า ลองใช้งานได้เลยค่ะ", created_at: new Date(clock - 10_000).toISOString() });
  r = await relay.relay(ticket, target);
  check("C3e next poll: only the new comment goes out (no duplicate of c1)", r.sent === 1 && sent.length === 2 && sent[1].idempotencyKey === "plane_comment:c3", JSON.stringify(sent.map((s) => s.idempotencyKey)));

  r = await relay.relay({ ...ticket, id: 2, conversation_id: null }, target);
  check("C3f a ticket with no conversation is skipped without a request", !r.checked && urls.length === 2);

  clock += 61_000;
  status = 429;
  r = await relay.relay(ticket, target);
  check("C3g Plane 429 is reported for the poller to back off", r.rateLimited === true && r.retryAfterMs === 30_000 && r.sent === 0);

  console.log(`\n${passes} ผ่าน, ${failures} พลาด`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
