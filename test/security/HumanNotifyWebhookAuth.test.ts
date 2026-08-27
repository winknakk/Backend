import assert from "assert";
import crypto from "crypto";
import { describe, it, beforeEach } from "node:test";

/**
 * /api/v1/webhooks/human_notify was reachable with no credential at all.
 *
 * The route sits in authHook's PUBLIC_ROUTES under the /api/v1/webhooks prefix,
 * on the strength of a comment claiming that prefix was HMAC-verified. It was
 * not: webhookSignatureHook matched the exact string "/webhook/message" and
 * nothing else. A POST carrying only a conversationId forced that conversation
 * into human takeover, alerted every operator on the project, and dispatched a
 * real SMS.
 *
 * These tests pin both halves of the fix: that the route is now checked, and
 * that the check stays permissive until STRICT_WEBHOOK_AUTH is set — because
 * the published Main AI Core flow sends no credential, and enforcing before it
 * is updated would take human takeover offline.
 */

import { webhookSignatureHook } from "../../src/middleware/webhookSignature";
import { config } from "../../src/config/env";

// The hook reads both values from config at call time, so the test drives them
// there directly rather than through the environment — which is already parsed
// by the time this module runs.
const SECRET = "test-webhook-secret-value";
(config as any).WEBHOOK_SECRET = SECRET;

const HUMAN_NOTIFY = "/api/v1/webhooks/human_notify";
const BODY = { conversationId: "301", content: "ขอคุยกับเจ้าหน้าที่ครับ" };

type Outcome = { statusCode: number | null; payload: any };

function fakeRequest(url: string, headers: Record<string, string> = {}, body: any = BODY) {
  return { method: "POST", url, headers, body, ip: "203.0.113.7" } as any;
}

function fakeReply(out: Outcome) {
  const reply: any = {
    status(code: number) {
      out.statusCode = code;
      return reply;
    },
    send(payload: any) {
      out.payload = payload;
      return reply;
    },
  };
  return reply;
}

async function run(url: string, headers: Record<string, string> = {}, body: any = BODY): Promise<Outcome> {
  const out: Outcome = { statusCode: null, payload: null };
  await webhookSignatureHook(fakeRequest(url, headers, body), fakeReply(out));
  return out;
}

function hmacOf(body: any): string {
  return crypto.createHmac("sha256", SECRET).update(JSON.stringify(body)).digest("hex");
}

function setStrict(enabled: boolean) {
  (config as any).STRICT_WEBHOOK_AUTH = enabled;
}

describe("human_notify webhook authentication", () => {
  beforeEach(() => setStrict(false));

  describe("permissive mode (STRICT_WEBHOOK_AUTH off) — the rollout default", () => {
    it("allows an unsigned request so the published flow keeps working", async () => {
      const out = await run(HUMAN_NOTIFY);
      assert.strictEqual(out.statusCode, null, "unsigned request must not be rejected while permissive");
    });

    it("allows a request whose shared secret is wrong, rather than failing the flow mid-migration", async () => {
      const out = await run(HUMAN_NOTIFY, { "x-webhook-secret": "not-the-secret" });
      assert.strictEqual(out.statusCode, null);
    });

    it("still accepts a correct shared secret", async () => {
      const out = await run(HUMAN_NOTIFY, { "x-webhook-secret": SECRET });
      assert.strictEqual(out.statusCode, null);
    });
  });

  describe("strict mode (STRICT_WEBHOOK_AUTH on)", () => {
    beforeEach(() => setStrict(true));

    it("rejects a request with no credential", async () => {
      const out = await run(HUMAN_NOTIFY);
      assert.strictEqual(out.statusCode, 403);
    });

    it("rejects a wrong shared secret", async () => {
      const out = await run(HUMAN_NOTIFY, { "x-webhook-secret": "not-the-secret" });
      assert.strictEqual(out.statusCode, 403);
    });

    it("rejects a shared secret that is a prefix of the real one", async () => {
      const out = await run(HUMAN_NOTIFY, { "x-webhook-secret": SECRET.slice(0, -1) });
      assert.strictEqual(out.statusCode, 403);
    });

    it("rejects a shared secret with trailing padding", async () => {
      const out = await run(HUMAN_NOTIFY, { "x-webhook-secret": `${SECRET} ` });
      assert.strictEqual(out.statusCode, 403);
    });

    it("accepts the correct shared secret", async () => {
      const out = await run(HUMAN_NOTIFY, { "x-webhook-secret": SECRET });
      assert.strictEqual(out.statusCode, null);
    });

    it("accepts a correct HMAC signature", async () => {
      const out = await run(HUMAN_NOTIFY, { "x-signature": hmacOf(BODY) });
      assert.strictEqual(out.statusCode, null);
    });

    it("rejects an HMAC computed over a different body", async () => {
      const out = await run(HUMAN_NOTIFY, { "x-signature": hmacOf({ conversationId: "999" }) });
      assert.strictEqual(out.statusCode, 403);
    });

    it("rejects a malformed hex signature without throwing", async () => {
      const out = await run(HUMAN_NOTIFY, { "x-signature": "zzzz-not-hex" });
      assert.strictEqual(out.statusCode, 403);
    });

    it("signs Thai UTF-8 content byte-exactly", async () => {
      const body = { conversationId: "301", content: "ระบบเข้าใช้งานไม่ได้ครับ" };
      const out = await run(HUMAN_NOTIFY, { "x-signature": hmacOf(body) }, body);
      assert.strictEqual(out.statusCode, null, "a valid signature over Thai content must be accepted");
    });
  });

  describe("scope", () => {
    it("leaves GET requests alone", async () => {
      const out: Outcome = { statusCode: null, payload: null };
      setStrict(true);
      const request = fakeRequest(HUMAN_NOTIFY);
      request.method = "GET";
      await webhookSignatureHook(request, fakeReply(out));
      assert.strictEqual(out.statusCode, null);
    });

    it("does not extend enforcement to unrelated routes", async () => {
      setStrict(true);
      const out = await run("/api/v1/webhooks/plane");
      assert.strictEqual(out.statusCode, null, "plane has its own PLANE_WEBHOOK_SECRET check");
    });

    it("ignores a query string when matching the route", async () => {
      setStrict(true);
      const out = await run(`${HUMAN_NOTIFY}?retry=1`);
      assert.strictEqual(out.statusCode, 403, "a query string must not bypass the check");
    });

    it("keeps /webhook/message on HMAC, not the shared secret", async () => {
      setStrict(false);
      const out = await run("/webhook/message", { "x-webhook-secret": SECRET });
      assert.strictEqual(out.statusCode, 403, "the shared secret must not stand in for /webhook/message's HMAC");
    });
  });
});
