import assert from "assert";
import { describe, it } from "node:test";
import { classifyMessage, MessageIntent } from "../../src/domain/intent/IntentClassifier";

/**
 * AI-01 — every case the demo gate specified, plus the probe set that
 * measured the old classifier at a 100% false-positive rate.
 */

function assertIntent(text: string, expected: MessageIntent, ctx = {}) {
  const r = classifyMessage(text, ctx);
  assert.strictEqual(
    r.intent,
    expected,
    `"${text}"\n    expected ${expected}, got ${r.intent} (rule: ${r.rule}, signals: ${JSON.stringify(r.signals.symptomTerms)})`
  );
}

function assertNoTicket(text: string, ctx = {}) {
  const r = classifyMessage(text, ctx);
  assert.strictEqual(
    r.shouldCreateTicket,
    false,
    `"${text}" wrongly created a ticket (intent ${r.intent}, rule ${r.rule})`
  );
}

function assertTicket(text: string, ctx = {}) {
  const r = classifyMessage(text, ctx);
  assert.strictEqual(
    r.shouldCreateTicket,
    true,
    `"${text}" failed to create a ticket (intent ${r.intent}, rule ${r.rule})`
  );
}

describe("AI-01 — messages that MUST NOT create a ticket", () => {
  it("does not trigger on 'bug' inside another word", () => {
    assertNoTicket("Can you send the Bugatti invoice?");
    assertNoTicket("My colleague Bugsy will contact you.");
    assertNoTicket("Please add a Debugger panel to the roadmap.");
  });

  it("does not trigger on a how-to question", () => {
    assertNoTicket("How do I debug my own integration?");
    assertNoTicket("How do I configure the webhook?");
    assertNoTicket("วิธีตั้งค่า SSO ทำยังไงครับ");
  });

  it("does not trigger when the customer says nothing is broken", () => {
    assertNoTicket("ขอบคุณครับ ไม่มีอะไรพังแล้ว ใช้งานได้ปกติ");
    assertNoTicket("Nothing is broken any more, all good");
    assertNoTicket("ระบบใช้งานได้ปกติแล้วครับ");
  });

  it("does not trigger on a question about a past outage", () => {
    assertNoTicket("เมื่อวานระบบล่มใช่ไหม ตอนนี้ปกติแล้วใช่ไหม");
    assertNoTicket("Was the system down yesterday?");
  });

  it("does not trigger on documentation or review questions", () => {
    assertNoTicket("Do you have a page explaining what a fatal error means?");
    assertNoTicket("Our training deck mentions 'crash recovery' — can you review it?");
  });

  it("does not trigger on a feature request", () => {
    assertNoTicket("Please add a dark mode to the roadmap");
    assertNoTicket("อยากให้เพิ่มปุ่ม export ครับ");
  });

  it("does not trigger on ordinary conversation", () => {
    assertNoTicket("สวัสดีครับ");
    assertNoTicket("ขอบคุณมากครับ");
    assertNoTicket("Can you send the quotation?");
    assertNoTicket("");
  });
});

describe("AI-01 — messages that MUST create a ticket", () => {
  it("opens a ticket for the specified incident reports", () => {
    assertTicket("ระบบเข้าไม่ได้ครับ");
    assertTicket("ระบบล่ม 502");
    assertTicket("ขึ้น 500 ตอน login");
    assertTicket("ไม่สามารถ upload file ได้");
    assertTicket("ระบบช้ามากจนใช้งานไม่ได้");
    assertTicket("API timeout ทุกครั้ง");
  });

  it("opens a ticket for the Golden Flow message", () => {
    assertTicket("ระบบเข้าใช้งานไม่ได้ครับ ขึ้น 502 Bad Gateway");
  });

  it("opens a ticket for English incident reports", () => {
    assertTicket("The app crashed when I opened the report");
    assertTicket("Getting error 500 on login");
    assertTicket("I cannot access the dashboard");
    assertTicket("I found a bug");
  });

  it("opens a ticket for an incident phrased as a question", () => {
    // Asking "why" about a present failure is still reporting it.
    assertTicket("ทำไมระบบเข้าไม่ได้ครับ");
  });
});

