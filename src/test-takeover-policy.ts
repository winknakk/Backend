import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TakeoverManager } from "./human-takeover/TakeoverManager";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function run() {
  const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ticketx-takeover-policy-"));
  const statePath = path.join(testDirectory, "states.json");
  const manager = new TakeoverManager(statePath, 100);

  try {
    const pending = await manager.setTakeoverState("conversation-1", "PENDING_HUMAN", undefined, 150, false, 1000);
    assert(pending.status === "PENDING_HUMAN", "Pending escalation must retain PENDING_HUMAN status.");
    assert(Boolean(pending.leaseExpiresAt), "Pending escalation must receive a claim deadline.");

    await delay(180);
    const recoveredPending = await manager.getTakeoverState("conversation-1");
    assert(recoveredPending.status === "ACTIVE_AI", "Unclaimed escalation must recover to AI after its deadline.");

    const active = await manager.setTakeoverState("conversation-2", "ACTIVE_HUMAN", "admin-1", 250, false, 450);
    const hardExpiry = new Date(active.maxLeaseExpiresAt!).getTime();
    await delay(170);
    const renewed = await manager.setTakeoverState("conversation-2", "ACTIVE_HUMAN", "admin-1", 350, true, 450);
    assert(
      new Date(renewed.leaseExpiresAt!).getTime() <= hardExpiry,
      "Human replies may renew the idle lease but must not exceed the hard session limit."
    );
    assert(Boolean(renewed.last_human_reply_at), "A human reply must update last_human_reply_at.");

    await delay(Math.max(0, hardExpiry - Date.now()) + 30);
    const recoveredActive = await manager.getTakeoverState("conversation-2");
    assert(recoveredActive.status === "ACTIVE_AI", "The hard session limit must return control to AI.");

    console.log("test-takeover-policy passed");
  } finally {
    await manager.disconnect();
    fs.rmSync(testDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
