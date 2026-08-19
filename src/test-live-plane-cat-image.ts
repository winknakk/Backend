import * as dotenv from "dotenv";
import * as path from "path";
import { PostgresAdapter, pool } from "./adapters/postgres/PostgresAdapter";
import { PlaneService } from "./services/planeService";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function testLiveCatImagePromotion() {
  console.log("=================================================================");
  console.log("Testing Live Excise Ticket Creation & Cat Image Promotion to Plane");
  console.log("=================================================================");

  const dbAdapter = new PostgresAdapter();
  const planeService = new PlaneService(dbAdapter);

  const ticketData = {
    ticket_number: `TCK-EXCISE-${Date.now().toString().slice(-5)}`,
    project_id: 101,
    org_id: "org_excise",
    subject: "ทดสอบแจ้งปัญหาระบบ Excise พร้อมแนบรูปภาพแมวประกอบ",
    summary: "ลูกค้ารายงานว่าระบบ Excise ล่ม ขึ้น Error 506 Variant Also Negotiates ไม่สามารถยื่นชำระภาษีได้ พร้อมแนบรูปแมวเป็นหลักฐาน",
    severity: "Critical",
    priority: "Urgent",
    created_by_name: "Akkharin Laksana (Excise Tester)",
    created_by_type: "CUSTOMER",
    attachment_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg",
    attachments: [
      "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg"
    ]
  };

  const insertRes = await pool.query(
    `INSERT INTO tickets (ticket_number, project_id, org_id, subject, summary, severity, priority, created_by_name, created_by_type, attachment_url, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, ticket_number`,
    [
      ticketData.ticket_number,
      ticketData.project_id,
      ticketData.org_id,
      ticketData.subject,
      ticketData.summary,
      ticketData.severity,
      ticketData.priority,
      ticketData.created_by_name,
      ticketData.created_by_type,
      ticketData.attachment_url,
      JSON.stringify(ticketData.attachments)
    ]
  );
  const createRes = insertRes.rows[0];
  console.log(`Created Ticket ID: ${createRes.id} (Ticket Number: ${createRes.ticket_number})`);

  const promoteResult = await planeService.promoteTicketToPlane(createRes.id);
  console.log("\nPlane Promotion Result:", promoteResult);

  const planeWs = promoteResult.plane_workspace_slug || "cs-team";
  const planeProj = promoteResult.plane_project_id || "e3454524-961a-4b84-8ccb-71575baaa696";
  const planeIssueId = promoteResult.plane_issue_id;

  const planeUrl = `https://projects.oneweb.tech/${planeWs}/projects/${planeProj}/issues/${planeIssueId}`;
  console.log("\n=================================================================");
  console.log(`🎉 LIVE PLANE TICKET CREATED WITH CAT IMAGE!`);
  console.log(`👉 Plane Issue URL: ${planeUrl}`);
  console.log("=================================================================");
}

testLiveCatImagePromotion()
  .then(() => pool.end())
  .catch((e) => { console.error(e); pool.end(); process.exit(1); });
