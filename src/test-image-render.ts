import { buildPlaneWorkItemPayload } from "./services/planeService";

const payload = buildPlaneWorkItemPayload({
  ticket_number: "TCK-2026-IMGTEST",
  subject: "ทดสอบส่งรูปภาพ",
  media_urls: [
    "https://example.com/cat.png",
    "https://example.com/error-screen.jpg"
  ]
});

console.log("=== PLANE WORK ITEM DESCRIPTION HTML ===");
console.log(payload.description_html);