describe("AI-01 — intent categories", () => {
  it("classifies the five required categories", () => {
    assertIntent("ระบบเข้าไม่ได้ครับ", "TECHNICAL_INCIDENT");
    assertIntent("เคสถึงไหนแล้วครับ", "STATUS_QUERY");
    assertIntent("ใช้งานได้แล้วครับ ขอบคุณครับ", "CUSTOMER_CONFIRMATION", {
      hasTicketAwaitingConfirmation: true,
    });
    assertIntent("How do I configure SSO?", "GENERAL_INQUIRY");
    assertIntent("ขอบคุณครับ ไม่มีอะไรพังแล้ว ใช้งานได้ปกติ", "NON_INCIDENT");
  });

  it("only reports CUSTOMER_CONFIRMATION when a ticket is actually awaiting one", () => {
    // Without a resolved ticket the same words are not an answer to anything.
    assertIntent("ใช้งานได้แล้วครับ ขอบคุณครับ", "NON_INCIDENT", {});
  });

  it("treats a rejection during confirmation as confirmation intent, not a new incident", () => {
    // "ยังเข้าไม่ได้" contains a symptom, but while a ticket is RESOLVED it is
    // an answer about that fix. Routing it to the confirmation handler
    // reopens the existing ticket instead of opening a second one.
    const r = classifyMessage("ยังเข้าไม่ได้ครับ", { hasTicketAwaitingConfirmation: true });
    assert.strictEqual(r.intent, "CUSTOMER_CONFIRMATION");
    assert.strictEqual(r.shouldCreateTicket, false);
    assert.strictEqual(r.rule, "confirmation-rejected");
  });

  it("treats the same rejection as an incident when nothing is awaiting confirmation", () => {
    assertTicket("ยังเข้าไม่ได้ครับ", {});
  });
});

describe("AI-01 — regression against the measured false positives", () => {
  // The exact probe set that scored 9/9 false positives before this change.
  const PREVIOUS_FALSE_POSITIVES = [
    "How do I debug my own integration?",
    "There is a bug in my garden, is that covered by your pest module?",
    "Please add a Debugger panel to the roadmap",
    "Can you send the Bugatti invoice?",
    "My colleague Bugsy will contact you",
    "เมื่อวานระบบล่มใช่ไหมครับ ตอนนี้ปกติแล้วใช่ไหม",
    "Do you have a page explaining what a fatal error means?",
    "Our training deck mentions 'crash recovery' — can you review it?",
    "ขอบคุณครับ ไม่มีอะไรพังแล้ว ใช้งานได้ปกติ",
  ];

  const PREVIOUS_TRUE_POSITIVES = [
    "ระบบเข้าใช้งานไม่ได้ครับ ขึ้น 502 Bad Gateway",
    "ระบบล่มตั้งแต่เมื่อเช้าครับ",
    "The app crashed when I opened the report",
    "Getting error 500 on login",
    "I found a bug",
    "ระบบมีปัญหาเรื่องการออกรายงานครับ",
  ];

  it("all nine previous false positives are now correctly refused", () => {
    const stillWrong = PREVIOUS_FALSE_POSITIVES.filter((t) => classifyMessage(t).shouldCreateTicket);
    assert.deepStrictEqual(stillWrong, [], `still false-positive:\n${stillWrong.join("\n")}`);
  });

  it("no true positive was lost in the process", () => {
    const lost = PREVIOUS_TRUE_POSITIVES.filter((t) => !classifyMessage(t).shouldCreateTicket);
    assert.deepStrictEqual(lost, [], `now false-negative:\n${lost.join("\n")}`);
  });

  it("reports the measured rates", () => {
    const fp = PREVIOUS_FALSE_POSITIVES.filter((t) => classifyMessage(t).shouldCreateTicket).length;
    const tp = PREVIOUS_TRUE_POSITIVES.filter((t) => classifyMessage(t).shouldCreateTicket).length;
    console.log(
      `  AI-01 after fix: false positives ${fp}/${PREVIOUS_FALSE_POSITIVES.length} (was 9/9), ` +
        `true positives ${tp}/${PREVIOUS_TRUE_POSITIVES.length}`
    );
    assert.strictEqual(fp, 0);
    assert.strictEqual(tp, PREVIOUS_TRUE_POSITIVES.length);
  });
});

describe("AI-01 — every decision is explainable", () => {
  it("records the rule that decided each classification", () => {
    for (const text of ["ระบบเข้าไม่ได้ครับ", "Can you send the Bugatti invoice?", "เคสถึงไหนแล้ว"]) {
      const r = classifyMessage(text);
      assert.ok(r.rule && r.rule.length > 0, `no rule recorded for "${text}"`);
    }
  });
});
