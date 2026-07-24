import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import Redis from "ioredis";
import { DatabaseAdapter } from "../adapters/types";
import { pool } from "../adapters/postgres/PostgresAdapter";
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

        let quoteToken: string | null = null;
        if (replyToMessageId) {
          // Case 1: Explicit reply-to — query that specific message's quote_token
          try {
            const parentRes = await pool.query(`SELECT quote_token FROM messages WHERE id = $1 LIMIT 1`, [replyToMessageId]);
            if (parentRes.rows.length > 0 && parentRes.rows[0].quote_token) {
              quoteToken = parentRes.rows[0].quote_token;
            }
          } catch (e) {}
        }

        // Case 2: Auto-fallback — if no explicit replyToMessageId or its quote_token was null,
        // try the latest customer message with a non-null quote_token from the last 60 seconds
        if (!quoteToken) {
          try {
            const fallbackRes = await pool.query(
              `SELECT quote_token FROM messages
               WHERE conversation_id = $1
                 AND role = 'customer'
                 AND quote_token IS NOT NULL
                 AND created_at > NOW() - INTERVAL '60 seconds'
               ORDER BY created_at DESC
               LIMIT 1`,
              [conversationId]
            );
            if (fallbackRes.rows.length > 0 && fallbackRes.rows[0].quote_token) {
              quoteToken = fallbackRes.rows[0].quote_token;
              console.log(`[HumanReplyService] Auto-resolved quoteToken from latest customer message (fallback)`);
            }
          } catch (e) {
            console.warn(`[HumanReplyService] quoteToken auto-fallback query failed:`, e);
          }
        }

        const msgObj: any = { type: "text", text: message };
        if (quoteToken) {
          msgObj.quoteToken = quoteToken;
        }

        // Handle mock test users in development/testing without breaking API response
        if (!ident.channel_ref || ident.channel_ref === "test_user" || ident.channel_ref.startsWith("test_") || ident.channel_ref.startsWith("mock_")) {
          console.log(`[HumanReplyService] Test user detected (${ident.channel_ref}) - skipping LINE Push, saving to DB.`);
          delivery = { delivered: true, channel, method: "line_push" };
        } else {
          const token = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();

          try {
            await axios.post(
              "https://api.line.me/v2/bot/message/push",
              {
                to: ident.channel_ref,
                messages: [msgObj],
              },
              {
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                timeout: 15000,
              }
            );
          } catch (pushErr: any) {
          // If native quoteToken is expired (>60s), LINE returns HTTP 400. Fall back cleanly to text push!
          if (quoteToken && pushErr.response?.status === 400) {
            console.log(`[HumanReplyService] quoteToken expired/rejected by LINE, falling back to standard text push...`);
            await axios.post(
              "https://api.line.me/v2/bot/message/push",
              {
                to: ident.channel_ref,
                messages: [{ type: "text", text: message }],
              },
              {
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                timeout: 15000,
              }
            );
          } else {
            throw pushErr;
          }
        }

        console.log(`[HumanReplyService] LINE Push accepted.`);
        delivery = { delivered: true, channel, method: "line_push" };
        }
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

    // 3. Persistence is a separate boundary.
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

  async sendImageReply(conversationId: string, imageUrl: string, replyToMessageId?: number, storageKey?: string, uploadedFileName?: string, captionText?: string): Promise<any> {
    await this.dbAdapter.updateHandoffState(conversationId, "human");

    const ident = await this.dbAdapter.getConversationIdent(conversationId);
    if (!ident?.channel || !ident?.channel_ref) {
      const error = new Error("Conversation channel identity was not found");
      Object.assign(error, { statusCode: 404 });
      throw error;
    }

    const channel = String(ident.channel).toLowerCase();
    const backendPublicUrl = process.env.BACKEND_PUBLIC_URL || config.BACKEND_PUBLIC_URL || "https://armed-amperage-covenant.ngrok-free.dev";
    let publicUrl = imageUrl;

    if (publicUrl.startsWith("http://localhost:3000")) {
      publicUrl = publicUrl.replace("http://localhost:3000", backendPublicUrl);
    }

    if (channel === "line" || channel === "line_group") {
      const token = (config.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
      let quoteToken: string | null = null;

      // Case 1: Explicit reply to a specific message ID
      if (replyToMessageId) {
        try {
          const parentRes = await pool.query(`SELECT quote_token FROM messages WHERE id = $1 LIMIT 1`, [replyToMessageId]);
          if (parentRes.rows.length > 0 && parentRes.rows[0].quote_token) {
            quoteToken = parentRes.rows[0].quote_token;
          }
        } catch (e) {}
      }

      // Case 2: Auto-fallback — if no explicit replyToMessageId or its quote_token was null,
      // try the latest customer message with a non-null quote_token from the last 60 seconds
      if (!quoteToken) {
        try {
          const fallbackRes = await pool.query(
            `SELECT quote_token FROM messages
             WHERE conversation_id = $1
               AND role = 'customer'
               AND quote_token IS NOT NULL
               AND created_at > NOW() - INTERVAL '60 seconds'
             ORDER BY created_at DESC
             LIMIT 1`,
            [conversationId]
          );
          if (fallbackRes.rows.length > 0 && fallbackRes.rows[0].quote_token) {
            quoteToken = fallbackRes.rows[0].quote_token;
            console.log(`[HumanReplyService] Auto-resolved quoteToken for image reply from latest customer message`);
          }
        } catch (e) {
          console.warn(`[HumanReplyService] quoteToken auto-fallback query failed:`, e);
        }
      }

      const imgObj: any = {
        type: "image",
        originalContentUrl: publicUrl,
        previewImageUrl: publicUrl,
      };

      // LINE Messaging API requires quoteToken to be attached to a text message object.
      // If quoteToken and captionText are present, send quoted text message + image message together in push!
      const lineMessages: any[] = [];
      if (quoteToken && captionText) {
        lineMessages.push({
          type: "text",
          text: captionText,
          quoteToken: quoteToken,
        });
      } else if (captionText) {
        lineMessages.push({
          type: "text",
          text: captionText,
        });
      }
      lineMessages.push(imgObj);

      try {
        await axios.post(
          "https://api.line.me/v2/bot/message/push",
          {
            to: ident.channel_ref,
            messages: lineMessages,
          },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            timeout: 15000,
          }
        );
      } catch (pushErr: any) {
        // If native quoteToken is expired (>60s), LINE returns HTTP 400. Fall back cleanly to standard image push!
        if (quoteToken && pushErr.response?.status === 400) {
          console.log(`[HumanReplyService] quoteToken expired/rejected by LINE for image, falling back to standard image push...`);
          await axios.post(
            "https://api.line.me/v2/bot/message/push",
            {
              to: ident.channel_ref,
              messages: [imgObj],
            },
            {
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              timeout: 15000,
            }
          );
        } else {
          throw pushErr;
        }
      }
    }

    // Save to DB (persist captionText so it displays in Admin UI)
    const savedMsg = await this.dbAdapter.saveMessage(
      conversationId,
      "human",
      captionText || "",
      undefined,
      "image",
      replyToMessageId
    );

    const messageId = parseInt(savedMsg?.id, 10);
    if (messageId) {
      // Resolve storageKey: prefer explicitly passed key, else parse from URL ?key= param
      let resolvedStorageKey = storageKey || "";
      if (!resolvedStorageKey) {
        try {
          const parsedUrl = new URL(imageUrl);
          const keyParam = parsedUrl.searchParams.get("key");
          if (keyParam) resolvedStorageKey = keyParam;
        } catch {
          // fallback: extract from path (last resort)
          resolvedStorageKey = `admin_media/${path.basename(imageUrl.split("?")[0]) || "operator_image.jpg"}`;
        }
      }

      // Resolve fileName: from explicit param, or derive from storage key
      const fileName = uploadedFileName
        || (resolvedStorageKey ? path.basename(resolvedStorageKey) : "operator_image.jpg");

      await pool.query(
        `INSERT INTO message_attachments 
          (message_id, file_url, thumbnail_url, file_name, file_type, file_size, storage_key, attachment_status, metadata)
         VALUES 
          ($1, $2, $3, $4, 'image/jpeg', 150000, $5, 'READY', $6)
         ON CONFLICT DO NOTHING`,
        [
          messageId,
          imageUrl,
          imageUrl,
          fileName,
          resolvedStorageKey,
          JSON.stringify({ sourceChannel: "admin_ui" })
        ]
      );
    }

    return {
      success: true,
      conversationId,
      delivered: true,
      channel,
      method: "line_push_image",
      handled_by: "human"
    };
  }
}
