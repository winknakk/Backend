import axios from "axios";
import { Pool } from "pg";

export interface SmsRecipient {
  id: number;
  name: string;
  displayName: string;
  phoneNumber: string;
  role: string;
}

export interface TakeoverAlertParams {
  conversationId: string;
  customerName?: string;
  reasonCode?: string;
  reasonDetail?: string;
  lastMessage?: string;
}

export class SmsNotificationService {
  private pool: Pool | null;
  private cooldownMap: Map<string, number> = new Map();
  private cooldownMs: number;

  constructor(pool: Pool | null) {
    this.pool = pool;
    const minutes = parseInt(process.env.SMS_COOLDOWN_MINUTES || "5", 10);
    this.cooldownMs = (isNaN(minutes) || minutes < 0 ? 5 : minutes) * 60 * 1000;
  }

  /**
   * Find SMS recipients for a conversation 100% from PostgreSQL database.
   * Tier 1: Operators assigned to the conversation's project_id with a valid phone_number.
   * Tier 2 (Global Fallback): Active super_admin / admin operators with a valid phone_number in DB.
   */
  public async findAdminsForConversation(conversationId: string): Promise<SmsRecipient[]> {
    if (!this.pool) return [];

    try {
      // 1. Get conversation's project_id
      const convRes = await this.pool.query(
        "SELECT project_id FROM conversations WHERE id = $1::integer",
        [conversationId]
      );
      const projectId = convRes.rows[0]?.project_id;

      let recipients: SmsRecipient[] = [];

      // Tier 1: Search project-specific active operators with phone_number
      if (projectId) {
        const tier1Res = await this.pool.query(
          `SELECT DISTINCT o.id, o.name, o.display_name, o.phone_number, o.role
           FROM operators o
           JOIN operator_project_access opa ON o.id = opa.operator_id
           WHERE opa.project_id = $1::integer
             AND o.status = 'active'
             AND o.phone_number IS NOT NULL
             AND TRIM(o.phone_number) != ''`,
          [projectId]
        );

        recipients = tier1Res.rows.map((row: any) => ({
          id: row.id,
          name: row.name,
          displayName: row.display_name || row.name,
          phoneNumber: row.phone_number,
          role: row.role,
        }));
      }

      // Tier 2: Global DB Fallback if Tier 1 returned no recipients
      if (recipients.length === 0) {
        const tier2Res = await this.pool.query(
          `SELECT DISTINCT o.id, o.name, o.display_name, o.phone_number, o.role
           FROM operators o
           WHERE o.status = 'active'
             AND o.role IN ('super_admin', 'admin')
             AND o.phone_number IS NOT NULL
             AND TRIM(o.phone_number) != ''
           ORDER BY o.id ASC`
        );

        recipients = tier2Res.rows.map((row: any) => ({
          id: row.id,
          name: row.name,
          displayName: row.display_name || row.name,
          phoneNumber: row.phone_number,
          role: row.role,
        }));
      }

      return recipients;
    } catch (err: any) {
      console.error("[SmsNotificationService] DB Lookup Error:", err.message);
      return [];
    }
  }

  /**
   * Check if SMS alert is currently on cooldown for a given conversation.
   */
  public isCoolingDown(conversationId: string): boolean {
    const lastSent = this.cooldownMap.get(conversationId);
    if (!lastSent) return false;
    return Date.now() - lastSent < this.cooldownMs;
  }

  /**
   * Send takeover SMS alert for a conversation.
   */
  public async sendTakeoverAlert(params: TakeoverAlertParams): Promise<boolean> {
    const isEnabled = process.env.SMS_ENABLED === "true";
    const endpoint = process.env.SMS_HTTP_ENDPOINT || "mock";

    if (!isEnabled) {
      return false;
    }

    if (this.isCoolingDown(params.conversationId)) {
      console.log(`[SmsNotificationService] Cooldown active for conversation ${params.conversationId}, skipping SMS.`);
      return false;
    }

    const recipients = await this.findAdminsForConversation(params.conversationId);
    if (recipients.length === 0) {
      console.warn(`[SmsNotificationService] No active Admin phone numbers found in DB for conversation ${params.conversationId}.`);
      return false;
    }

    // Set cooldown mark
    this.cooldownMap.set(params.conversationId, Date.now());

    const isMock = !endpoint || endpoint === "mock" || endpoint.includes("api.smsprovider.com");
    const method = (process.env.SMS_HTTP_METHOD || "POST").toUpperCase();
    let headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.SMS_HTTP_HEADERS) {
      try {
        headers = { ...headers, ...JSON.parse(process.env.SMS_HTTP_HEADERS) };
      } catch (e) {
        console.error("[SmsNotificationService] Invalid SMS_HTTP_HEADERS JSON:", e);
      }
    }

    let bodyTemplateStr = process.env.SMS_HTTP_BODY_TEMPLATE || '{"to":"{{to}}","message":"{{message}}"}';

    let successCount = 0;
    for (const admin of recipients) {
      const messageText = `[TicketX Alert] เรียน ${admin.displayName}: มีคำขอโอนสายจาก ${params.customerName || "Customer #" + params.conversationId} (เหตุผล: ${params.reasonCode || "HUMAN_REQUEST"}) กรุณาตรวจสอบในระบบ`;

      if (isMock) {
        // Print rich simulated SMS console alert for local testing
        console.log("\n=======================================================");
        console.log("📱 [SMS GATEWAY SIMULATOR - ALERT DISPATCHED]");
        console.log(`👤 TO (DB Recipient) : ${admin.displayName} (${admin.phoneNumber})`);
        console.log(`💬 MESSAGE           : ${messageText}`);
        console.log(`📌 CONVERSATION ID   : ${params.conversationId}`);
        console.log("STATUS               : SENT (SIMULATED LOCAL DISPATCH)");
        console.log("=======================================================\n");
        successCount++;
        continue;
      }

      try {
        const renderedBodyStr = bodyTemplateStr
          .replace(/\{\{to\}\}/g, admin.phoneNumber)
          .replace(/\{\{message\}\}/g, messageText)
          .replace(/\{\{conversationId\}\}/g, params.conversationId)
          .replace(/\{\{adminName\}\}/g, admin.displayName);

        if (method === "GET") {
          const urlWithParams = `${endpoint}?to=${encodeURIComponent(admin.phoneNumber)}&message=${encodeURIComponent(messageText)}`;
          await axios.get(urlWithParams, { headers });
        } else {
          let requestBody: any;
          try {
            requestBody = JSON.parse(renderedBodyStr);
          } catch {
            requestBody = renderedBodyStr;
          }
          await axios.post(endpoint, requestBody, { headers });
        }

        console.log(`[SmsNotificationService] Sent real SMS to ${admin.displayName} (${admin.phoneNumber}) for conversation #${params.conversationId}`);
        successCount++;
      } catch (err: any) {
        console.error(`[SmsNotificationService] Failed to send SMS to ${admin.displayName} (${admin.phoneNumber}):`, err.message);
      }
    }

    return successCount > 0;
  }
}
