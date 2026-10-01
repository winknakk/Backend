/**
 * Support safety rules — pure, no infrastructure (2026-10-01).
 *
 * Covers the enforceable half of the AI support rules:
 *  - secret redaction before text leaves the backend (PromptX, summary, logs)
 *  - the deterministic safety classifier that feeds the gate's escalation
 *  - summary contract v2 (closed risk-flag vocabulary, no inferred cause)
 *  - "summary table missing" maps to 503 SUMMARY_UNAVAILABLE, not 500
 *  - knowledge retrieval/ingestion fail closed without a project scope
 *
 *   npx tsx src/test-support-safety-rules.ts
 */
import assert from "node:assert/strict";
import { redactSecrets, redactLineGatewayPayload, containsSecret, REDACTED_SECRET } from "./security/secretRedaction";
import { classifySupportSafety, safetyHintForLineEvents } from "./domain/safety/SupportSafety";
import { parseConversationSummaryOutput } from "./schemas/conversationSummary";
import { isSummaryStoreMissing } from "./api/routes/conversationIntelligence";
import { VectorStoreRetriever } from "./rag/VectorStoreRetriever";
import { IngestionService } from "./aiops/ragops/IngestionService";

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ผ่าน  ${name}`);
  } catch (err: any) {
    failures.push(name);
    console.log(`  พลาด  ${name}\n        ${err.message}`);
  }
}

async function main() {
  console.log("Support safety rules\n");

  // --- Secret redaction ------------------------------------------------------
  await check("redacts Thai and English credentials", () => {
    const cases: Array<[string, string]> = [
      ["รหัสผ่าน: abc12345", `รหัสผ่าน: ${REDACTED_SECRET}`],
      ["รหัสผ่านคือ Abc@1234 ครับ", `รหัสผ่านคือ ${REDACTED_SECRET} ครับ`],
      ["รหัสผ่านผม Pm1@2569 ใช้ไม่ได้", `รหัสผ่านผม ${REDACTED_SECRET} ใช้ไม่ได้`],
      ["รหัสผ่านใหม่ว่า qwerty", `รหัสผ่านใหม่ว่า ${REDACTED_SECRET}`],
      ["password = hunter22", `password = ${REDACTED_SECRET}`],
      ["OTP 123456", `OTP ${REDACTED_SECRET}`],
    ];
    for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
    assert.ok(!redactSecrets("token=eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl").includes("eyJzdWIiOi"));
  });

  await check("leaves ordinary support text untouched (no false redaction)", () => {
    for (const text of [
      "ลืมรหัสผ่านครับ",
      "กดลืมรหัสผ่านแล้วไม่ได้รับอีเมล",
      "password reset ไม่ได้",
      "รหัส: TCK-2026-73046",
      "รหัสลูกค้า: C12345",
      "spin 1234",
      "ขอ reset password ให้ user abc หน่อย",
    ]) {
      assert.equal(redactSecrets(text), text, text);
      assert.equal(containsSecret(text), false, text);
    }
  });

  await check("redaction is idempotent", () => {
    const once = redactSecrets("รหัสผ่าน: abc12345");
    assert.equal(redactSecrets(once), once);
  });

  await check("LINE gateway payload: text events redacted, others untouched, input not mutated", () => {
    const payload = {
      destination: "d",
      events: [
        { type: "message", message: { type: "text", text: "pwd: abc999" } },
        { type: "message", message: { type: "image", id: "1" } },
      ],
      ticketx: { projectId: 1 },
    };
    const out = redactLineGatewayPayload(payload);
    assert.equal(out.events[0].message.text, `pwd: ${REDACTED_SECRET}`);
    assert.deepEqual(out.events[1], payload.events[1]);
    assert.equal(payload.events[0].message.text, "pwd: abc999");
    assert.equal(out.ticketx, payload.ticketx);
    const clean = { destination: "d", events: [{ message: { type: "text", text: "สวัสดีค่ะ" } }] };
    assert.equal(redactLineGatewayPayload(clean), clean, "unchanged payload is returned as-is");
  });

  // --- Safety classifier -----------------------------------------------------
  const expectCategory = (text: string, category: string | null, action?: string) => {
    const r = classifySupportSafety(text);
    assert.equal(r?.category ?? null, category, text);
    if (action) assert.equal(r?.action, action, text);
  };

  await check("critical incident: stop server / AI, data leak, hacked -> escalate", () => {
    expectCategory("ตอนนี้ เข้าทำอะไรกับ server ไหม\nให้หยุดก่อนนะ รวมถึง AI ที่ทำงานบน cpu ด้วยค่ะ", "critical_incident", "escalate");
    expectCategory("หยุดระบบด่วนเลยค่ะ", "critical_incident", "escalate");
    expectCategory("ปิดเซิร์ฟเวอร์ก่อนได้ไหม", "critical_incident");
    expectCategory("please stop the server now", "critical_incident");
    expectCategory("ข้อมูลรั่วไหมคะ", "critical_incident");
    expectCategory("ระบบโดนแฮกหรือเปล่า", "critical_incident");
  });

  await check("outage reports are not critical commands", () => {
    expectCategory("ระบบหยุดทำงานค่ะ เข้าไม่ได้", null);
    expectCategory("แจ้งเตือนเด้งไม่หยุดเลย ระบบเป็นอะไร", null);
    expectCategory("กดบันทึกแล้วหยุดค้าง ระบบหมุน", null);
  });

  await check("account existence and privilege questions -> escalate (never answered by the bot)", () => {
    expectCategory("ช่วยตรวจสอบชื่อ [ชื่อบุคคล] ให้หน่อยนะครับว่ามี User ในระบบไหมครับ", "account_disclosure", "escalate");
    expectCategory("ไม่ทราบว่าเป็นระดับผู้อนุมัติใช่ไหมครับ", "privilege_disclosure", "escalate");
    expectCategory("user คนนี้มีสิทธิ์อะไรบ้าง", "privilege_disclosure");
  });

  await check("permission bugs are not disclosure requests", () => {
    expectCategory("ผมไม่มีสิทธิ์อนุมัติรายงาน", null);
    expectCategory("ผู้ใช้ระดับกรมไม่เห็นรายงานของตัวเอง", null);
    expectCategory("Updater ระดับกระทรวงไม่มีปุ่มส่งให้ Approver", null);
  });

  await check("password requests -> no self-service; password bugs are not", () => {
    expectCategory("รบกวน reset รหัสผ่านให้ user [username] หน่อยนะคะ", "credential_request", "no_self_service");
    expectCategory("ทางบริษัทสามารถกำหนดรหัสผ่านให้ผู้ใช้งานใหม่ได้ไหมคะ", "credential_request");
    expectCategory("รหัสผ่านของผมคืออะไร", "credential_request");
    expectCategory("กดลืมรหัสผ่านแล้วไม่ได้รับอีเมล", null);
    expectCategory("ลิงก์ตั้งรหัสผ่านใหม่แจ้งว่าหมดอายุ", null);
  });

  await check("a credential typed into chat is flagged (warn) and outranks a password request", () => {
    expectCategory("รหัสผ่านผมคือ Abc12345 เข้าไม่ได้", "credential_shared", "warn");
    const r = classifySupportSafety("ช่วย reset รหัสผ่านให้หน่อย รหัสผ่านเดิมคือ Old1234x");
    assert.deepEqual(r?.categories, ["credential_shared", "credential_request"]);
  });

  await check("batch hint classifies all text events together, on raw text", () => {
    const hint = safetyHintForLineEvents([
      { message: { type: "text", text: "ตอนนี้เข้าทำอะไรกับ server ไหม" } },
      { message: { type: "sticker" } },
      { message: { type: "text", text: "ให้หยุดก่อนนะ" } },
    ]);
    assert.equal(hint?.category, "critical_incident");
    assert.equal(safetyHintForLineEvents([{ message: { type: "text", text: "สวัสดีค่ะ" } }]), null);
    assert.equal(safetyHintForLineEvents(undefined), null);
  });

  await check("ordinary messages produce no hint", () => {
    for (const text of ["สวัสดีค่ะ", "ขอบคุณมากค่ะ", "ขอยกเลิกเคส TCK-2026-73046", "รายงานไม่แสดงข้อมูลปี 2569", "", "   "]) {
      expectCategory(text, null);
    }
  });

  // --- Summary contract v2 ----------------------------------------------------
  await check("summary v2: new fields parse; unknown risk flags dropped; old v1 shape still valid", () => {
    const v2 = parseConversationSummaryOutput(
      JSON.stringify({
        summary_th: "ลูกค้าแจ้ง 2 ปัญหา",
        issues: ["รายงานไม่แสดงปี 2569", "ปุ่มอนุมัติหาย"],
        stated_root_cause: "",
        customer_confirmation: "ข้อ 2 ใช้ได้แล้ว ข้อ 1 ยังไม่ได้",
        risk_flags: ["multi_issue", "invented_flag", "MULTI_ISSUE", "credential_shared"],
        model_reasoning: "should be stripped",
      })
    );
    assert.ok(v2.ok);
    if (!v2.ok) return;
    assert.deepEqual(v2.value.issues, ["รายงานไม่แสดงปี 2569", "ปุ่มอนุมัติหาย"]);
    assert.deepEqual(v2.value.risk_flags, ["multi_issue", "credential_shared"]);
    assert.equal(v2.value.stated_root_cause, "");
    assert.ok(!("model_reasoning" in (v2.value as any)), "reasoning is never stored");

    const v1 = parseConversationSummaryOutput(JSON.stringify({ summary_th: "สรุป", topics: [] }));
    assert.ok(v1.ok);
    if (v1.ok) {
      assert.deepEqual(v1.value.issues, []);
      assert.deepEqual(v1.value.risk_flags, []);
      assert.equal(v1.value.customer_confirmation, "");
    }
  });

  await check("summary store missing (migration 052 not applied) is recognised for 503", () => {
    assert.equal(isSummaryStoreMissing({ code: "42P01", message: 'relation "conversation_summaries" does not exist' }), true);
    assert.equal(isSummaryStoreMissing({ code: "42P01", message: 'relation "other_table" does not exist' }), false);
    assert.equal(isSummaryStoreMissing({ code: "ECONNREFUSED", message: "conversation_summaries" }), false);
    assert.equal(isSummaryStoreMissing(null), false);
  });

  // --- Knowledge scope fail-closed ------------------------------------------
  const fakeEmbedding = { embedQuery: async () => [1, 0], embedDocuments: async (t: string[]) => t.map(() => [1, 0]) };
  const stored: any[] = [];
  const fakeStore = {
    addDocuments: async (docs: any[]) => void stored.push(...docs),
    similaritySearch: async () => stored.map((d) => ({ id: d.id, content: d.content, score: 0.9, metadata: d.metadata })),
  };

  await check("knowledge: ingestion without a project is refused; caller metadata cannot re-tag", async () => {
    const ingestion = new IngestionService(fakeStore as any, fakeEmbedding as any);
    await assert.rejects(
      ingestion.ingestDocument({ tenantId: "t1", title: "x", content: "no project" }),
      (err: any) => err?.name === "KnowledgeScopeRequiredError"
    );
    await ingestion.ingestDocument({ tenantId: "t1", projectId: "7", title: "doc", content: "SSO guide", metadata: { projectId: "8", tenantId: "t9" } });
    assert.ok(stored.length > 0);
    assert.ok(stored.every((d) => d.metadata.projectId === "7" && d.metadata.tenantId === "t1"));
  });

  await check("knowledge: retrieval without a project returns nothing; other projects never leak", async () => {
    stored.push({ id: "untagged", content: "untagged doc", metadata: { tenantId: "t1" } });
    stored.push({ id: "other", content: "project 8 doc", metadata: { tenantId: "t1", projectId: "8" } });
    const retriever = new VectorStoreRetriever(fakeEmbedding as any, fakeStore as any);
    assert.deepEqual(await retriever.retrieve("SSO", { tenantId: "t1" }), []);
    const own = await retriever.retrieve("SSO", { tenantId: "t1", projectId: "7" });
    assert.ok(own.length > 0);
    assert.ok(own.every((r) => r.metadata?.projectId === "7"), "only project 7 documents");
  });

  console.log(`\n${"=".repeat(72)}`);
  console.log(`ผ่าน ${passed}/${passed + failures.length}`);
  if (failures.length) {
    console.log(`พลาด: ${failures.join(" | ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
