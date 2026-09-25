/**
 * AD-14 timeout fallback (2026-09-24, operator: 30 minutes). The "AI ใช้เวลา
 * นานกว่าปกติ" LINE message is sent only after `timeoutFallbackAfterMs` from
 * dispatch and only if the AI still has not replied and no person holds the
 * thread; the conversation's turn is released at its own timeout regardless.
 *
 * Self-contained: queue, gateway, typing indicator, pool and sender are fakes.
 *   npx tsx src/test-ai-timeout-fallback.ts
 */
import axios from "axios";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { customerNotificationService } from "./services/CustomerNotificationService";
import { AgentSessionQueueWorker } from "./services/AgentSessionQueueWorker";

let takeover = { handled_by: "ai", takeover_state: "none" };
(pool as any).query = async (sql: string) => (/FROM conversations/.test(sql) ? { rows: [takeover], rowCount: 1 } : { rows: [], rowCount: 0 });
(pool as any).connect = async () => {
  throw new Error("test-ai-timeout-fallback must not connect to a real database");
};
(axios as any).post = async () => ({ status: 200, data: {} });

const sent: string[] = [];
(customerNotificationService as any).send = async (req: any) => {
  sent.push(req.notificationType);
  return { sent: true };
};

function makeWorker(opts: { replyAppears: boolean; fallbackMs: number }) {
  let released = false;
  const queue: any = {
    claimNext: async () => ({ id: 77, lease_token: "t", attempt_count: 0, payload: { events: [{ source: { type: "user", userId: "U0123456789abcdef0123456789abcdef" } }] } }),
    completeAndClaimNext: async () => {
      released = true;
      return null;
    },
    failAndRelease: async () => {
      released = true;
    },
  };
  let replied = false;
  const typing: any = {
    latestMessageId: async () => 0,
    waitForReply: async () => ({ replied: false, elapsedMs: 10, polls: 1 }),
    hasReplySince: async () => replied,
  };
  if (opts.replyAppears) setTimeout(() => (replied = true), opts.fallbackMs / 2);
  const worker = new AgentSessionQueueWorker(queue, {
    dmGatewayUrl: "http://gateway.invalid/hook",
    leaseDurationMs: 60_000,
    typingIndicator: typing,
    turnCompletionTimeoutMs: 20_000,
    timeoutFallbackAfterMs: opts.fallbackMs,
  });
  return { worker, isReleased: () => released };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? "ผ่าน" : "พลาด"}  ${name}`);
}

async function main() {
  // 1. Silent AI: turn released at once, message only after the delay.
  sent.length = 0;
  let w = makeWorker({ replyAppears: false, fallbackMs: 300 });
  await w.worker.dispatchConversation(1);
  check("T1 the turn is released without waiting for the fallback delay", w.isReleased());
  check("T2 nothing is sent before the delay", sent.length === 0);
  await sleep(450);
  check("T3 the fallback is sent once the delay passes", sent.join() === "ai_timeout_fallback");

  // 2. The AI replies late but inside the delay: no fallback.
  sent.length = 0;
  w = makeWorker({ replyAppears: true, fallbackMs: 300 });
  await w.worker.dispatchConversation(2);
  await sleep(450);
  check("T4 a late AI reply inside the delay cancels the fallback", sent.length === 0);

  // 3. A person took the thread: no fallback.
  sent.length = 0;
  takeover = { handled_by: "human", takeover_state: "active" };
  w = makeWorker({ replyAppears: false, fallbackMs: 300 });
  await w.worker.dispatchConversation(3);
  await sleep(450);
  check("T5 no fallback while a person holds the thread", sent.length === 0);
  takeover = { handled_by: "ai", takeover_state: "none" };

  // 4. stop() clears armed timers.
  sent.length = 0;
  w = makeWorker({ replyAppears: false, fallbackMs: 300 });
  await w.worker.dispatchConversation(4);
  await w.worker.stop();
  await sleep(450);
  check("T6 stop() cancels an armed fallback", sent.length === 0);

  console.log(failures ? `\n${failures} พลาด` : "\nทั้งหมดผ่าน");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
