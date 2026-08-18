import axios from "axios";

async function testFullFlowPayload() {
  const payload = {
    data: {
      org_id: "org_excise",
      subject: "ขอคำแนะนำวิธีเปิดใช้งานระบบหรือบริการ",
      summary: "## 📋 ข้อมูลทั่วไป (Overview)\n- โปรเจกต์ / ระบบ: Excise\n- ผู้แจ้ง: ลูกค้าผ่านช่องทางสนทนา\n- ช่องทางที่แจ้ง: LINE\n\n## 🔍 รายละเอียดสำหรับ Developer (Issue Details)\n- หน้า / ฟีเจอร์: -\n- อาการที่เกิด (Symptom): ต้องการคำแนะนำหรือวิธีเปิดใช้งานระบบหรือบริการ\n- ผลลัพธ์ที่ควรจะเป็น (Expected): ได้รับคำแนะนำวิธีใช้งานที่ถูกต้องและชัดเจน\n- ขั้นตอนเกิดปัญหา (Steps to Reproduce): -\n- ขอบเขตปัญหา (Impact Scope): ส่งผลต่อลูกค้าที่ต้องการเปิดใช้งานระบบอย่างถูกต้อง\n\n## ⏱️ ระดับความสำคัญและเวลา (SLA & Severity)\n- ระดับความสำคัญ: Medium\n- SLA Target Level: P3 - 72 ชม.\n- เวลาที่ต้องแก้ไขเสร็จ: ภายใน 3 วัน\n\n## 🛠️ ข้อมูลทางเทคนิคและหลักฐาน (Technical & Evidence)\n- Raw Customer Report: ขอคำแนะนำวิธีเปิดใช้งานระบบหรือบริการ",
      due_date: "2026-08-21T09:51:08.736Z",
      priority: "Medium",
      severity: "Medium",
      project_id: 101,
      plane_title: "[TCK-2026-63335] ขอคำแนะนำวิธีเปิดใช้งานระบบหรือบริการ",
      ticket_number: "TCK-2026-63335",
      plane_priority: "medium",
      conversation_id: 1041,
      plane_external_id: "TCK-2026-63335",
      plane_target_date: "2026-08-21",
      plane_description_html: "<h3>TicketX support incident</h3><p>Test</p>"
    }
  };

  try {
    const res = await axios.post("http://localhost:3000/api/v1/internal/tickets/promote", payload);
    console.log("✅ Response:", res.data);
  } catch (e: any) {
    console.log("❌ Failed:", e.response?.data || e.message);
  }
}

testFullFlowPayload();
