/**
 * Prompt safety contract — static assertions over the flow's LLM prompts.
 *
 * No PromptX call, no LLM, no network: this parses the flow asset and asserts
 * textual invariants. It exists because the customer-facing prompt, not the
 * backend, produced a false success message in production.
 *
 * Runtime evidence (conversation 99961, 2026-09-18, msg at 12:17:16):
 *   customer 12:14:13  "แอดมินคะ ขอยกเลิกเคส TCK-2026-73046 ให้หน่อยค่ะ …"
 *   ai       12:17:16  "รับทราบค่ะ แอดมินยกเลิกการเปิดเคสให้เรียบร้อยแล้วนะคะ …"
 *   tickets#732 updated_at stayed 13:17:35 — nothing was cancelled.
 * That AI sentence is **verbatim** CANCEL_RESET template #1 in step_1. The model
 * did not hallucinate; it rendered the template it was given. CANCEL_RESET means
 * "an intake draft was discarded", but its wording is indistinguishable, to a
 * customer, from "your filed case was cancelled".
 *
 * NOTE ON DEPLOYMENT: per .ai/FLOWS.md (2026-09-03) the deployed flow set is
 * UNKNOWN. This asserts the tracked asset under เริ่มต้นใหม่อีกครั้ง/. Passing
 * here does NOT prove the deployed flow is safe.
 */
import fs from "fs";
import path from "path";

const FLOW = path.resolve(
  __dirname,
  "../../../แล้วกู๊ดจะกลับมาใน AVENGERS DOOMSDAY/All Workflows (ใช้งานในปัจจุบัน)/Main AI Core Flow.json"
);

function stepSettings(root: unknown, wanted: Set<string>): Record<string, any> {
  const out: Record<string, any> = {};
  (function walk(n: any) {
    if (n && typeof n === "object") {
      if (!Array.isArray(n) && typeof n.name === "string" && wanted.has(n.name) && n.type) {
        out[n.name] = n.settings ?? {};
      }
      for (const v of Object.values(n)) walk(v);
    }
  })(root);
  return out;
}

const raw = fs.readFileSync(FLOW, "utf8").replace(/^﻿/, "");
const flow = JSON.parse(raw);
const steps = stepSettings(flow, new Set(["step_1", "step_gate_agent"]));

/**
 * The prompt text may be inline, or (since the flow refactor that moved the
 * customer prompt into CODE steps such as `step_system_prompt`) a template
 * reference like {{step_system_prompt['systemPrompt']}}. A reference is
 * resolved to the referenced step's source code, which is where the prompt
 * text now lives. The assertions below are unchanged: they still require the
 * rule text to be present, wherever the flow keeps it.
 */
const codeSteps: Record<string, string> = {};
(function walk(n: any) {
  if (n && typeof n === "object") {
    if (!Array.isArray(n) && typeof n.name === "string" && n.type === "CODE" && typeof n.settings?.sourceCode?.code === "string") {
      codeSteps[n.name] = n.settings.sourceCode.code;
    }
    for (const v of Object.values(n)) walk(v);
  }
})(flow);
const resolveRefs = (text: string): string =>
  text.replace(/\{\{\s*(step_[A-Za-z0-9_]+)[^}]*\}\}/g, (whole, name) => codeSteps[name] ?? whole);

const customerPrompt: string = resolveRefs(
  (steps.step_1?.input?.roles ?? []).map((r: any) => String(r?.content ?? "")).join("\n\n")
);
const gatePrompt: string = resolveRefs(String(steps.step_gate_agent?.input?.message ?? ""));

if (!customerPrompt || !gatePrompt) {
  console.log("ERR: could not extract prompts from the flow asset");
  process.exit(1);
}

interface Assertion {
  id: string;
  what: string;
  principle: string;
  ok: boolean;
  detail?: string;
}
const results: Assertion[] = [];
const add = (id: string, what: string, principle: string, ok: boolean, detail?: string) =>
  results.push({ id, what, principle, ok, detail });

/** The CANCEL_RESET block of the customer prompt. */
const cancelResetBlock = (() => {
  const start = customerPrompt.indexOf("## CANCEL_RESET");
  if (start < 0) return "";
  const rest = customerPrompt.slice(start + 5);
  const end = rest.indexOf("\n## ");
  return end < 0 ? customerPrompt.slice(start) : customerPrompt.slice(start, start + 5 + end);
})();

// --- P3: never claim an action succeeded before the backend confirms -------
add(
  "P-01",
  "CONFIRM_CLOSE_PENDING forbids saying the case is closed",
  "3. Do not claim action success before backend confirmation.",
  /ห้ามบอกว่าปิดเคสแล้ว/.test(customerPrompt)
);
add(
  "P-02",
  "CONFIRM_REOPEN_PENDING forbids saying the case was reopened",
  "3. Do not claim action success before backend confirmation.",
  /ห้ามบอกว่าเปิดเคสแล้ว/.test(customerPrompt)
);
add(
  "P-03",
  "gate: CLOSE never closes by itself",
  "1. Backend result is authoritative.",
  /CLOSE never closes the case by itself/i.test(gatePrompt)
);
add(
  "P-04",
  "gate: REOPEN never reopens by itself",
  "1. Backend result is authoritative.",
  /REOPEN never\s+reopens the case by itself/i.test(gatePrompt)
);
add(
  "P-05",
  "NO_TICKET_OPERATION forbids any ticket claim",
  "3. Do not claim action success before backend confirmation.",
  /make no claim about any ticket, number, status, or deadline/i.test(customerPrompt)
);
add(
  "P-06",
  "no-context fallback forbids inventing ticket data",
  "2. Do not infer a ticket when backend returns ambiguity.",
  /Invent no ticket data/i.test(customerPrompt)
);
add(
  "P-07",
  "TICKET_OP_FAILED forbids implying a case was opened",
  "9. Backend rejection -> report failure, never success.",
  /never invent one and never imply a case was opened/i.test(customerPrompt)
);

