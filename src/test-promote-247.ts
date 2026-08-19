import { PlaneService } from "./services/planeService";
import { PostgresAdapter } from "./adapters/postgres/PostgresAdapter";

async function test247() {
  console.log("🧪 Testing Promotion to 24/7 Plane Project ('Ask Natapohn')...");
  const dbAdapter = new PostgresAdapter();
  const planeService = new PlaneService(dbAdapter);

  try {
    const res = await planeService.promoteTicketToPlane({
      data: {
        project_id: 8,
        org_id: "org_default",
        ticket_number: "TCK-2026-TEST247",
        subject: "ทดสอบแจ้งปัญหาโปรเจกต์ 24/7",
        summary: "ทดสอบการเชื่อมต่อ Plane แยก Workspace (Ask Natapohn) และ API Key แยก",
        priority: "High",
        severity: "Major"
      },
      ticketId: "TCK-2026-TEST247"
    });
    console.log("\n🎉 Promotion to 24/7 Workspace Success:", res);
  } catch (err: any) {
    console.error("\n❌ Promotion failed:", err.response?.data || err.message);
  }
  process.exit(0);
}

test247();
