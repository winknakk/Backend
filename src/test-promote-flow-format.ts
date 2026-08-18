import axios from "axios";

async function testPromoteFlowFormat() {
  console.log("Testing /api/v1/internal/tickets/promote with flow payload format...");

  const payload = {
    data: {
      ticket_number: "TCK-2026-87492", // Existing test ticket
      project_id: 101,
      org_id: "org_excise"
    }
  };

  const res = await axios.post("http://localhost:3000/api/v1/internal/tickets/promote", payload);
  console.log("✅ Response:", res.data);
}

testPromoteFlowFormat().catch(e => {
  console.error("❌ Failed:", e.response?.data || e.message);
  process.exit(1);
});