// --- the production defect --------------------------------------------------
const AMBIGUOUS_CANCEL = "แอดมินยกเลิกการเปิดเคสให้เรียบร้อยแล้ว";
add(
  "P-08",
  "CANCEL_RESET has no template that reads as cancelling a filed case",
  "3 + 4. A discarded draft must not be worded like a completed cancellation.",
  !cancelResetBlock.includes(AMBIGUOUS_CANCEL),
  `template "${AMBIGUOUS_CANCEL}…" states a completed cancellation without saying nothing was saved. ` +
    "It is the exact sentence sent at 12:17:16 in conversation 99961 while the ticket was untouched."
);

// Every CANCEL_RESET example line must make the "nothing exists" fact explicit.
const cancelTemplates = cancelResetBlock
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith('- "') && l.endsWith('"'));
const NOTHING_SAVED = /ยังไม่มีเคส|ไม่มีข้อมูลถูกบันทึก|ยังไม่ได้เปิดเคส|ยังไม่มีการเปิดเคส|ไม่มีเคสถูกเปิด/;
const weak = cancelTemplates.filter((t) => !NOTHING_SAVED.test(t));
add(
  "P-09",
  "every CANCEL_RESET template states that nothing was saved",
  "3. Do not claim action success before backend confirmation.",
  cancelTemplates.length > 0 && weak.length === 0,
  weak.length ? `${weak.length}/${cancelTemplates.length} template(s) do not say it:\n      ${weak.join("\n      ")}` : undefined
);

add(
  "P-10",
  "gate: CANCEL_RESET excludes a message that names a filed ticket",
  "4. Do not treat a filed-case request as a draft reset.",
  /Never output CANCEL_RESET for it/i.test(gatePrompt) && /TCK-YYYY-NNNNN/.test(gatePrompt),
  "gate rule 2 matches ANY of ยกเลิก/cancel/ไม่เอา… with no exclusion for a message carrying a TCK number."
);
add(
  "P-10b",
  "gate: the CANCEL_RESET precondition is restated inside the rule, not only in the section header",
  "4. Do not treat a filed-case request as a draft reset.",
  /PRECONDITION \(restated, overrides the word ANY above\)/i.test(gatePrompt),
  "the 'only while a create-confirmation is pending' guard appears once in prose at the top of the " +
    "section, while the rule itself says 'Match ANY cancellation' — which is what the model followed."
);

// --- ASK_CLARIFICATION / ambiguity -----------------------------------------
add(
  "P-11",
  "an ambiguity/clarification context exists for the customer prompt",
  "8. ASK_CLARIFICATION means ask the customer, not guess.",
  /ASK_CLARIFICATION|AMBIGUOUS|## CONFIRM_SAME_CASE/.test(customerPrompt),
  "nearest existing section is CONFIRM_SAME_CASE; there is no section named for the resolver's AMBIGUOUS_CASE."
);
add(
  "P-12",
  "CLOSE with no resolvable target asks which case rather than only offering a new one",
  "4. Do not create a new ticket merely because the CLOSE target is missing.",
  /Action CLOSE \/ REOPEN:[\s\S]{0,700}?(เคสไหน|which case|เลือกเคส)/.test(customerPrompt) &&
    /a missing close target is NEVER\s+a reason to open a new case/i.test(customerPrompt),
  "TICKET_REF_NOT_FOUND must give CLOSE / REOPEN their own bullet that asks which case. While CLOSE shares " +
    "the GET_STATUS / FIND bullet, the model is told to 'ask what is happening so you can open a new case', " +
    "which steers to intake instead of asking which case to close."
);

// --- CLOSED tickets ---------------------------------------------------------
add(
  "P-13",
  "TICKET_ALREADY_CLOSED exists and does not write to the closed case",
  "5. Do not write to CLOSED tickets.",
  /## TICKET_ALREADY_CLOSED/.test(customerPrompt) && /ปิดไปแล้ว|ปิดเรียบร้อยอยู่แล้ว/.test(customerPrompt)
);
add(
  "P-14",
  "gate: explicit ticket reference is honoured over the active case",
  "6. Explicit ticket reference takes precedence over active case.",
  /WITHOUT naming a ticket number/i.test(gatePrompt),
  "ACTIVE CASE RULE applies only when no ticket number is named, which is the correct precedence."
);

const passed = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);

console.log("Prompt safety contract — static, no LLM call\n");
console.log(`asset: แล้วกู๊ดจะกลับมาใน AVENGERS DOOMSDAY/All Workflows (ใช้งานในปัจจุบัน)/Main AI Core Flow.json`);
console.log(`step_1 prompt: ${customerPrompt.length} chars   gate prompt: ${gatePrompt.length} chars\n`);
for (const r of results) {
  console.log(`  ${r.ok ? "ผ่าน" : "พลาด"}  ${r.id}  ${r.what}`);
  if (!r.ok) {
    console.log(`         หลักการ: ${r.principle}`);
    if (r.detail) console.log(`         พบ: ${r.detail}`);
  }
}
console.log(`\n${"=".repeat(96)}`);
console.log(`ผ่าน ${passed.length}/${results.length}`);
if (failed.length) {
  console.log(`พลาด ${failed.length}: ${failed.map((f) => f.id).join(", ")}`);
  process.exit(1);
}
