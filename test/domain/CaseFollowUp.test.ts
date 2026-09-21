/**
 * "เปิดเคสใหม่จากเรื่องนี้" (2026-09-18) — the pure parts: the chip/command
 * parser, the Plane link, the HTML written into the new and the old work item,
 * the LINE chip text, and the payload builder carrying the related case.
 */
import assert from "node:assert/strict";
import {
  parseNewCaseCommand,
  planeWorkItemWebUrl,
  relatedCaseMetadataValue,
  relatedCaseSectionHtml,
  followUpCommentHtml,
  bangkokDateTime,
  type RelatedCaseInfo,
} from "../../src/services/CaseFollowUpService";
import { closedReferenceChips, followUpReportText } from "../../src/services/LineCaseContextService";
import { CaseResolver } from "../../src/domain/case/CaseResolver";
import { buildPlaneWorkItemPayload } from "../../src/services/planeService";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err: any) {
    console.error(`❌ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const related: RelatedCaseInfo = {
  ticketId: 731,
  ticketNumber: "TCK-2026-86186",
  subject: "ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก",
  status: "CLOSED",
  closedAt: new Date("2026-09-18T06:27:02.939Z"),
  sequenceLabel: "EXAI-98",
  planeIssueId: "a106b5db-5bdf-42ba-a622-f94b9f39b499",
  url: "https://projects.oneweb.tech/cs-team/projects/95c2f51f-16c9-4048-87e2-4a28a414a979/issues/a106b5db-5bdf-42ba-a622-f94b9f39b499",
};

check("F-01 the chip texts and a bare command are new-case commands; a report is not", () => {
  assert.deepEqual(parseNewCaseCommand("เปิดเคสใหม่"), { ticketNumber: null });
  assert.deepEqual(parseNewCaseCommand("เปิดเคสใหม่: ติดตามต่อจาก TCK-2026-86186"), { ticketNumber: "TCK-2026-86186" });
  assert.deepEqual(parseNewCaseCommand(" แจ้งเรื่องใหม่ "), { ticketNumber: null });
  assert.equal(parseNewCaseCommand("เปิดเคสใหม่ ระบบเว็บไซต์เข้าไม่ได้ครับ"), null);
  assert.equal(parseNewCaseCommand("ระบบเปิดเคสใหม่ไม่ได้ครับ"), null);
});

check("F-02 the Plane link and the Bangkok timestamp", () => {
  assert.equal(
    planeWorkItemWebUrl("cs-team", "95c2f51f-16c9-4048-87e2-4a28a414a979", "a106b5db-5bdf-42ba-a622-f94b9f39b499"),
    related.url
  );
  assert.equal(planeWorkItemWebUrl("cs-team", null, "x"), null);
  assert.equal(bangkokDateTime(related.closedAt), "18/09/2026 13:27");
});

check("F-03 the 'Related case' row and the follow-up section on the NEW work item", () => {
  assert.equal(relatedCaseMetadataValue(related), "TCK-2026-86186 (EXAI-98) · ปิดเมื่อ 18/09/2026 13:27");
  const html = relatedCaseSectionHtml(related);
  assert.ok(html.startsWith("<h3>🔗 Follow-up of a closed case</h3>"));
  assert.ok(html.includes("<strong>TCK-2026-86186 (EXAI-98)</strong> ซึ่งปิดไปเมื่อ 18/09/2026 13:27"));
  assert.ok(html.includes("เรื่องเดิม: ระบบเว็บไซต์ - เข้าใช้งานไม่ได้ และเป็นเคสด่วนมาก"));
  assert.ok(html.includes(`<a href="${related.url}">เปิดเคสเดิมใน Plane</a>`));
  const cancelled = relatedCaseMetadataValue({ ...related, status: "CANCELLED", sequenceLabel: null });
  assert.equal(cancelled, "TCK-2026-86186 · ยกเลิกเมื่อ 18/09/2026 13:27");
});

check("F-04 the comment left on the OLD work item", () => {
  const html = followUpCommentHtml({ ticketNumber: "TCK-2026-81490", sequenceLabel: "EXAI-101", subject: "ระบบเบิกค่าการศึกษาบุตร - ไม่มีระดับ ปวส.", url: "https://projects.oneweb.tech/cs-team/projects/p/issues/i" });
  assert.ok(html.includes("🔗 ลูกค้าเปิดเคสใหม่ต่อจากเคสนี้: <strong>TCK-2026-81490 (EXAI-101)</strong>"));
  assert.ok(html.includes("เรื่อง: ระบบเบิกค่าการศึกษาบุตร - ไม่มีระดับ ปวส."));
  assert.ok(html.includes('<a href="https://projects.oneweb.tech/cs-team/projects/p/issues/i">เปิดเคสใหม่ใน Plane</a>'));
  assert.ok(followUpCommentHtml({ ticketNumber: "TCK-1", sequenceLabel: null, subject: "<b>x</b>", url: null }).includes("&lt;b&gt;x&lt;/b&gt;"));
});

check("F-05 the LINE chip now names the closed case", () => {
  const chips = closedReferenceChips("TCK-2026-86186", new Date(Date.now() - 86_400_000), 7);
  assert.equal(chips[0].label, "เปิดเคสใหม่จากเรื่องนี้");
  assert.equal(chips[0].text, "เปิดเคสใหม่: ติดตามต่อจาก TCK-2026-86186");
  assert.ok(parseNewCaseCommand(chips[0].text));
  assert.equal(closedReferenceChips(null, null, 7)[0].text, "เปิดเคสใหม่");
});

check("F-06 the Plane payload carries the related case; without one nothing changes", () => {
  const ticket = { ticket_number: "TCK-2026-81490", subject: "ระบบเบิกค่าการศึกษาบุตร - ไม่มีระดับ ปวส.", summary: "ไม่มีระดับ ปวส. ให้เลือก", priority: "Medium", conversation_id: 99961 };
  const withLink = buildPlaneWorkItemPayload(ticket, "กรมสรรพสามิต", undefined, related);
  assert.ok(withLink.description_html.includes("<li><strong>Related case:</strong> TCK-2026-86186 (EXAI-98) · ปิดเมื่อ 18/09/2026 13:27</li>"));
  assert.ok(withLink.description_html.includes("<h3>🔗 Follow-up of a closed case</h3>"));
  assert.ok(withLink.description_html.indexOf("<h3>Customer report</h3>") < withLink.description_html.indexOf("Follow-up of a closed case"));
  const plain = buildPlaneWorkItemPayload(ticket, "กรมสรรพสามิต");
  assert.ok(!plain.description_html.includes("Related case"));
  assert.ok(!plain.description_html.includes("Follow-up"));
});

check("F-07 a cancelled case gets no re-open chip and its own protection wording", () => {
  const cancelledChips = closedReferenceChips("TCK-2026-73046", new Date(Date.now() - 3_600_000), 7, "CANCELLED");
  assert.deepEqual(cancelledChips.map((c) => c.label), ["เปิดเคสใหม่จากเรื่องนี้"]);
  const closedChips = closedReferenceChips("TCK-2026-86186", new Date(Date.now() - 3_600_000), 7, "CLOSED");
  assert.deepEqual(closedChips.map((c) => c.label), ["เปิดเคสใหม่จากเรื่องนี้", "ยังมีปัญหาอยู่"]);
  const resolver = new CaseResolver();
  const cancelled = resolver.resolve({
    conversationId: 99961,
    activeTicketId: null,
    messageText: "สอบถามเรื่องเคส TCK-2026-73046 ที่ปิดไปแล้วหน่อยค่ะ",
    openCases: [],
    closedCases: [{ id: 732, ticket_number: "TCK-2026-73046", subject: "ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ", status: "CANCELLED" }],
  });
  assert.equal(cancelled.type, "CLOSED_CASE_REFERENCE");
  assert.ok(cancelled.clarificationPrompt?.startsWith('เคส TCK-2026-73046 ("ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ") ถูกยกเลิกไปแล้วค่ะ'), cancelled.clarificationPrompt);
});

check("F-08 the forwarded follow-up report names the case and carries the old subject and summary", () => {
  const text = followUpReportText({ ticket_number: "TCK-2026-73046", subject: "ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ", summary: "ลูกค้าต้องการเปลี่ยนสถานะใบเสร็จเล่มที่ 05 จากชำระแล้วเป็นค้างชำระ", status: "CANCELLED", closed_at: new Date("2026-09-18T06:17:35Z") });
  assert.equal(
    text,
    "เปิดเคสใหม่ต่อจากเคส TCK-2026-73046 ที่ยกเลิกไปแล้ว\nเรื่อง: ระบบชดใช้เงินยืม - ขอย้อนสถานะใบเสร็จเล่มที่ 05 เป็นค้างชำระ\nรายละเอียด: ลูกค้าต้องการเปลี่ยนสถานะใบเสร็จเล่มที่ 05 จากชำระแล้วเป็นค้างชำระ\nเคสเดิม: TCK-2026-73046 (ยกเลิกเมื่อ 18/09/69 เวลา 13:17 น.)"
  );
  assert.equal(followUpReportText({ ticket_number: "TCK-1", subject: "X", summary: "X", status: "CLOSED" }), "เปิดเคสใหม่ต่อจากเคส TCK-1 ที่ปิดไปแล้ว\nเรื่อง: X\nเคสเดิม: TCK-1");
  assert.equal(parseNewCaseCommand(text), null, "the forwarded report must not be read as a bare command again");
});

console.log(`\n${passed} checks passed${process.exitCode ? ", with failures" : ""}`);
