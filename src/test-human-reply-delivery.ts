import assert from "node:assert/strict";
import axios from "axios";
import { DatabaseAdapter } from "./adapters/types";
import { HumanReplyService } from "./services/humanReplyService";

const originalPost = axios.post;

async function run(): Promise<void> {
  const savedMessages: string[] = [];
  let persistenceShouldFail = false;
  const adapter = {
    updateHandoffState: async () => undefined,
    getConversationIdent: async () => ({ channel: "LINE", channel_ref: "line-user" }),
    saveMessage: async (_conversationId: string, _role: string, content: string) => {
      if (persistenceShouldFail) throw new Error("database unavailable");
      savedMessages.push(content);
      return { id: "1" };
    },
  } as unknown as DatabaseAdapter;

  const service = new HumanReplyService(adapter);

  axios.post = (async (url: string) => {
    assert.equal(url, "https://api.line.me/v2/bot/message/push");
    return { status: 200 };
  }) as typeof axios.post;

  const success = await service.sendReply("67", "delivered message");
  assert.equal(success.success, true);
  assert.equal(success.delivered, true);
  assert.equal(success.method, "line_push");
  assert.equal(success.persisted, true);
  assert.deepEqual(savedMessages, ["delivered message"]);

  persistenceShouldFail = true;
  const deliveredWithoutHistory = await service.sendReply("67", "delivered without history");
  assert.equal(deliveredWithoutHistory.delivered, true);
  assert.equal(deliveredWithoutHistory.persisted, false);
  assert.deepEqual(savedMessages, ["delivered message"]);
  persistenceShouldFail = false;

  axios.post = (async () => {
    const error = new Error("invalid token");
    Object.assign(error, { response: { data: { message: "invalid token" } } });
    throw error;
  }) as typeof axios.post;

  await assert.rejects(
    () => service.sendReply("67", "failed message"),
    (error: Error & { statusCode?: number }) =>
      error.statusCode === 502 && error.message === "LINE rejected the reply: invalid token"
  );
  assert.deepEqual(savedMessages, ["delivered message"]);
}

run()
  .then(() => console.log("Human reply delivery tests passed"))
  .finally(() => {
    axios.post = originalPost;
  });
