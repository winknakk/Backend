import crypto from "crypto";
import axios from "axios";

async function runSecurityTests() {
  console.log("=========================================");
  console.log("  AutomationX V2 Security Middleware Tests");
  console.log("=========================================\n");

  const port = 3002;
  const baseUrl = `http://localhost:${port}`;

  // Configure environment variables for security testing
  process.env.API_KEY = "test-api-bearer-token-123";
  process.env.WEBHOOK_SECRET = "super-secret-webhook-key";
  process.env.RATE_LIMIT_MAX = "20";
  process.env.RATE_LIMIT_WINDOW_MS = "10000"; // 10 seconds

  // Import after setting env vars
  const { fastify, bootstrap } = await import("./api/server");
  const { stopCleanup } = await import("./middleware/rateLimit");
  // let's bootstrap the server now.
  
  // Register a dummy internal route to verify API Bearer authentication
  fastify.get("/api/internal-route", async (request, reply) => {
    return reply.code(200).send({ success: true, message: "Welcome inside!" });
  });

  await bootstrap();
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`[Test Server] Running at ${baseUrl}`);

  try {
    // ─── TEST 1: API Bearer Authentication ───────────────────
    console.log("\n--- Test 1: API Bearer Authentication ---");

    // A. Bypassed for /health
    console.log("Checking /health bypasses Bearer auth...");
    const healthRes = await axios.get(`${baseUrl}/health`);
    console.log(`- Health response status: ${healthRes.status} (Expected: 200)`);
    if (healthRes.status !== 200) throw new Error("Health check failed auth bypass");

    // B. Blocked for /api/internal-route (no token)
    console.log("Checking /api/internal-route blocked without token...");
    try {
      await axios.get(`${baseUrl}/api/internal-route`);
      throw new Error("Internal route should have failed without Bearer token");
    } catch (err: any) {
      console.log(`- Missing token response status: ${err.response?.status} (Expected: 401)`);
      if (err.response?.status !== 401) throw new Error("Failed 401 authentication check");
    }

    // C. Blocked for /api/internal-route (invalid token)
    console.log("Checking /api/internal-route blocked with invalid token...");
    try {
      await axios.get(`${baseUrl}/api/internal-route`, {
        headers: { Authorization: "Bearer wrong-token" }
      });
      throw new Error("Internal route should have failed with invalid Bearer token");
    } catch (err: any) {
      console.log(`- Invalid token response status: ${err.response?.status} (Expected: 401)`);
      if (err.response?.status !== 401) throw new Error("Failed 401 authentication check");
    }

    // D. Allowed for /api/internal-route (valid token)
    console.log("Checking /api/internal-route allowed with valid token...");
    const internalRes = await axios.get(`${baseUrl}/api/internal-route`, {
      headers: { Authorization: `Bearer ${process.env.API_KEY}` }
    });
    console.log(`- Valid token response status: ${internalRes.status} (Expected: 200)`);
    if (internalRes.status !== 200) throw new Error("Internal route failed with valid token");
    console.log("- Response body:", internalRes.data);


    // ─── TEST 2: Webhook HMAC Signature Validation ───────────
    console.log("\n--- Test 2: Webhook HMAC Signature Validation ---");

    const payload = {
      senderId: "U6256f0c4dbb64edacf9eea92904e49b1",
      channel: "LINE",
      text: "Testing security signature validation",
      receivedAt: new Date().toISOString()
    };

    // A. Blocked with missing signature
    console.log("Checking webhook blocked with missing signature...");
    try {
      await axios.post(`${baseUrl}/webhook/message`, payload);
      throw new Error("Webhook should have failed without signature header");
    } catch (err: any) {
      console.log(`- Missing signature response status: ${err.response?.status} (Expected: 403)`);
      if (err.response?.status !== 403) throw new Error("Failed 403 signature check");
    }

    // B. Blocked with invalid signature
    console.log("Checking webhook blocked with invalid signature...");
    try {
      await axios.post(`${baseUrl}/webhook/message`, payload, {
        headers: { "x-signature": "wrong-signature-hash" }
      });
      throw new Error("Webhook should have failed with invalid signature hash");
    } catch (err: any) {
      console.log(`- Invalid signature response status: ${err.response?.status} (Expected: 403)`);
      if (err.response?.status !== 403) throw new Error("Failed 403 signature check");
    }

    // C. Allowed with valid signature (should hit validation/processing, expecting 200 or 400, but NOT 403)
    console.log("Checking webhook allowed with valid signature...");
    const rawBody = JSON.stringify(payload);
    const validSignature = crypto
      .createHmac("sha256", process.env.WEBHOOK_SECRET!)
      .update(rawBody)
      .digest("hex");

    const webhookRes = await axios.post(`${baseUrl}/webhook/message`, payload, {
      headers: { "x-signature": validSignature }
    });
    console.log(`- Valid signature webhook response status: ${webhookRes.status} (Expected: 200 or 400, got ${webhookRes.status})`);
    if (webhookRes.status !== 200 && webhookRes.status !== 400) {
      throw new Error(`Expected 200 or 400, got ${webhookRes.status}`);
    }


    // ─── TEST 3: Rate Limiting ───────────────────────────────
    console.log("\n--- Test 3: IP Rate Limiting ---");
    console.log("Sending multiple health check requests to trigger limit...");
    
    // We configured RATE_LIMIT_MAX = 20. Loop to trigger and verify rate limiting.
    let rateLimited = false;
    for (let i = 1; i <= 25; i++) {
      try {
        await axios.get(`${baseUrl}/health`);
      } catch (err: any) {
        if (err.response?.status === 429) {
          console.log(`- Request #${i} of rate limit loop triggered 429 (Expected).`);
          console.log("- Rate limit Retry-After header:", err.response?.headers["retry-after"]);
          console.log("- Rate limit Response body:", err.response?.data);
          rateLimited = true;
          break;
        } else {
          throw err;
        }
      }
    }

    if (!rateLimited) {
      throw new Error("Failed to trigger rate limiting after 25 requests");
    }

    console.log("\n✅ All Security Middleware Tests PASSED successfully!");

  } catch (err: any) {
    console.error("\n❌ Security Middleware Test FAILED:");
    console.error(err.message);
    if (err.response) {
      console.error("Response status:", err.response.status);
      console.error("Response data:", err.response.data);
    }
    process.exit(1);
  } finally {
    console.log("\nClosing test server...");
    await fastify.close();
    stopCleanup(); // Stop the interval timer
    console.log("Test server closed.");
  }
}

runSecurityTests().catch(err => {
  console.error(err);
  process.exit(1);
});
