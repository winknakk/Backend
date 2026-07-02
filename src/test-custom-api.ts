import axios from "axios";
import { exec, ChildProcess } from "child_process";
import * as path from "path";

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("Starting AutomationX V1 Fastify server for testing...");
  
  // Launch server as a child process using tsx
  const serverPath = path.resolve(__dirname, "api/server.ts");
  const serverProcess: ChildProcess = exec(`npx tsx "${serverPath}"`, {
    env: { ...process.env, PORT: "3003", DATABASE_PROVIDER: "local" },
  });

  serverProcess.stdout?.on("data", (data) => {
    console.log(`[Server STDOUT] ${data.trim()}`);
  });

  serverProcess.stderr?.on("data", (data) => {
    console.error(`[Server STDERR] ${data.trim()}`);
  });

  // Wait for server to boot up by polling /health
  console.log("Waiting for server to start...");
  const baseUrl = "http://127.0.0.1:3003";
  let healthy = false;
  for (let i = 0; i < 25; i++) {
    try {
      const res = await axios.get(`${baseUrl}/health`, { timeout: 1000 });
      if (res.status === 200) {
        healthy = true;
        break;
      }
    } catch {}
    await wait(1000);
  }
  if (!healthy) {
    console.error("Server failed to boot in time!");
    serverProcess.kill("SIGTERM");
    process.exit(1);
  }
  console.log("Server is healthy and ready!");

  try {
    console.log("\n-------------------------------------------");
    console.log("1. Testing GET /api/admin/conversations");
    const resConv = await axios.get(`${baseUrl}/api/admin/conversations`);
    console.log("Status:", resConv.status);
    console.log("Data (first 3):", JSON.stringify(resConv.data.slice(0, 3), null, 2));

    console.log("\n-------------------------------------------");
    console.log("2. Testing GET /api/admin/conversations/1/messages");
    const resMsgs = await axios.get(`${baseUrl}/api/admin/conversations/1/messages`);
    console.log("Status:", resMsgs.status);
    console.log("Data:", JSON.stringify(resMsgs.data, null, 2));

    console.log("\n-------------------------------------------");
    console.log("3. Testing POST /api/admin/conversations/1/takeover");
    const resTakeover = await axios.post(`${baseUrl}/api/admin/conversations/1/takeover`, {});
    console.log("Status:", resTakeover.status);
    console.log("Data:", JSON.stringify(resTakeover.data, null, 2));

    console.log("\n-------------------------------------------");
    console.log("4. Testing POST /api/admin/conversations/1/reply");
    const resReply = await axios.post(`${baseUrl}/api/admin/conversations/1/reply`, {
      message: "สวัสดีครับ นี่คือข้อความทดสอบจากแอดมินระบบ AutomationX",
    });
    console.log("Status:", resReply.status);
    console.log("Data:", JSON.stringify(resReply.data, null, 2));

    console.log("\n-------------------------------------------");
    console.log("5. Testing POST /api/admin/tickets/1/promote");
    const resPromote = await axios.post(`${baseUrl}/api/admin/tickets/1/promote`, {});
    console.log("Status:", resPromote.status);
    console.log("Data:", JSON.stringify(resPromote.data, null, 2));

    console.log("\n-------------------------------------------");
    console.log("6. Testing GET /api/admin/conversations/1/tickets");
    const resGetTickets = await axios.get(`${baseUrl}/api/admin/conversations/1/tickets`);
    console.log("Status:", resGetTickets.status);
    console.log("Tickets count before creation:", resGetTickets.data.length);

    console.log("\n-------------------------------------------");
    console.log("7. Testing POST /api/admin/conversations/1/tickets");
    const resCreateTicket = await axios.post(`${baseUrl}/api/admin/conversations/1/tickets`, {
      subject: "Test custom ticket subject via admin API",
      summary: "This is a test ticket description for integration testing purposes.",
      severity: "High",
      priority: "P2"
    });
    console.log("Status:", resCreateTicket.status);
    console.log("Data:", JSON.stringify(resCreateTicket.data, null, 2));

    const newTicketId = resCreateTicket.data.data.ticketId;
    console.log("New ticket number:", newTicketId);

    console.log("\n-------------------------------------------");
    console.log("8. Testing GET /api/admin/conversations/1/tickets after creation");
    const resGetTicketsAfter = await axios.get(`${baseUrl}/api/admin/conversations/1/tickets`);
    console.log("Status:", resGetTicketsAfter.status);
    console.log("Tickets count after creation:", resGetTicketsAfter.data.length);
    const createdTicket = resGetTicketsAfter.data.find((t: any) => (t.ticketId || t.ticket_id) === newTicketId);
    const createdTicketDbId = createdTicket ? (createdTicket.id1 || createdTicket.id) : null;
    console.log("Created ticket database ID:", createdTicketDbId);

    if (createdTicketDbId) {
      console.log("\n-------------------------------------------");
      console.log(`9. Testing POST /api/admin/tickets/${createdTicketDbId}/promote for the new ticket`);
      const resPromoteNew = await axios.post(`${baseUrl}/api/admin/tickets/${createdTicketDbId}/promote`, {});
      console.log("Status:", resPromoteNew.status);
      console.log("Data:", JSON.stringify(resPromoteNew.data, null, 2));
    }

    console.log("\n-------------------------------------------");
    console.log("All tests completed successfully!");

  } catch (err: any) {
    console.error("Test failed with error:", err.message);
    if (err.response) {
      console.error("Response data:", JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err);
    }
  } finally {
    console.log("Shutting down the test server...");
    serverProcess.kill("SIGTERM");
    await wait(1000);
    console.log("Test server process terminated.");
    process.exit(0);
  }
}

main();
