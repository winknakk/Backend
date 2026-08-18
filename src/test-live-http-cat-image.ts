import axios from "axios";

async function runLiveHttpCatTest() {
  console.log("=================================================================");
  console.log("Testing Live Excise Ticket & Cat Image Promotion via Backend HTTP");
  console.log("=================================================================");

  const catImageUrl = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg";

  // 1. Create ticket under conversation 1041 (Excise Project ID 101)
  const ticketPayload = {
    subject: "ทดสอบแจ้งปัญหาระบบ Excise ล่มพร้อมแนบรูปถ่ายแมวประกอบ",
    summary: `ลูกค้ารายงานว่าระบบ Excise ล่ม ขึ้น 506 Variant Also Negotiates ไม่สามารถยื่นชำระภาษีได้ พร้อมแนบรูปถ่ายแมวประกอบปัญหา ${catImageUrl}`,
    severity: "Critical",
    priority: "Urgent",
    projectId: "101",
    orgId: "org_excise",
    createdByName: "Akkharin Laksana (Excise Cat Tester)",
    createdByType: "CUSTOMER",
    attachment_url: catImageUrl,
    attachments: [catImageUrl]
  };

  console.log("\n[1] Creating ticket via POST http://localhost:3000/api/admin/conversations/1041/tickets...");
  const createRes = await axios.post("http://localhost:3000/api/admin/conversations/1041/tickets", ticketPayload);
  const ticket = createRes.data?.data || createRes.data;
  console.log(`  ✅ Ticket Created: ID=${ticket.id}, Ticket Number=${ticket.ticket_number || ticket.ticketNumber || ticket.ticket_id}`);

  // 2. Promote ticket to Plane via internal endpoint
  console.log(`\n[2] Promoting Ticket ID ${ticket.id} to Plane.so...`);
  const promoteRes = await axios.post("http://localhost:3000/api/v1/internal/tickets/promote", {
    ticketId: String(ticket.id)
  });

  console.log("  ✅ Promotion Result:", promoteRes.data);

  const planeIssueId = promoteRes.data.plane_issue_id;
  const planeWs = promoteRes.data.plane_workspace_slug || "cs-team";
  const planeProj = promoteRes.data.plane_project_id || "e3454524-961a-4b84-8ccb-71575baaa696";

  const planeUrl = `https://projects.oneweb.tech/${planeWs}/projects/${planeProj}/issues/${planeIssueId}`;
  console.log("\n=================================================================");
  console.log(`🎉 LIVE TICKET CREATED & PROMOTED TO PLANE SUCCESSFULLY!`);
  console.log(`👉 Plane Work Item Link: ${planeUrl}`);
  console.log("=================================================================");
}

runLiveHttpCatTest().catch((e) => {
  console.error("❌ Failed:", e.response?.data || e.message);
  process.exit(1);
});
