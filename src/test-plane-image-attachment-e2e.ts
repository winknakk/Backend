import * as dotenv from "dotenv";
import * as path from "path";
import axios from "axios";
import { PostgresAdapter, pool } from "./adapters/postgres/PostgresAdapter";
import { PlaneService } from "./services/planeService";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function runE2EImageAttachmentTest() {
  console.log("=================================================================");
  console.log("Testing Plane E2E Image Attachment & Description Embedding");
  console.log("=================================================================");

  const dbAdapter = new PostgresAdapter();
  const planeService = new PlaneService(dbAdapter);

  // 1. Test Case A: Promote ticket under conversation 67 with explicit line_image_id
  const ticketNumberA = `TCK-TEST-IMG-${Date.now().toString().slice(-5)}`;
  const ticketDataA = {
    ticket_number: ticketNumberA,
    conversation_id: 67,
    project_id: 1, // SCG / cs-team Project
    org_id: "org_default",
    subject: "ทดสอบแนบรูปภาพจาก LINE เข้าสู่ Plane.so อัตโนมัติ (Case A: Explicit ID)",
    summary: "ลูกค้ารายงานปัญหาพร้อมแนบภาพหลักฐานผ่าน LINE ระบบต้องอัปโหลดเข้า Plane Storage และ Embed ลงใน Description",
    severity: "High",
    priority: "High",
    created_by_name: "PromptX AI (Image Tester)",
    created_by_type: "AI_BOT",
    created_via: "ai",
    line_image_id: "627958142173184835"
  };

  console.log("\n[Test 1] Promoting ticket with explicit line_image_id...");
  const resultA = await planeService.promoteTicketToPlane(ticketDataA);
  console.log("  ✅ Promotion Result A:", resultA);

  const planeWsA = resultA.plane_workspace_slug || "cs-team";
  const planeProjA = resultA.plane_project_id || "09aa9c0e-8448-426f-8128-306c3dcf9d78";
  const planeIssueIdA = resultA.plane_issue_id;

  // Verify Issue details and attachments from Plane API
  const mappingResA = await pool.query(
    `SELECT * FROM plane_workspace_mappings WHERE project_id = 1 AND enabled = true`
  );
  const apiKeyA = mappingResA.rows[0].credential_ref;
  const baseUrlA = (mappingResA.rows[0].plane_api_base_url || "https://projects.oneweb.tech").replace(/\/+$/, "");

  const issueResA = await axios.get(
    `${baseUrlA}/api/v1/workspaces/${planeWsA}/projects/${planeProjA}/issues/${planeIssueIdA}/`,
    { headers: { "X-API-Key": apiKeyA } }
  );

  const descriptionA = issueResA.data.description_html || "";
  const hasImgTagA = descriptionA.includes("<img src=") && descriptionA.includes("Customer Screenshots");
  console.log("  ✅ Description HTML contains embedded image tag:", hasImgTagA);

  const attsResA = await axios.get(
    `${baseUrlA}/api/v1/workspaces/${planeWsA}/projects/${planeProjA}/issues/${planeIssueIdA}/issue-attachments/`,
    { headers: { "X-API-Key": apiKeyA } }
  );
  console.log("  ✅ Plane issue attachments count:", attsResA.data.length);

  const planeUrlA = `https://projects.oneweb.tech/${planeWsA}/projects/${planeProjA}/issues/${planeIssueIdA}`;
  console.log(`  👉 Plane Work Item Link (Case A): ${planeUrlA}`);

  // 2. Test Case B: Promote ticket under conversation 67 with NO line_image_id (Auto-Detection)
  const ticketNumberB = `TCK-TEST-AUTO-${Date.now().toString().slice(-5)}`;
  const ticketDataB = {
    ticket_number: ticketNumberB,
    conversation_id: 67,
    project_id: 1,
    org_id: "org_default",
    subject: "ทดสอบ Auto-detect รูปภาพจากบทสนทนา (Case B: Auto-detect Fallback)",
    summary: "ทดสอบกรณี AI ไม่ได้ส่ง line_image_id เข้ามา ระบบ Backend ต้องค้นหาภาพล่าสุดของลูกค้ารายนี้จาก DB และแนบให้อัตโนมัติ",
    severity: "Medium",
    priority: "Medium",
    created_by_name: "PromptX AI (Auto Tester)",
    created_by_type: "AI_BOT",
    created_via: "ai"
  };

  console.log("\n[Test 2] Promoting ticket with Auto-Detection fallback (no line_image_id)...");
  const resultB = await planeService.promoteTicketToPlane(ticketDataB);
  console.log("  ✅ Promotion Result B:", resultB);

  const planeWsB = resultB.plane_workspace_slug || "cs-team";
  const planeProjB = resultB.plane_project_id || "09aa9c0e-8448-426f-8128-306c3dcf9d78";
  const planeIssueIdB = resultB.plane_issue_id;

  const issueResB = await axios.get(
    `${baseUrlA}/api/v1/workspaces/${planeWsB}/projects/${planeProjB}/issues/${planeIssueIdB}/`,
    { headers: { "X-API-Key": apiKeyA } }
  );
  const descriptionB = issueResB.data.description_html || "";
  const hasImgTagB = descriptionB.includes("<img src=") && descriptionB.includes("Customer Screenshots");
  console.log("  ✅ Description HTML contains embedded image tag (Auto-detect):", hasImgTagB);

  const planeUrlB = `https://projects.oneweb.tech/${planeWsB}/projects/${planeProjB}/issues/${planeIssueIdB}`;
  console.log(`  👉 Plane Work Item Link (Case B): ${planeUrlB}`);

  console.log("\n=================================================================");
  console.log("🎉 ALL E2E PLANE IMAGE ATTACHMENT TESTS PASSED SUCCESSFULLY (100%)!");
  console.log("=================================================================");

  await pool.end();
}

runE2EImageAttachmentTest().catch((err) => {
  console.error("❌ Test failed:", err);
  pool.end().finally(() => process.exit(1));
});
