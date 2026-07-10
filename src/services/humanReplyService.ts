import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { DatabaseAdapter } from "../adapters/types";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";

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
          (f) =>
            f.endsWith(".json") &&
            (f.includes("Tickets") || f.includes("Messages") || f.includes("Projects"))
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

  async sendReply(conversationId: string, message: string): Promise<any> {
    // 1. Mark room status as takeover (handled_by = 'human')
    await this.dbAdapter.updateHandoffState(conversationId, "human");

    let linePushed = false;
    let webhookTriggered = false;

    // 2. Trigger Activepieces Human Reply webhook if configured
    const webhookUrl = config.ACTIVEPIECES_WORKFLOW_PROVIDER === "postgres_v2"
      ? config.ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL_V2
      : config.ACTIVEPIECES_HUMAN_REPLY_WEBHOOK_URL;

    if (webhookUrl) {
      try {
        console.log(`[HumanReplyService] Calling Activepieces Webhook at ${webhookUrl}...`);
        await axios.post(
          webhookUrl,
          {
            conversation_id: Number(conversationId) || conversationId,
            message: message,
          },
          {
            headers: {
              "Content-Type": "application/json",
            },
            timeout: 5000,
          }
        );
        console.log(`[HumanReplyService] Activepieces webhook called successfully.`);
        webhookTriggered = true;
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || err.message;
        console.error(`[HumanReplyService] Failed to trigger Activepieces webhook:`, errorMsg);
      }
    }

    // 3. Fallback to direct LINE Push if webhook was not triggered or configured
    if (!webhookTriggered) {
      // Save human response message to database directly
      await this.dbAdapter.saveMessage(conversationId, "human", message);

      const ident = await this.dbAdapter.getConversationIdent(conversationId);
      if (ident && ident.channel && ident.channel_ref) {
        const channelLower = ident.channel.toLowerCase();
        if (channelLower === "line" || channelLower === "line_group") {
          const lineToken = config.LINE_CHANNEL_ACCESS_TOKEN;
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
                  Authorization: `Bearer ${lineToken}`,
                },
                timeout: 5000,
              }
            );
            console.log(`[HumanReplyService] LINE Push sent successfully.`);
            linePushed = true;
          } catch (e: any) {
            const errorMsg = e.response?.data?.message || e.message;
            console.error(`[HumanReplyService] Failed to send LINE push:`, errorMsg);
          }
        } else if (channelLower === "webchat") {
          const Redis = require("ioredis");
          const redisPub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
          await redisPub.publish(
            "webchat:outbound",
            JSON.stringify({
              conversationId,
              recipientId: ident.channel_ref,
              channel: "WebChat",
              text: message,
              sentAt: new Date().toISOString()
            })
          );
          await redisPub.quit();
        }
      }
    }

    return {
      success: true,
      conversationId,
      linePushed,
      webhookTriggered,
      handled_by: "human",
    };
  }
}

