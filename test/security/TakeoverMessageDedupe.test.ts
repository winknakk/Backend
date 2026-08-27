import assert from "assert";
import { describe, it } from "node:test";
import { LocalDataAdapter } from "../../src/adapters/local-data/LocalDataAdapter";

/**
 * The takeover path used to guard against duplicate messages by loading the
 * whole conversation and comparing content across the entire history. Two
 * problems: the read had no LIMIT and grew with the conversation's age, and
 * comparing against all of history meant a customer who repeated a sentence
 * they had used weeks earlier had that message silently discarded.
 *
 * hasRecentMessage replaces it with a bounded window. These tests pin the
 * window's edges — the behaviour that changed — using LocalDataAdapter's
 * implementation, which is also the shape adapters without a bounded query
 * fall back to.
 */

function adapterWithHistory(history: Array<{ role: string; content: string }>): LocalDataAdapter {
  const adapter = new LocalDataAdapter();
  (adapter as any).getMessages = async () => history;
  return adapter;
}

const CUSTOMER = "customer";

describe("bounded takeover message dedupe", () => {
  it("detects a duplicate that is the most recent message", async () => {
    const adapter = adapterWithHistory([
      { role: CUSTOMER, content: "สวัสดีครับ" },
      { role: CUSTOMER, content: "ขอคุยกับเจ้าหน้าที่ครับ" },
    ]);
    assert.strictEqual(await adapter.hasRecentMessage("1", CUSTOMER, "ขอคุยกับเจ้าหน้าที่ครับ", 5), true);
  });

  it("detects a duplicate at the far edge of the window", async () => {
    const history = [
      { role: CUSTOMER, content: "target" },
      { role: CUSTOMER, content: "a" },
      { role: CUSTOMER, content: "b" },
      { role: CUSTOMER, content: "c" },
      { role: CUSTOMER, content: "d" },
    ];
    assert.strictEqual(await adapterWithHistory(history).hasRecentMessage("1", CUSTOMER, "target", 5), true);
  });

  it("does not look past the window — the behaviour change", async () => {
    const history = [
      { role: CUSTOMER, content: "target" },
      { role: CUSTOMER, content: "a" },
      { role: CUSTOMER, content: "b" },
      { role: CUSTOMER, content: "c" },
      { role: CUSTOMER, content: "d" },
      { role: CUSTOMER, content: "e" },
    ];
    assert.strictEqual(
      await adapterWithHistory(history).hasRecentMessage("1", CUSTOMER, "target", 5),
      false,
      "an identical sentence six messages back is a legitimate repeat, not a duplicate delivery"
    );
  });

  it("does not match the same content from a different role", async () => {
    const history = [{ role: "agent", content: "ระบบล่มครับ" }];
    assert.strictEqual(await adapterWithHistory(history).hasRecentMessage("1", CUSTOMER, "ระบบล่มครับ", 5), false);
  });

  it("returns false on an empty conversation", async () => {
    assert.strictEqual(await adapterWithHistory([]).hasRecentMessage("1", CUSTOMER, "anything", 5), false);
  });

  it("does not treat a prefix as a duplicate", async () => {
    const history = [{ role: CUSTOMER, content: "ระบบเข้าใช้งานไม่ได้ครับ" }];
    assert.strictEqual(await adapterWithHistory(history).hasRecentMessage("1", CUSTOMER, "ระบบเข้าใช้งาน", 5), false);
  });

  it("fails open when the history read throws, so the message is stored rather than lost", async () => {
    const adapter = new LocalDataAdapter();
    (adapter as any).getMessages = async () => {
      throw new Error("backing store unavailable");
    };
    assert.strictEqual(
      await adapter.hasRecentMessage("1", CUSTOMER, "ขอความช่วยเหลือครับ", 5),
      false,
      "a false positive would discard a customer's message; duplicating it is the recoverable failure"
    );
  });
});
