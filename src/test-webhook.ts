import { fastify, bootstrap } from "./api/server";
import axios from "axios";

async function runWebhookTest() {
  console.log("=========================================");
  console.log("  AutomationX V2 HTTP Webhook Test       ");
  console.log("=========================================\n");

  const port = 3001; // Use separate port for testing to avoid conflicts

  // Start the server
  await bootstrap();
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`[Test Server] Running at http://localhost:${port}`);

  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Test GET /health
    console.log("\n--- Testing GET /health ---");
    const healthRes = await axios.get(`${baseUrl}/health`);
    console.log(`Response Status: ${healthRes.status}`);
    console.log("Response Body:", JSON.stringify(healthRes.data, null, 2));

    if (
      healthRes.data.status === "healthy" &&
      healthRes.data.apiStatus === "ok" &&
      typeof healthRes.data.databaseProvider === "string" &&
      typeof healthRes.data.mcpStatus === "string" &&
      typeof healthRes.data.registeredToolsCount === "number"
    ) {
      console.log("✅ Health Check Passed!");
    } else {
      throw new Error("Health check response is missing required properties.");
    }

    // 2. Test POST /webhook/message (Case 1: Known issue -> resolved by docs)
    console.log("\n--- Testing POST /webhook/message (Case 1) ---");
    const payload1 = {
      senderId: "U6256f0c4dbb64edacf9eea92904e49b1",
      channel: "LINE",
      text: "Cannot login Orbit App session expired",
      receivedAt: new Date().toISOString(),
    };

    const reply1 = await axios.post(`${baseUrl}/webhook/message`, payload1);
    console.log(`Response Status: ${reply1.status}`);
    console.log("Response Body:", JSON.stringify(reply1.data, null, 2));

    if (reply1.data.recipientId === payload1.senderId && reply1.data.text) {
      console.log("✅ Webhook Message Case 1 Passed!");
    } else {
      throw new Error("Webhook message response format mismatch.");
    }

    // 3. Test POST /webhook/message with Invalid Payload
    console.log("\n--- Testing POST /webhook/message (Invalid Payload) ---");
    try {
      await axios.post(`${baseUrl}/webhook/message`, { senderId: "", channel: "LINE" });
      console.error("❌ Failed: Server accepted an invalid payload!");
      process.exit(1);
    } catch (err: any) {
      console.log(`Response Status: ${err.response?.status}`);
      console.log("Response Body:", JSON.stringify(err.response?.data, null, 2));
      if (err.response?.status === 400) {
        console.log("✅ Invalid Payload Validation Checked successfully!");
      } else {
        throw new Error(`Expected 400 Bad Request, got ${err.response?.status}`);
      }
    }

    console.log("\n✅ HTTP Webhook Test PASSED successfully!");
  } catch (err: any) {
    console.error("\n❌ HTTP Webhook Test FAILED:");
    console.error(err.message);
    if (err.response) {
      console.error("Response data:", err.response.data);
    }
    process.exit(1);
  } finally {
    // Close the fastify server
    console.log("\nClosing test server...");
    await fastify.close();
    console.log("Test server closed.");
  }
}

runWebhookTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
