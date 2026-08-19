import { buildPlaneWorkItemPayload } from "./planeService";

const payload = buildPlaneWorkItemPayload({
  ticket_number: "TCK-2026-14984",
  subject: "ระบบ Excise ล่ม 506 Variant Also Negotiates เข้าใช้งานไม่ได้"
});

console.log("GENERATED PLANE TITLE:", payload.name);
