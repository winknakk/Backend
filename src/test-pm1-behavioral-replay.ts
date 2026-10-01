/**
 * PM1 behavioral replay — 39 real support cases as a regression dataset.
 *
 * Source: src/fixtures/pm1-behavioral-examples.json, built and sanitized by
 * src/cli/build-pm1-behavioral-fixture.ts from docs/PM1_UAT_Support_Chat_แยกตามเคส.md.
 *
 * PM1 is a different product. Nothing here asserts PM1 facts as TicketX
 * knowledge. It asserts behavior only:
 *  - the dataset stays sanitized (no names, usernames, URLs, contacts, secrets)
 *  - safety routing: which cases must escalate or refuse, and that no other
 *    case trips a critical/disclosure rule (false-positive guard)
 *  - close protocol: thanks, "ใช้งานได้แล้ว", and partial verdicts on a
 *    multi-issue update (case 30: "ข้อ 2-6 ผ่าน ข้อ 1 ไม่ผ่าน") never close or
 *    cancel a case by themselves
 *
 *   npx tsx src/test-pm1-behavioral-replay.ts
 */
import fs from "fs";
import path from "path";
import assert from "node:assert/strict";
import { classifySupportSafety, SupportSafetyCategory } from "./domain/safety/SupportSafety";
import { detectCloseIntent, detectCancelIntent } from "./domain/ticket/CustomerConfirmation";
import { containsSecret } from "./security/secretRedaction";

interface Message { role: "customer" | "support"; text: string }
interface Case { id: number; title: string; outcome: string; messages: Message[] }

const FIXTURE = path.resolve(__dirname, "fixtures/pm1-behavioral-examples.json");
const SOURCE = path.resolve(__dirname, "../../../docs/PM1_UAT_Support_Chat_แยกตามเคส.md");
const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { purpose: string; cases: Case[] };
const cases = fixture.cases;

/**
 * Safety categories each case must raise on its customer messages. Every case
 * not listed must raise none of the escalating categories.
 *  23/24/25: customers ask the vendor to set or reset a user's password.
 *  37: "is there a user for this person?" then "is he an approver?".
 *  39: "stop whatever you are doing on the server, including the AI".
 */
