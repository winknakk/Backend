import assert from "assert";
import crypto from "crypto";

async function run(): Promise<void> {
  const secret = "test-plane-route-secret";
  process.env.PLANE_WEBHOOK_SECRET = secret;

  const { fastify } = await import("./api/server");
  const { pool } = await import("./adapters/postgres/PostgresAdapter");
  const payload = { event: "project", action: "update", data: { id: "project-1" } };
  const signature = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");

  const rejected = await fastify.inject({
    method: "POST",
    url: "/api/v1/webhooks/plane",
    headers: { "x-plane-signature": "invalid" },
    payload,
  });
  assert.strictEqual(rejected.statusCode, 403);

  const accepted = await fastify.inject({
    method: "POST",
    url: "/api/v1/webhooks/plane",
    headers: {
      "x-plane-signature": signature,
      "x-plane-delivery": "test-delivery-1",
    },
    payload,
  });
  assert.strictEqual(accepted.statusCode, 200);
  assert.deepStrictEqual(accepted.json(), {
    success: true,
    processed: false,
    matched: false,
    reason: "unsupported_event",
  });

  await fastify.close();
  await pool.end();
  console.log("Plane webhook route tests passed");
  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
