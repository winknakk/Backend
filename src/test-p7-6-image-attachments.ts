import assert from "assert";
import { extractImageUrls, buildPlaneWorkItemPayload } from "./services/planeService";

function testImageAttachmentSupport() {
  console.log("=================================================================");
  console.log("Testing Image Attachment Extraction & Plane Description Embedding");
  console.log("=================================================================");

  // 1. Test URL extraction from ticket object
  const sampleTicket = {
    ticket_number: "TCK-2026-99999",
    subject: "ระบบล่มขึ้น 506 Variant Also Negotiates",
    summary: "ลูกค้ารายงานว่าระบบล่ม เข้าใช้งานไม่ได้เลย https://example.com/screens/error506.png",
    attachment_url: "https://obs.line-scdn.net/sample_line_image_12345.jpg",
    attachments: [
      "https://projects.oneweb.tech/uploads/customer_error_screenshot.png"
    ],
    priority: "Urgent",
  };

  const extracted = extractImageUrls(sampleTicket);
  assert(extracted.includes("https://obs.line-scdn.net/sample_line_image_12345.jpg"), "Must extract attachment_url");
  assert(extracted.includes("https://projects.oneweb.tech/uploads/customer_error_screenshot.png"), "Must extract attachments array");
  assert(extracted.includes("https://example.com/screens/error506.png"), "Must extract inline image URL from summary text");
  console.log("  ✅ Test 1 PASSED: Image URLs extracted cleanly from ticket fields & text.");

  // 2. Test HTML Payload Embedding
  const payload = buildPlaneWorkItemPayload(sampleTicket, "Avalant Co.,Ltd.");
  assert(payload.description_html.includes("Customer Screenshots / Attached Media"), "Payload description_html must include image section");
  assert(payload.description_html.includes('<img src="https://obs.line-scdn.net/sample_line_image_12345.jpg"'), "Payload description_html must embed img tag");
  console.log("  ✅ Test 2 PASSED: HTML img tags cleanly embedded in Plane description_html.");

  console.log("\n=================================================================");
  console.log("🎉 ALL IMAGE ATTACHMENT TESTS PASSED!");
  console.log("=================================================================");
}

testImageAttachmentSupport();
