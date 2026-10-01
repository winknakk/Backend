/**
 * Builds src/fixtures/pm1-behavioral-examples.json from the PM1 UAT support
 * chat (docs/PM1_UAT_Support_Chat_แยกตามเคส.md).
 *
 * PM1 is a different product. The output is a BEHAVIORAL dataset only (how
 * customers phrase requests and how support acknowledges, asks, escalates and
 * closes), never TicketX knowledge. Every message is sanitized here before it
 * is written: participant names, @mentions, personal names with titles,
 * usernames, URLs, contact details, long digit runs and credentials.
 *
 *   npx tsx src/cli/build-pm1-behavioral-fixture.ts
 */
import fs from "fs";
import path from "path";
import { minimizePii } from "../services/ConversationContextBuilder";
import { redactSecrets } from "../security/secretRedaction";

const SOURCE = path.resolve(__dirname, "../../../../docs/PM1_UAT_Support_Chat_แยกตามเคส.md");
const OUT = path.resolve(__dirname, "../fixtures/pm1-behavioral-examples.json");

type Role = "customer" | "support";
interface Message { role: Role; text: string }
interface Case { id: number; title: string; outcome: string; messages: Message[] }

const raw = fs.readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");
const lines = raw.split("\n");

// Participant display names come from the participants table, so the list
// never has to be typed (or committed) by hand.
const names = new Set<string>();
for (const l of lines) {
  const m = /^\*\*(?:🙋|🛠️)\s+(.+?)\*\*\s+·/.exec(l);
  if (m) names.add(m[1].trim());
}
const nameList = Array.from(names)
  .flatMap((n) => [n, n.replace(/\s*\(.*?\)\s*$/, "").trim()])
  .filter((n) => n.length >= 2)
  .sort((a, b) => b.length - a.length);

// Nicknames used inside message text for the same participants.
const NICKNAMES = ["คุณไอซ์", "ไอซ์", "พี่แจน", "พี่แจนค่ะ", "ผมเฮง", "เฮง"];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitize(text: string): string {
  let t = text;
  for (const n of nameList) t = t.replace(new RegExp(escapeRe(n), "g"), "[ชื่อ]");
  for (const n of NICKNAMES) t = t.replace(new RegExp(escapeRe(n), "g"), "[ชื่อ]");
  t = t
    .replace(/@\[ชื่อ\]/g, "@[ชื่อ]")
    .replace(/@(?!\[ชื่อ\])\S+/g, "@[ชื่อ]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    // Titled personal names, titles possibly chained ("ผู้ช่วยศาสตราจารย์ ดร.X Y");
    // "นายก" (prime minister) is not a person's name.
    .replace(/(?:(?:ผู้ช่วยศาสตราจารย์|รองศาสตราจารย์|ศาสตราจารย์|นางสาว|น\.ส\.|ดร\.|นาง|นาย(?!ก))\s*)+[ก-๙]+(?:\s+[ก-๙]+)?/g, "[ชื่อบุคคล]")
    // "คุณ<name> <surname>"; not ขอบคุณ, คุณภาพ, คุณค่า or a bare polite "คุณครับ".
    .replace(/(?<!ขอบ)คุณ(?!ภาพ|สมบัติ|ค่า|ค่ะ|คะ|ครับ|คร่า|มาก|\[)[ก-๙]{2,}(?:\s+[ก-๙]{3,}(?=\s))?/g, "คุณ[ชื่อ]")
    .replace(/\b(user(?:name)?|ยูสเซอร์)\s*:?\s*[A-Za-z0-9._-]{3,}/gi, "$1 [username]")
    .replace(/\b[a-z]{2,}\.[a-z]{2,}\b/g, "[username]");
  return minimizePii(redactSecrets(t)).replace(/[ \t]+/g, " ").trim();
}

function isNoise(text: string): boolean {
  return /^!\[|^🖼️|^📎|^\[วิดีโอ|^<sub>|^\(.*\)$/.test(text) || text.length === 0;
}

const cases: Case[] = [];
const outcomes = new Map<number, string>();
for (const l of lines) {
  const m = /^\|\s*(\d+)\s*\|.*\|\s*([^|]*?)\s*\|\s*[^|]*\|?\s*$/.exec(l);
  if (m && /\(#case-\d+\)/.test(l)) {
    const cells = l.split("|").map((c) => c.trim());
    outcomes.set(Number(m[1]), cells[5] || "");
  }
}

let current: Case | null = null;
let role: Role | null = null;
let buffer: string[] = [];

function flush() {
  if (current && role && buffer.length) {
    const text = sanitize(buffer.join("\n").replace(/\n{2,}/g, "\n"));
    if (text && !isNoise(text)) current.messages.push({ role, text });
  }
  buffer = [];
}

for (const l of lines) {
  const head = /^## เคส (\d+) · (.+)$/.exec(l);
  if (head) {
    flush();
    role = null;
    current = { id: Number(head[1]), title: sanitize(head[2]), outcome: outcomes.get(Number(head[1])) || "", messages: [] };
    cases.push(current);
    continue;
  }
  if (!current) continue;
  const speaker = /^\*\*(🙋|🛠️)\s+.+?\*\*\s+·/.exec(l);
  if (speaker) {
    flush();
    role = speaker[1] === "🙋" ? "customer" : "support";
    continue;
  }
  if (/^\*\*📅/.test(l) || /^<sub>/.test(l) || /^---$/.test(l)) {
    flush();
    if (!/^\*\*📅/.test(l)) role = null;
    continue;
  }
  if (role && l.startsWith(">")) {
    let body = l.replace(/^>\s?/, "");
    const timed = /^`\d{1,2}:\d{2}`\s*(.*)$/.exec(body);
    if (timed) {
      flush();
      body = timed[1];
    }
    if (isNoise(body.trim())) continue;
    buffer.push(body);
  }
}
flush();

const fixture = {
  source: "docs/PM1_UAT_Support_Chat_แยกตามเคส.md",
  purpose:
    "BEHAVIORAL EXAMPLES ONLY. PM1 is a different product: use for phrasing, intent, safety and routing regression; never as TicketX knowledge.",
  sanitization:
    "names, @mentions, titled personal names, usernames, URLs, emails, phones, 9+ digit runs and credentials replaced with placeholders",
  caseCount: cases.length,
  messageCount: cases.reduce((n, c) => n + c.messages.length, 0),
  cases,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${OUT}: ${fixture.caseCount} cases, ${fixture.messageCount} messages`);
