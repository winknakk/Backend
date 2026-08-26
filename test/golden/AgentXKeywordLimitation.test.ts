import assert from "assert";
import { describe, it } from "node:test";

/**
 * PHASE 8 — AI-01, measured rather than described.
 *
 * This originally reproduced AgentRuntime's substring predicate and recorded
 * a 9-of-9 false-positive rate. AgentRuntime now delegates to the structured
 * classifier, so this calls the SAME function the production path calls
 * rather than a copy — a copy would let the two drift and quietly stop
 * measuring anything.
 */
import { shouldCreateTicket } from "../../src/domain/intent/IntentClassifier";

/** The production decision, called directly. */
function needsTicketEscalation(input: string): boolean {
  return shouldCreateTicket(input);
}

interface Probe {
  text: string;
  shouldTicket: boolean;
  why: string;
}

const PROBES: Probe[] = [
  // --- 1. genuine technical incidents: must open a ticket ---
  { text: "ระบบเข้าใช้งานไม่ได้ครับ ขึ้น 502 Bad Gateway", shouldTicket: true, why: "1. real incident (Thai)" },
  { text: "ระบบล่มตั้งแต่เมื่อเช้าครับ", shouldTicket: true, why: "1. real incident (Thai)" },
  { text: "The app crashed when I opened the report", shouldTicket: true, why: "1. real incident (English)" },
  { text: "Getting error 500 on login", shouldTicket: true, why: "1. real incident with error code" },

  // --- 2/3. the literal words ---
  { text: "I found a bug", shouldTicket: true, why: "2. literal 'bug' reporting a defect" },
  { text: "How do I debug my own integration?", shouldTicket: false, why: "3. 'debug' is a question, not an incident" },

  // --- 4. 'bug' inside another word or an unrelated context ---
  { text: "There is a bug in my garden, is that covered by your pest module?", shouldTicket: false, why: "4. insect, not defect" },
  { text: "Please add a Debugger panel to the roadmap", shouldTicket: false, why: "4. feature request containing 'bug'" },
  { text: "Can you send the Bugatti invoice?", shouldTicket: false, why: "4. 'bug' inside a proper noun" },
  { text: "My colleague Bugsy will contact you", shouldTicket: false, why: "4. 'bug' inside a name" },

  // --- 5. Thai technical complaint ---
  { text: "ระบบมีปัญหาเรื่องการออกรายงานครับ", shouldTicket: true, why: "5. Thai technical complaint" },

  // --- 6. unrelated question containing a technical keyword ---
  { text: "เมื่อวานระบบล่มใช่ไหมครับ ตอนนี้ปกติแล้วใช่ไหม", shouldTicket: false, why: "6. question about a PAST outage" },
  { text: "Do you have a page explaining what a fatal error means?", shouldTicket: false, why: "6. documentation question" },
  { text: "Our training deck mentions 'crash recovery' — can you review it?", shouldTicket: false, why: "6. review request" },
  { text: "ขอบคุณครับ ไม่มีอะไรพังแล้ว ใช้งานได้ปกติ", shouldTicket: false, why: "6. says nothing is broken any more" },
];

describe("PHASE 8 — AI-01 intent classification", () => {
  it("opens a ticket for genuine technical incidents", () => {
    const missed = PROBES.filter((p) => p.shouldTicket && !needsTicketEscalation(p.text));
    assert.deepStrictEqual(
      missed.map((p) => p.why),
      [],
      `false NEGATIVES — a real incident produced no ticket:\n${missed.map((p) => `  - ${p.text}`).join("\n")}`
    );
  });

  it("AI-01: does not open a ticket for non-incidents", () => {
    const falsePositives = PROBES.filter((p) => !p.shouldTicket && needsTicketEscalation(p.text));

    if (falsePositives.length > 0) {
      console.log(`\n  AI-01 FALSE POSITIVES (${falsePositives.length}/${PROBES.filter((p) => !p.shouldTicket).length} non-incidents wrongly ticketed):`);
      falsePositives.forEach((p) => console.log(`    "${p.text}"\n      -> ${p.why}`));
      console.log("");
    }

    assert.deepStrictEqual(
      falsePositives.map((p) => p.text),
      [],
      `AI-01 REGRESSION — ${falsePositives.length} non-incident(s) would create a ticket`
    );
  });

  it("records the measured false-positive rate", () => {
    const negatives = PROBES.filter((p) => !p.shouldTicket);
    const wrong = negatives.filter((p) => needsTicketEscalation(p.text));
    const rate = ((wrong.length / negatives.length) * 100).toFixed(0);
    console.log(`  AI-01 measured false-positive rate: ${wrong.length}/${negatives.length} (${rate}%) — was 9/9 (100%)`);
    assert.strictEqual(wrong.length, 0, "the false-positive rate must stay at zero");
  });
});
