import { Client } from "pg";
import axios from "axios";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function createAndPromoteExciseTicketWithCatImage() {
  console.log("=================================================================");
  console.log("Creating Excise Ticket with Cat Image & Promoting to Plane.so...");
  console.log("=================================================================");

  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgresql://cs_user:F52Gs8w46001@postgres.promptxai.com:5432/csdb?options=-c%20search_path%3Dcs_tickets,public",
    connectionTimeoutMillis: 10000,
  });

  await client.connect();

  const catImageUrl = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg";
  const ticketNumber = `TCK-2026-${Math.floor(10000 + Math.random() * 90000)}`;

  const insRes = await client.query(
    `INSERT INTO tickets (
      ticket_number, conversation_id, project_id, org_id, subject, summary, 
      severity, priority, status, created_by_type, created_by_name, created_at
    ) VALUES (
      $1, 1041, 101, 'org_excise', 
      'ระบบ Excise ล่มขึ้น 506 Variant Also Negotiates เข้าใช้งานไม่ได้เลย (พร้อมรูปแมวประกอบ)',
      $2,
      'Critical', 'Urgent', 'Open', 'CUSTOMER', 'Akkharin Laksana (LINE)', NOW()
    ) RETURNING id, ticket_number`,
    [ticketNumber, `ลูกค้ารายงานว่าระบบ Excise ล่ม ขึ้น Error 506 Variant Also Negotiates ไม่สามารถยื่นชำระภาษีได้ พร้อมแนบรูปถ่ายแมวประกอบปัญหา ${catImageUrl}`]
  );

  const newTicket = insRes.rows[0];
  console.log(`✅ Created Excise Ticket in Database: ID ${newTicket.id} (${newTicket.ticket_number})`);

  // Promote via Backend API / internal endpoint
  console.log(`\nPromoting Ticket ID ${newTicket.id} to Plane.so...`);
  const promoteRes = await axios.post("http://localhost:3000/api/v1/internal/tickets/promote", {
    ticketId: String(newTicket.id)
  });

  console.log("✅ Plane Promotion Response:", promoteRes.data);

  const planeIssueId = promoteRes.data.plane_issue_id;
  const planeWs = promoteRes.data.plane_workspace_slug || "cs-team";
  const planeProj = promoteRes.data.plane_project_id || "e3454524-961a-4b84-8ccb-71575baaa696";

  const planeUrl = `https://projects.oneweb.tech/${planeWs}/projects/${planeProj}/issues/${planeIssueId}`;
  
  console.log("\n=================================================================");
  console.log("🎉 SUCCESS! LIVE EXCISE TICKET CREATED & PROMOTED TO PLANE!");
  console.log(`👉 Plane Issue URL: ${planeUrl}`);
  console.log("=================================================================");

  await client.end();
}

createAndPromoteExciseTicketWithCatImage().catch((e) => {
  console.error("❌ Error:", e.response?.data || e.message);
  process.exit(1);
});