const EXPECTED: Record<number, SupportSafetyCategory[]> = {
  23: ["credential_request"],
  24: ["credential_request"],
  25: ["credential_request"],
  37: ["account_disclosure", "privilege_disclosure"],
  39: ["critical_incident"],
};
const ESCALATING: SupportSafetyCategory[] = ["critical_incident", "account_disclosure", "privilege_disclosure"];

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ผ่าน  ${name}`);
  } catch (err: any) {
    failures.push(name);
    console.log(`  พลาด  ${name}\n        ${err.message}`);
  }
}

const customer = (c: Case) => c.messages.filter((m) => m.role === "customer");

console.log("PM1 behavioral replay (behavior only, not knowledge)\n");

check("dataset: 39 cases, each with customer and support turns, marked behavioral-only", () => {
  assert.equal(cases.length, 39);
  assert.deepEqual(cases.map((c) => c.id), Array.from({ length: 39 }, (_, i) => i + 1));
  for (const c of cases) assert.ok(customer(c).length > 0, `case ${c.id} has no customer message`);
  assert.ok(cases.filter((c) => c.messages.some((m) => m.role === "support")).length >= 38);
  assert.match(fixture.purpose, /BEHAVIORAL EXAMPLES ONLY/);
});

check("dataset: sanitized (no emails, URLs, raw @mentions, usernames, long digit runs, secrets)", () => {
  for (const c of cases) {
    for (const m of [{ text: c.title }, ...c.messages]) {
      const t = m.text;
      assert.ok(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(t), `case ${c.id}: email`);
      assert.ok(!/https?:\/\//i.test(t), `case ${c.id}: url`);
      assert.ok(!/@(?!\[ชื่อ\])\S/.test(t), `case ${c.id}: raw @mention`);
      assert.ok(!/\b[a-z]{2,}\.[a-z]{2,}\b/.test(t), `case ${c.id}: username-like token`);
      assert.ok(!/\d(?:[\s-]?\d){8,}/.test(t), `case ${c.id}: long digit run`);
      assert.ok(!containsSecret(t), `case ${c.id}: credential`);
    }
  }
});

check("dataset: no participant display name from the source chat survives", () => {
  if (!fs.existsSync(SOURCE)) return; // source doc not present: covered by the generator
  const names = new Set<string>();
  for (const l of fs.readFileSync(SOURCE, "utf8").split(/\r?\n/)) {
    const m = /^\*\*(?:🙋|🛠️)\s+(.+?)\*\*\s+·/.exec(l);
    if (m) names.add(m[1].replace(/\s*\(.*?\)\s*$/, "").trim());
  }
  const all = JSON.stringify(cases);
  for (const n of names) if (n.length >= 3) assert.ok(!all.includes(n), `participant name leaked (${n.length} chars)`);
});

check("safety: expected cases raise their categories", () => {
  for (const [id, expected] of Object.entries(EXPECTED)) {
    const c = cases.find((x) => x.id === Number(id))!;
    const raised = new Set(customer(c).flatMap((m) => classifySupportSafety(m.text)?.categories ?? []));
    for (const cat of expected) assert.ok(raised.has(cat), `case ${id} should raise ${cat}; got [${[...raised]}]`);
  }
});

check("safety: case 39 (stop the server and the AI) escalates on its first customer turn", () => {
  const first = customer(cases[38]).map((m) => classifySupportSafety(m.text)).find(Boolean);
  assert.equal(first?.category, "critical_incident");
  assert.equal(first?.action, "escalate");
});

check("safety: no other case trips an escalating rule (false-positive guard over 34 cases)", () => {
  for (const c of cases) {
    const expected = EXPECTED[c.id] || [];
    for (const m of customer(c)) {
      const cats = classifySupportSafety(m.text)?.categories ?? [];
      for (const cat of cats) {
        if (ESCALATING.includes(cat)) assert.ok(expected.includes(cat), `case ${c.id} raised ${cat}: "${m.text.slice(0, 60)}"`);
      }
    }
  }
});

check("safety: support-side replies are never classified as a customer credential leak", () => {
  for (const c of cases) for (const m of c.messages) assert.notEqual(classifySupportSafety(m.text)?.category, "credential_shared", `case ${c.id}`);
});

check("close protocol: thanks / 'ใช้งานได้แล้ว' never close or cancel a case by themselves", () => {
  for (const c of cases) {
    for (const m of customer(c)) {
      const close = detectCloseIntent(m.text);
      const cancel = detectCancelIntent(m.text);
      assert.ok(close.kind !== "CLOSE_REQUEST" && close.kind !== "CONFIRM_CLOSE", `case ${c.id} closed by "${m.text.slice(0, 60)}"`);
      assert.equal(cancel.kind, "NONE", `case ${c.id} cancelled by "${m.text.slice(0, 60)}"`);
    }
  }
});

check("multi-issue (case 30): a partial verdict is present and does not close the conversation", () => {
  const c = cases.find((x) => x.id === 30)!;
  const verdict = customer(c).find((m) => /ข้อ\s*2\s*-\s*6/.test(m.text));
  assert.ok(verdict, "the per-item verdict message is in the dataset");
  assert.match(verdict!.text, /ข้อ\s*1/, "the failing item is named");
  assert.equal(detectCloseIntent(verdict!.text).kind, "NONE");
});

console.log(`\n${"=".repeat(72)}`);
console.log(`ผ่าน ${passed}/${passed + failures.length}`);
if (failures.length) {
  console.log(`พลาด: ${failures.join(" | ")}`);
  process.exit(1);
}
