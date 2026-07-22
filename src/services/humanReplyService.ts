import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import Redis from "ioredis";
import { DatabaseAdapter } from "../adapters/types";
import { config } from "../config/env";

type DeliveryMethod = "line_push" | "webchat_publish" | "workflow_webhook";

interface DeliveryResult {
  delivered: true;
  channel: string;
  method: DeliveryMethod;
}

export class HumanReplyService {
  private dbAdapter: DatabaseAdapter;

  constructor(dbAdapter: DatabaseAdapter) {
    this.dbAdapter = dbAdapter;
  }

  private getFilePath(tableName: string): string {
    const candidates = [
      path.resolve(__dirname, "../../../data"),
      path.resolve(process.cwd(), "data"),
      path.resolve(process.cwd(), "ticket_codebase/data"),
    ];

    let dataDir = candidates[0];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const files = fs.readdirSync(cand);
        const hasData = files.some(
          (f) => f.endsWith(".json") && (f.includes("Tickets") || f.includes("Messages") || f.includes("Projects"))
        );
        if (hasData) {
          dataDir = cand;
          break;
        }
      }
    }

    const files = fs.readdirSync(dataDir);
    const match =
      files.find((f) => f.includes(`(${tableName})`) && f.endsWith(".json")) ||
      files.find((f) => f.includes(tableName) && f.endsWith(".json"));
    if (!match) {
      const defaultFilename = `Ticket V.2 - ${tableName} (${tableName}).json`;
      return path.join(dataDir, defaultFilename);
    }
    return path.join(dataDir, match);
  }

  private readTable<T>(tableName: string): T[] {
    const filePath = this.getFilePath(tableName);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T[];
  }

  async listConversations(projectId?: string): Promise<any[]> {
    return await this.dbAdapter.listAllConversations(projectId);
  }

  async getMessages(conversationId: string): Promise<any[]> {
    return await this.dbAdapter.getMessages(conversationId);
  }

  async takeover(conversationId: string): Promise<any> {
    await this.dbAdapter.updateHandoffState(conversationId, "human");
    return { success: true, handled_by: "human" };
  }

  async sendReply(conversationId: string, message: string, replyToMessageId?: number): Promise<any> {
    // 1. Mark room status as takeover (handled_by = 'human')
    await this.dbAdapter.updateHandoffState(conversationId, "human");

    const ident = await this.dbAdapter.getConversationIdent(conversationId);
    if (!ident?.channel || !ident?.channel_ref) {
      const error = new Error("Conversation channel identity was not found");
      Object.assign(error, { statusCode: 404 });
      throw error;
    }

    const channel = String(ident.channel).toLowerCase();
    let delivery: DeliveryResult;

    // 2. Deliver LINE replies directly so a successful response means LINE accepted the push.
    // Workflow webhook endpoints acknowledge before their internal steps finish, so their 2xx
    // response cannot be used as proof that a LINE message was delivered.
    if (channel === "line" || channel === "line_group") {
      try {
        console.log(`[HumanReplyService] Sending LINE Push to ${ident.channel_ref}...`);
        await axios.post(
          "https://api.line.me/v2/bot/message/push",
          {
            to: ident.channel_ref,
            messages: [{ type: "text", text: message }],
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
            },
            timeout: 15000,
          }
        );
        console.log(`[HumanReplyService] LINE Push accepted.`);
        delivery = { delivered: true, channel, method: "line_push" };
      } catch (error: any) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[HumanReplyService] LINE Push failed:`, errorMsg);
        const deliveryError = new Error(`LINE rejected the reply: ${errorMsg}`);
        Object.assign(deliveryError, { statusCode: 502 });
        throw deliveryError;
      }
    } else if (channel === "webchat") {
      const redisPub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
      try {
        await redisPub.publish(
          "webchat:outbound",
          JSON.stringify({
            conversationId,
            recipientId: ident.channel_ref,
            channel: "WebChat",
            text: message,
            sentAt: new Date().toISOString(),
          })
        );
        delivery = { delivered: true, channel, method: "webchat_publish" };
      } finally {
        await redisPub.quit();
      }
    } else {
      const webhookUrl =
        config.ACTIVEPIECES_WORKFLOW_PROVIDER === "postgres_v2"
          ? config.ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL_V2
          : config.ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL;

      try {
        await axios.post(
          webhookUrl,
          {
            conversation_id: Number(conversationId) || conversationId,
            message,
          },
          { headers: { "Content-Type": "application/json" }, timeout: 5000 }
        );
        delivery = { delivered: true, channel, method: "workflow_webhook" };
      } catch (error: any) {
        const errorMsg = error.response?.data?.message || error.message;
        const deliveryError = new Error(`Reply workflow rejected the request: ${errorMsg}`);
        Object.assign(deliveryError, { statusCode: 502 });
        throw deliveryError;
      }
    }

    // 3. Persistence is a separate boundary. Once LINE has accepted a push, a later
    // database failure must not report the message as unsent and encourage duplicates.
    let persisted = false;
    try {
      await this.dbAdapter.saveMessage(conversationId, "human", message, undefined, undefined, replyToMessageId);
      persisted = true;
    } catch (error: any) {
      console.error(`[HumanReplyService] Reply delivered but history persistence failed:`, error.message);
    }

    return {
      success: true,
      conversationId,
      ...delivery,
      persisted,
      handled_by: "human",
    };
  }
}
