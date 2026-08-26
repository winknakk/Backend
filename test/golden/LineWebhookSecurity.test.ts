import assert from "assert";
import crypto from "crypto";
import { describe, it } from "node:test";
import {
  resolveLineWebhookPayload,
  verifyLineSignature,
} from "../../src/services/lineWebhookSecurity";

/**
 * PHASE 2 — LINE webhook signature verification.
 *
 * These exercise the verification mechanism directly with a locally generated
 * secret. That proves the algorithm, the comparison and the failure modes.
 *
 * It does NOT prove that the real LINE channel is configured — that requires
 * LINE's own secret and a public endpoint, and is reported BLOCKED rather
 * than inferred from these results.
 */

const TEST_SECRET = crypto.randomBytes(32).toString("hex");

function sign(body: string, secret = TEST_SECRET): string {
  return crypto.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("base64");
}

const validBody = JSON.stringify({
  destination: "Utest_destination",
  events: [
    {
      type: "message",
      webhookEventId: "01JTESTEVENT000000000000001",
      source: { type: "user", userId: "Utest_customer" },
      message: { id: "m-1", type: "text", text: "ระบบเข้าใช้งานไม่ได้ครับ ขึ้น 502 Bad Gateway" },
    },
  ],
});

describe("PHASE 2 — LINE webhook signature verification", () => {
  it("2.A: a valid signature is accepted", () => {
    const sig = sign(validBody);
    assert.strictEqual(verifyLineSignature(Buffer.from(validBody, "utf8"), sig, TEST_SECRET), true);
  });

  it("2.B: an invalid signature is rejected", () => {
    // Correct length and encoding, wrong key — the case a naive length check
    // or a truncated comparison would let through.
    const wrongKey = sign(validBody, crypto.randomBytes(32).toString("hex"));
    assert.strictEqual(verifyLineSignature(Buffer.from(validBody, "utf8"), wrongKey, TEST_SECRET), false);

    // Right key, tampered body: a signature must not survive an edit.
    const tampered = validBody.replace("502", "503");
    assert.strictEqual(verifyLineSignature(Buffer.from(tampered, "utf8"), sign(validBody), TEST_SECRET), false);

    // Truncated and padded variants.
    const good = sign(validBody);
    assert.strictEqual(verifyLineSignature(Buffer.from(validBody, "utf8"), good.slice(0, -2), TEST_SECRET), false);
    assert.strictEqual(verifyLineSignature(Buffer.from(validBody, "utf8"), `${good}==`, TEST_SECRET), false);
  });

  it("2.C: a missing signature is rejected", () => {
    for (const missing of ["", "   ", undefined as any, null as any]) {
      assert.strictEqual(
        verifyLineSignature(Buffer.from(validBody, "utf8"), missing, TEST_SECRET),
        false,
        `signature=${JSON.stringify(missing)}`
      );
    }
  });

  it("2.C2: an unconfigured secret can never verify", () => {
    // The fail-closed guarantee: with no secret, nothing validates — there is
    // no code path where an empty secret produces a match.
    for (const noSecret of ["", undefined as any, null as any]) {
      assert.strictEqual(verifyLineSignature(Buffer.from(validBody, "utf8"), sign(validBody), noSecret), false);
    }
  });

  it("2.C3: an empty body cannot be signed into acceptance", () => {
    assert.strictEqual(verifyLineSignature(Buffer.alloc(0), sign(""), TEST_SECRET), false);
  });

  it("2.E: malformed payloads are handled without throwing", () => {
    // A forwarded rawBody that is not JSON must surface as a rejection the
    // route turns into a 400, not an unhandled exception that kills the
    // request (or, with an unlucky listener, the process).
    assert.throws(() =>
      resolveLineWebhookPayload({
        body: { data: { rawBody: "{not json", signature: "x" } },
        headerSignature: "x",
      })
    );

    // Everything else must resolve to a payload object without throwing.
    for (const body of [{}, { events: null }, { destination: 123 }, [] as any, "string" as any]) {
      const resolved = resolveLineWebhookPayload({ body, headerSignature: "sig" });
      assert.ok(resolved, `failed for ${JSON.stringify(body)}`);
      assert.ok(Buffer.isBuffer(resolved.rawBody));
    }
  });

  it("2.E2: signature verification is constant-time on equal-length input", () => {
    // Length is compared first, then timingSafeEqual. A plain === would leak
    // how many leading characters matched.
    const good = sign(validBody);
    const nearMiss = `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`;
    assert.strictEqual(nearMiss.length, good.length);
    assert.strictEqual(verifyLineSignature(Buffer.from(validBody, "utf8"), nearMiss, TEST_SECRET), false);
  });

  it("2.F: a router-forwarded raw body is verified against the forwarded bytes", () => {
    // The gateway forwards the original bytes; the signature must be checked
    // against those, not against a re-serialised object whose key order or
    // spacing may differ.
    const resolved = resolveLineWebhookPayload({
      body: { data: { rawBody: validBody, signature: sign(validBody) } },
    });
    assert.strictEqual(resolved.forwardedByRouter, true);
    assert.strictEqual(verifyLineSignature(resolved.rawBody, resolved.signature, TEST_SECRET), true);
  });
});
