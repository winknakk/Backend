import crypto from "crypto";
import { Pool, PoolClient } from "pg";

export type LineOnboardingAction = "REPLY" | "PASS_TO_AI" | "IGNORE";

export interface LineQuickReply {
  label: string;
  data: string;
}

export interface LineProjectMenuItem {
  projectId: number;
  projectName: string;
  companyName: string;
  projectType: string;
  environment: string;
  isCurrent: boolean;
}

export interface LineProjectMenu {
  kind: "overview" | "selector";
  projects: LineProjectMenuItem[];
  page: number;
  totalPages: number;
  notice?: string;
}

export interface LineProjectLinkConfirmation {
  currentProjectId: number;
  currentProjectName: string;
  linkedProjectId: number;
  linkedProjectName: string;
  linkedCompanyName: string;
  linkedProjectType: string;
  linkedEnvironment: string;
}

interface AvailableLineProject {
  id: number;
  name: string;
  orgId: string;
  companyName: string;
  projectType: string;
  environment: string;
}

export interface LineOnboardingDecision {
  action: LineOnboardingAction;
  state: string;
  reason: string;
  duplicate?: boolean;
  replyText?: string;
  quickReplies?: LineQuickReply[];
  replyWithOnboardingCarousel?: boolean;
  pushOnboardingCarousel?: boolean;
  projectMenu?: LineProjectMenu;
  projectLinkConfirmation?: LineProjectLinkConfirmation;
  projectId?: number;
  projectName?: string;
  conversationId?: number;
}

export interface LineWebhookEventInput {
  type: string;
  webhookEventId: string;
  destination: string;
  userId?: string;
  messageText?: string;
  postbackData?: string;
  isUnblocked?: boolean;
}

export interface JoinCodeStatus {
  projectId: number;
  projectName: string;
  active: boolean;
  codeHint: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  usageCount: number;
}

const CHOICE_REPLIES: LineQuickReply[] = [
  { label: "มีรหัสโปรเจกต์", data: "ticketx:onboarding:has_code" },
  { label: "ไม่มี/ไม่ทราบรหัส", data: "ticketx:onboarding:no_code" },
];

const RETRY_REPLIES: LineQuickReply[] = [
  { label: "ลองกรอกรหัสอีกครั้ง", data: "ticketx:onboarding:has_code" },
  { label: "ไม่มี/ไม่ทราบรหัส", data: "ticketx:onboarding:no_code" },
];

export const PROJECT_RELINK_COMMAND_TEXTS = [
  "เริ่มใช้งาน",
  "เชื่อมโปรเจกต์",
  "เชื่อมโปรเจกต์ใหม่",
  "เปลี่ยนโปรเจกต์",
  "เมนู",
  "โปรเจกต์ของฉัน",
  "/menu",
  "/project",
] as const;

const PROJECT_RELINK_COMMANDS = new Set<string>(PROJECT_RELINK_COMMAND_TEXTS);

const ACTIVE_ONBOARDING_STATES = new Set([
  "AWAITING_CHOICE",
  "AWAITING_CODE",
  "AWAITING_PROJECT_DETAILS",
  "PENDING_HUMAN",
]);

const PROJECT_MENU_PAGE_SIZE = 10;
const CAROUSEL_RECALL_AFTER_MS = 24 * 60 * 60 * 1000;

export class LineProjectOnboardingService {
  constructor(
    private readonly pool: Pool,
    private readonly codePepper: string,
    private readonly mode: "code_required" | "smart" = "code_required"
  ) {
    if (!codePepper || codePepper.length < 16) {
      throw new Error("LINE project-code pepper must contain at least 16 characters");
    }
  }

  static normalizeCode(value: string): string {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  static generateCode(): string {
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const bytes = crypto.randomBytes(8);
    const token = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
    return `TX-${token.slice(0, 4)}-${token.slice(4)}`;
  }

  private digestCode(code: string): string {
    return crypto
      .createHmac("sha256", this.codePepper)
      .update(LineProjectOnboardingService.normalizeCode(code))
      .digest("hex");
  }

  async getJoinCodeStatus(projectId: number, orgId: string): Promise<JoinCodeStatus | null> {
    const result = await this.pool.query(
      `SELECT p.id AS project_id, p.name AS project_name,
              c.id IS NOT NULL AS active, c.code_hint, c.created_at, c.expires_at,
              COALESCE(c.usage_count, 0) AS usage_count
       FROM projects p
       LEFT JOIN project_join_codes c
         ON c.project_id = p.id
        AND c.org_id = p.org_id
        AND c.status = 'active'
        AND (c.expires_at IS NULL OR c.expires_at > NOW())
       WHERE p.id = $1 AND p.org_id = $2
       LIMIT 1`,
      [projectId, orgId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      projectId: Number(row.project_id),
      projectName: row.project_name,
      active: Boolean(row.active),
      codeHint: row.code_hint || null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      usageCount: Number(row.usage_count || 0),
    };
  }

  async rotateJoinCode(input: {
    projectId: number;
    orgId: string;
    createdBy?: string;
    expiresAt?: Date | null;
  }): Promise<JoinCodeStatus & { code: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [input.projectId]);
      const projectResult = await client.query(
        `SELECT id, name FROM projects WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [input.projectId, input.orgId]
      );
      if (projectResult.rows.length === 0) {
        throw new Error("Project not found in the requested organization");
      }

      const code = LineProjectOnboardingService.generateCode();
      const digest = this.digestCode(code);
      const hint = LineProjectOnboardingService.normalizeCode(code).slice(-4);
      await client.query(
        `UPDATE project_join_codes
         SET status = 'revoked', revoked_at = NOW()
         WHERE org_id = $1 AND project_id = $2 AND status = 'active'`,
        [input.orgId, input.projectId]
      );
      const insertResult = await client.query(
        `INSERT INTO project_join_codes
          (org_id, project_id, code_digest, code_hint, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING created_at, expires_at`,
        [input.orgId, input.projectId, digest, hint, input.expiresAt || null, input.createdBy || null]
      );
      await client.query("COMMIT");
      return {
        projectId: input.projectId,
        projectName: projectResult.rows[0].name,
        active: true,
        code,
        codeHint: hint,
        createdAt: new Date(insertResult.rows[0].created_at).toISOString(),
        expiresAt: insertResult.rows[0].expires_at
          ? new Date(insertResult.rows[0].expires_at).toISOString()
          : null,
        usageCount: 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async restoreJoinCode(input: {
    projectId: number;
    orgId: string;
    code: string;
    createdBy?: string;
  }): Promise<JoinCodeStatus> {
    const normalizedCode = LineProjectOnboardingService.normalizeCode(input.code);
    if (!/^TX[A-Z0-9]{8}$/.test(normalizedCode)) {
      throw new Error("LINE project code must use the TX-XXXX-XXXX format");
    }

    const digest = this.digestCode(normalizedCode);
    const hint = normalizedCode.slice(-4);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [input.projectId]);
      const projectResult = await client.query(
        `SELECT id, name
         FROM projects
         WHERE id = $1 AND org_id = $2
         FOR UPDATE`,
        [input.projectId, input.orgId]
      );
      if (projectResult.rows.length === 0) {
        throw new Error("Project not found in the requested organization");
      }

      const existingResult = await client.query(
        `SELECT id, project_id, org_id, usage_count, last_used_at, created_at
         FROM project_join_codes
         WHERE code_digest = $1
         FOR UPDATE`,
        [digest]
      );
      const existing = existingResult.rows[0];
      if (
        existing &&
        (Number(existing.project_id) !== input.projectId || existing.org_id !== input.orgId)
      ) {
        throw new Error("The requested code belongs to another Project");
      }

      await client.query(
        `UPDATE project_join_codes
         SET status = 'revoked', revoked_at = NOW()
         WHERE org_id = $1
           AND project_id = $2
           AND status = 'active'
           AND code_digest <> $3`,
        [input.orgId, input.projectId, digest]
      );

      let restoredRow;
      if (existing) {
        const restored = await client.query(
          `UPDATE project_join_codes
           SET status = 'active', code_hint = $1, expires_at = NULL, revoked_at = NULL
           WHERE id = $2
           RETURNING created_at, expires_at, usage_count`,
          [hint, existing.id]
        );
        restoredRow = restored.rows[0];
      } else {
        const inserted = await client.query(
          `INSERT INTO project_join_codes
            (org_id, project_id, code_digest, code_hint, status, expires_at, created_by)
           VALUES ($1, $2, $3, $4, 'active', NULL, $5)
           RETURNING created_at, expires_at, usage_count`,
          [input.orgId, input.projectId, digest, hint, input.createdBy || null]
        );
        restoredRow = inserted.rows[0];
      }

      await client.query("COMMIT");
      return {
        projectId: input.projectId,
        projectName: projectResult.rows[0].name,
        active: true,
        codeHint: hint,
        createdAt: new Date(restoredRow.created_at).toISOString(),
        expiresAt: restoredRow.expires_at
          ? new Date(restoredRow.expires_at).toISOString()
          : null,
        usageCount: Number(restoredRow.usage_count || 0),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeJoinCode(projectId: number, orgId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE project_join_codes
       SET status = 'revoked', revoked_at = NOW()
       WHERE project_id = $1 AND org_id = $2 AND status = 'active'`,
      [projectId, orgId]
    );
    return (result.rowCount || 0) > 0;
  }

  async resolveManualRequest(input: {
    requestId: number;
    projectId: number;
    orgId: string;
  }): Promise<{ lineUserId: string; projectId: number; projectName: string; conversationId: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const requestResult = await client.query(
        `SELECT id, line_user_id, destination
         FROM line_onboarding_requests
         WHERE id = $1 AND org_id = $2 AND status = 'pending'
         FOR UPDATE`,
        [input.requestId, input.orgId]
      );
      if (requestResult.rows.length === 0) throw new Error("Pending onboarding request not found");
      const projectResult = await client.query(
        `SELECT p.id, p.name
         FROM projects p
         JOIN project_channels pc ON pc.project_id = p.id
         WHERE p.id = $1 AND p.org_id = $2 AND pc.channel_id = $3
           AND COALESCE(pc.is_enabled, TRUE) AND COALESCE(pc.active, TRUE)
         LIMIT 1`,
        [input.projectId, input.orgId, requestResult.rows[0].destination]
      );
      if (projectResult.rows.length === 0) throw new Error("Project not found in the requested organization");
      const onboardingRequest = requestResult.rows[0];
      const provisioned = await this.provisionProject(
        client,
        input.orgId,
        onboardingRequest.line_user_id,
        input.projectId
      );
      await client.query(
        `UPDATE line_onboarding_requests
         SET status = 'resolved', resolved_project_id = $3, resolved_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND org_id = $2`,
        [input.requestId, input.orgId, input.projectId]
      );
      await client.query(
        `UPDATE line_onboarding_sessions
         SET state = 'COMPLETED', selected_project_id = $4, attempts = 0,
             locked_until = NULL, expires_at = NOW() + INTERVAL '3650 days', updated_at = NOW()
         WHERE org_id = $1 AND line_user_id = $2 AND destination = $3`,
        [input.orgId, onboardingRequest.line_user_id, onboardingRequest.destination, input.projectId]
      );
      await client.query("COMMIT");
      return {
        lineUserId: onboardingRequest.line_user_id,
        projectId: input.projectId,
        projectName: projectResult.rows[0].name,
        conversationId: provisioned.conversationId,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectManualRequest(requestId: number, orgId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE line_onboarding_requests
       SET status = 'rejected', resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
      [requestId, orgId]
    );
    return (result.rowCount || 0) > 0;
  }

  async processEvent(input: LineWebhookEventInput): Promise<LineOnboardingDecision> {
    if (!input.webhookEventId) {
      throw new Error("Missing LINE webhookEventId");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claim = await client.query(
        `INSERT INTO line_webhook_events
          (webhook_event_id, line_user_id, event_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (webhook_event_id) DO NOTHING
         RETURNING webhook_event_id`,
        [input.webhookEventId, input.userId || null, input.type]
      );
      if (claim.rows.length === 0) {
        const prior = await client.query(
          `SELECT response FROM line_webhook_events WHERE webhook_event_id = $1`,
          [input.webhookEventId]
        );
        await client.query("COMMIT");
        return {
          action: "IGNORE",
          state: "DUPLICATE",
          reason: prior.rows[0]?.response?.reason || "duplicate_webhook_event",
          duplicate: true,
        };
      }

      const decision = await this.processClaimedEvent(client, input);
      await client.query(
        `UPDATE line_webhook_events
         SET status = 'processed', response = $2::jsonb, processed_at = NOW()
         WHERE webhook_event_id = $1`,
        [input.webhookEventId, JSON.stringify(decision)]
      );
      await client.query("COMMIT");
      return decision;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseWebhookEventForRetry(webhookEventId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM line_webhook_events WHERE webhook_event_id = $1`,
      [webhookEventId]
    );
  }

  private async processClaimedEvent(
    client: PoolClient,
    input: LineWebhookEventInput
  ): Promise<LineOnboardingDecision> {
    if (!input.userId || !input.destination) {
      return { action: "IGNORE", state: "UNSUPPORTED", reason: "missing_user_or_destination" };
    }

    const ready = await this.findReadyConversation(client, input.userId, input.destination);
    const orgId = ready?.org_id || await this.resolveOrganization(client, input.destination);
    let session = await this.getSession(client, orgId, input.userId, input.destination);
    const normalizedMessage = String(input.messageText || "").trim().toLowerCase();
    const relinkRequested = input.type === "message" && PROJECT_RELINK_COMMANDS.has(normalizedMessage);

    if (relinkRequested) {
      await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
      return this.carouselDecision(ready ? "existing_user_requested_project_relink" : "unlinked_user_requested_project_relink");
    }

    if (ready) {
      if (input.type === "follow") {
        return {
          action: "REPLY",
          state: "COMPLETED",
          reason: input.isUnblocked ? "known_user_unblocked" : "known_user_followed",
          projectId: Number(ready.project_id),
          projectName: ready.project_name,
          conversationId: Number(ready.conversation_id),
          replyText: `กลับมาแล้วนะคะ 😊 ตอนนี้บัญชีเชื่อมกับโปรเจกต์ “${ready.project_name}” อยู่ แจ้งเรื่องที่อยากให้ช่วยมาได้เลยค่ะ`,
        };
      }
      if (input.type === "message" && !ACTIVE_ONBOARDING_STATES.has(String(session?.state || ""))) {
        const shouldRecallCarousel = await this.recordDmActivityAndCheckCarouselRecall(
          client,
          orgId,
          input,
          Number(ready.project_id),
          Number(ready.conversation_id)
        );
        return {
          action: "PASS_TO_AI",
          state: "COMPLETED",
          reason: "verified_existing_conversation",
          ...(shouldRecallCarousel ? { pushOnboardingCarousel: true } : {}),
          projectId: Number(ready.project_id),
          projectName: ready.project_name,
          conversationId: Number(ready.conversation_id),
        };
      }
    }

    if (input.type === "follow") {
      if (this.mode === "smart") {
        const project = await this.findOnlyDestinationProject(client, orgId, input.destination);
        if (project) {
          const provisioned = await this.provisionProject(client, orgId, input.userId, project.id);
          await this.completeSession(client, orgId, input, project.id);
          return {
            action: "REPLY",
            state: "COMPLETED",
            reason: "single_destination_project",
            projectId: project.id,
            projectName: project.name,
            conversationId: provisioned.conversationId,
            replyText: `เชื่อมกับโปรเจกต์ “${project.name}” ให้แล้วนะคะ ✅ พร้อมใช้งานได้เลยค่ะ`,
          };
        }
      }
      await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
      return this.carouselDecision("new_follow");
    }

    if (input.type === "postback") {
      const postbackData = String(input.postbackData || "");
      const switchMatch = /^ticketx:onboarding:switch_project:(\d+)$/.exec(postbackData);
      if (switchMatch) {
        const requestedProjectId = Number(switchMatch[1]);
        const projects = await this.findAvailableProjects(client, orgId, input.userId);
        const target = projects.find((project) => project.id === requestedProjectId);
        const currentProjectId = this.resolveCurrentProjectId(projects, session, ready);
        if (!target) {
          if (projects.length === 0) {
            await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
            return this.choiceDecision("project_switch_denied");
          }
          return this.projectMenuDecision(
            "project_switch_unavailable",
            "selector",
            projects,
            currentProjectId,
            0,
            "โปรเจกต์ที่เลือกไม่พร้อมใช้งานแล้วค่ะ เลือกจากรายการล่าสุดได้เลยนะคะ"
          );
        }
        const provisioned = await this.provisionProject(client, target.orgId, input.userId, target.id);
        await this.completeSession(client, target.orgId, input, target.id);
        return {
          action: "REPLY",
          state: "COMPLETED",
          reason: currentProjectId === target.id ? "project_switch_current" : "project_switch_completed",
          projectId: target.id,
          projectName: target.name,
          conversationId: provisioned.conversationId,
          replyText: currentProjectId === target.id
            ? `ตอนนี้กำลังใช้งานโปรเจกต์ “${target.name}” อยู่แล้วค่ะ ส่งเรื่องที่ต้องการให้ช่วยมาได้เลยนะคะ`
            : `เปลี่ยนมาใช้โปรเจกต์ “${target.name}” แล้วนะคะ ✅ ส่งเรื่องที่ต้องการให้ช่วยมาได้เลยค่ะ`,
        };
      }

      const pageMatch = /^ticketx:onboarding:projects_page:(\d+)$/.exec(postbackData);
      if (pageMatch) {
        const projects = await this.findAvailableProjects(client, orgId, input.userId);
        const currentProjectId = this.resolveCurrentProjectId(projects, session, ready);
        if (projects.length === 0) {
          await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
          return this.choiceDecision("change_without_membership");
        }
        return this.projectMenuDecision(
          "change_project_page",
          "selector",
          projects,
          currentProjectId,
          Number(pageMatch[1])
        );
      }

      const menuMatch = /^ticketx:onboarding:menu:(start|report|status|connect|connect_new|change)$/.exec(postbackData);
      if (menuMatch) {
        const projects = await this.findAvailableProjects(client, orgId, input.userId);
        const currentProjectId = this.resolveCurrentProjectId(projects, session, ready);
        const intent = menuMatch[1];

        if (intent === "report") {
          if (projects.length === 0) {
            await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
            return this.choiceDecision("report_without_project");
          }
          const target = projects.find((project) => project.id === currentProjectId) || projects[0];
          return {
            action: "REPLY",
            state: "COMPLETED",
            reason: "report_issue_prompt",
            projectId: target.id,
            projectName: target.name,
            replyText: `แจ้งปัญหาหรืออาการที่พบของโปรเจกต์ “${target.name}” เข้ามาได้เลยนะคะ ระบบจะตรวจสอบและเปิด Ticket ให้ทันทีค่ะ 😊`,
          };
        }

        if (intent === "status") {
          if (projects.length === 0) {
            await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
            return this.choiceDecision("status_without_project");
          }
          const target = projects.find((project) => project.id === currentProjectId) || projects[0];
          return {
            action: "REPLY",
            state: "COMPLETED",
            reason: "check_status_prompt",
            projectId: target.id,
            projectName: target.name,
            replyText: `ส่งเลขที่ Ticket ที่ต้องการติดตาม หรือพิมพ์ “ตรวจสอบสถานะ” เพื่อให้ระบบสรุปรายการล่าสุดของโปรเจกต์ “${target.name}” ได้เลยนะคะ 🔍`,
          };
        }

        if (intent === "start") {
          if (projects.length === 0) {
            await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
            return this.choiceDecision("start_without_project");
          }
          if (currentProjectId || projects.length === 1) {
            const target = projects.find((project) => project.id === currentProjectId) || projects[0];
            const provisioned = await this.provisionProject(client, target.orgId, input.userId, target.id);
            await this.completeSession(client, target.orgId, input, target.id);
            return {
              action: "REPLY",
              state: "COMPLETED",
              reason: "start_with_active_project",
              projectId: target.id,
              projectName: target.name,
              conversationId: provisioned.conversationId,
              replyText: `ตอนนี้บัญชีเชื่อมกับโปรเจกต์ “${target.name}” อยู่ค่ะ ส่งเรื่องที่ต้องการให้ช่วยมาได้เลยนะคะ`,
            };
          }
          return this.projectMenuDecision(
            "start_requires_project_selection",
            "selector",
            projects,
            null
          );
        }

        if (intent === "connect_new") {
          await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
          return this.choiceDecision(
            "connect_new_requested",
            projects.length
              ? "มาเชื่อมโปรเจกต์ใหม่กันค่ะ เลือกได้เลยว่ามีรหัสโปรเจกต์หรืออยากให้เจ้าหน้าที่ช่วยตรวจสอบนะคะ"
              : undefined
          );
        }

        if (intent === "connect") {
          if (projects.length === 0) {
            await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
            return this.choiceDecision("connect_without_project");
          }
          return this.projectMenuDecision(
            "connect_existing_project",
            "overview",
            projects,
            currentProjectId,
            0,
            currentProjectId
              ? `ตอนนี้กำลังใช้งานโปรเจกต์ “${projects.find((project) => project.id === currentProjectId)?.name || projects[0].name}” อยู่ค่ะ`
              : "บัญชีนี้เชื่อมกับโปรเจกต์อยู่แล้วค่ะ"
          );
        }

        if (projects.length === 0) {
          await this.upsertSession(client, orgId, input, "AWAITING_CHOICE");
          return this.choiceDecision("change_without_membership");
        }
        return this.projectMenuDecision(
          projects.length === 1 ? "change_single_membership" : "change_multiple_memberships",
          "selector",
          projects,
          currentProjectId,
          0,
          projects.length === 1
            ? `ตอนนี้คุณเชื่อมอยู่กับโปรเจกต์ “${projects[0].name}” ค่ะ ยังไม่มีโปรเจกต์อื่นให้เปลี่ยนนะคะ`
            : undefined
        );
      }
      if (input.postbackData === "ticketx:onboarding:has_code") {
        await this.upsertSession(client, orgId, input, "AWAITING_CODE");
        return {
          action: "REPLY",
          state: "AWAITING_CODE",
          reason: "customer_has_code",
          replyText: "ส่งรหัสโปรเจกต์มาได้เลยค่ะ",
        };
      }
      if (input.postbackData === "ticketx:onboarding:no_code") {
        const pendingRequest = await client.query(
          `SELECT id
           FROM line_onboarding_requests
           WHERE org_id = $1 AND line_user_id = $2 AND destination = $3 AND status = 'pending'
           ORDER BY created_at DESC
           LIMIT 1`,
          [orgId, input.userId, input.destination]
        );
        if (pendingRequest.rows.length > 0) {
          await this.upsertSession(client, orgId, input, "PENDING_HUMAN");
          return {
            action: "REPLY",
            state: "PENDING_HUMAN",
            reason: "manual_verification_already_pending",
            replyText: "เจ้าหน้าที่กำลังตรวจสอบโปรเจกต์ให้อยู่นะคะ หากมีข้อมูลเพิ่มเติม รอให้เจ้าหน้าที่ติดต่อกลับแล้วส่งเพิ่มได้เลยค่ะ",
          };
        }
        await this.upsertSession(client, orgId, input, "AWAITING_PROJECT_DETAILS");
        return {
          action: "REPLY",
          state: "AWAITING_PROJECT_DETAILS",
          reason: "customer_has_no_code",
          replyText: "ได้เลยค่ะ ส่งชื่อบริษัทกับชื่อโปรเจกต์มาได้เลย เดี๋ยวให้เจ้าหน้าที่ช่วยเช็กให้นะคะ",
        };
      }
      return { action: "IGNORE", state: session?.state || "UNKNOWN", reason: "unsupported_postback" };
    }

    if (input.type !== "message") {
      return { action: "IGNORE", state: session?.state || "UNKNOWN", reason: `unsupported_${input.type}` };
    }

    if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
      await this.upsertSession(client, orgId, input, "AWAITING_CHOICE", {
        pendingMessage: String(input.messageText || "").slice(0, 1000),
      });
      return this.carouselDecision("first_message_requires_onboarding");
    }

    if (session.state === "AWAITING_CHOICE") {
      const possibleCode = LineProjectOnboardingService.normalizeCode(input.messageText || "");
      if (possibleCode.startsWith("TX") && possibleCode.length >= 8) {
        await this.upsertSession(client, orgId, input, "AWAITING_CODE");
        session = { ...session, state: "AWAITING_CODE" };
      } else {
        return this.carouselDecision("choice_required");
      }
    }

    if (session.state === "AWAITING_CODE") {
      return this.validateAndProvisionCode(client, orgId, input);
    }

    if (session.state === "AWAITING_PROJECT_DETAILS") {
      const details = String(input.messageText || "").trim().slice(0, 2000);
      if (details.length < 3) {
        return {
          action: "REPLY",
          state: session.state,
          reason: "project_details_too_short",
          replyText: "ขอชื่อบริษัทกับชื่อโปรเจกต์เพิ่มอีกนิดนะคะ",
        };
      }
      await client.query(
        `INSERT INTO line_onboarding_requests
          (org_id, line_user_id, destination, requested_details)
         VALUES ($1, $2, $3, $4)`,
        [orgId, input.userId, input.destination, details]
      );
      await client.query(
        `UPDATE line_onboarding_sessions
         SET state = 'PENDING_HUMAN', updated_at = NOW(), expires_at = NOW() + INTERVAL '7 days'
         WHERE org_id = $1 AND line_user_id = $2 AND destination = $3`,
        [orgId, input.userId, input.destination]
      );
      return {
        action: "REPLY",
        state: "PENDING_HUMAN",
        reason: "manual_project_verification_requested",
        replyText: "รับข้อมูลแล้วนะคะ เดี๋ยวเจ้าหน้าที่เช็กให้ แล้วจะแจ้งกลับทาง LINE นี้ค่ะ",
      };
    }

    if (session.state === "PENDING_HUMAN") {
      return {
        action: "REPLY",
        state: session.state,
        reason: "manual_verification_pending",
        replyText: "เรื่องกำลังรอเจ้าหน้าที่เช็กอยู่นะคะ ถ้ามีข้อมูลเพิ่ม รอให้เจ้าหน้าที่ติดต่อกลับแล้วส่งเพิ่มได้เลยค่ะ",
      };
    }

    return this.carouselDecision("onboarding_state_not_ready");
  }

  private carouselDecision(reason: string): LineOnboardingDecision {
    return {
      action: "REPLY",
      state: "AWAITING_CHOICE",
      reason,
      replyWithOnboardingCarousel: true,
    };
  }

  private choiceDecision(reason: string, replyText?: string): LineOnboardingDecision {
    return {
      action: "REPLY",
      state: "AWAITING_CHOICE",
      reason,
      replyText: replyText || "สวัสดีค่ะ 👋 ยินดีต้อนรับสู่ TicketX Support ก่อนเริ่มใช้งาน ขอเชื่อมบัญชี LINE กับโปรเจกต์ของคุณก่อนนะคะ",
      quickReplies: CHOICE_REPLIES,
    };
  }

  private projectMenuDecision(
    reason: string,
    kind: "overview" | "selector",
    projects: AvailableLineProject[],
    currentProjectId: number | null,
    requestedPage = 0,
    notice?: string
  ): LineOnboardingDecision {
    const totalPages = Math.max(1, Math.ceil(projects.length / PROJECT_MENU_PAGE_SIZE));
    const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
    const pageProjects = projects.slice(page * PROJECT_MENU_PAGE_SIZE, (page + 1) * PROJECT_MENU_PAGE_SIZE);
    return {
      action: "REPLY",
      state: "AWAITING_CHOICE",
      reason,
      projectMenu: {
        kind,
        projects: pageProjects.map((project) => ({
          projectId: project.id,
          projectName: project.name,
          companyName: project.companyName,
          projectType: project.projectType,
          environment: project.environment,
          isCurrent: project.id === currentProjectId,
        })),
        page,
        totalPages,
        notice,
      },
    };
  }

  private resolveCurrentProjectId(
    projects: AvailableLineProject[],
    session: any,
    ready: any
  ): number | null {
    const selected = Number(session?.selected_project_id || 0);
    if (selected && projects.some((project) => project.id === selected)) return selected;
    const readyProject = Number(ready?.project_id || 0);
    if (readyProject && projects.some((project) => project.id === readyProject)) return readyProject;
    return projects.length === 1 ? projects[0].id : null;
  }

  private async validateAndProvisionCode(
    client: PoolClient,
    orgId: string,
    input: LineWebhookEventInput
  ): Promise<LineOnboardingDecision> {
    const normalized = LineProjectOnboardingService.normalizeCode(input.messageText || "");
    const digest = this.digestCode(normalized);
    const codeResult = await client.query(
      `SELECT c.id AS code_id, c.project_id, c.org_id, p.name AS project_name,
              COALESCE(co.name, '-') AS company_name,
              COALESCE(p.project_type, '-') AS project_type,
              COALESCE(p.environment, '-') AS environment
       FROM project_join_codes c
       JOIN projects p ON p.id = c.project_id AND p.org_id = c.org_id
       LEFT JOIN companies co ON co.id = p.company_id
       WHERE c.code_digest = $1
         AND c.status = 'active'
         AND (c.expires_at IS NULL OR c.expires_at > NOW())
         AND EXISTS (
           SELECT 1
           FROM project_channels pc
           WHERE pc.project_id = p.id
             AND LOWER(pc.channel_type) = 'line'
             AND COALESCE(pc.is_enabled, TRUE)
             AND COALESCE(pc.active, TRUE)
         )
       LIMIT 1`,
      [digest]
    );

    if (codeResult.rows.length === 0) {
      await client.query(
        `UPDATE line_onboarding_sessions
         SET attempts = 0,
             locked_until = NULL,
             updated_at = NOW()
         WHERE org_id = $1 AND line_user_id = $2 AND destination = $3`,
        [orgId, input.userId, input.destination]
      );
      return {
        action: "REPLY",
        state: "AWAITING_CODE",
        reason: "invalid_code",
        replyText: "รหัสนี้ยังใช้ไม่ได้ค่ะ ลองเช็กแล้วส่งใหม่อีกครั้งนะคะ",
        quickReplies: RETRY_REPLIES,
      };
    }

    const code = codeResult.rows[0];
    const targetOrgId = code.org_id || orgId;
    const projectsBeforeLink = await this.findAvailableProjects(client, targetOrgId, input.userId!);
    const currentSession = await this.getSession(client, targetOrgId, input.userId!, input.destination);
    const currentReady = await this.findReadyConversation(client, input.userId!, input.destination);
    const currentProjectId = this.resolveCurrentProjectId(projectsBeforeLink, currentSession, currentReady);
    const currentProject = projectsBeforeLink.find((project) => project.id === currentProjectId);
    const provisioned = await this.provisionProject(client, targetOrgId, input.userId!, Number(code.project_id));
    await client.query(
      `UPDATE project_join_codes
       SET usage_count = usage_count + 1, last_used_at = NOW()
       WHERE id = $1`,
      [code.code_id]
    );
    if (currentProject && currentProject.id !== Number(code.project_id)) {
      await this.completeSession(client, currentProject.orgId, input, currentProject.id);
      return {
        action: "REPLY",
        state: "COMPLETED",
        reason: "project_linked_switch_confirmation",
        projectId: currentProject.id,
        projectName: currentProject.name,
        projectLinkConfirmation: {
          currentProjectId: currentProject.id,
          currentProjectName: currentProject.name,
          linkedProjectId: Number(code.project_id),
          linkedProjectName: code.project_name,
          linkedCompanyName: code.company_name,
          linkedProjectType: code.project_type,
          linkedEnvironment: code.environment,
        },
      };
    }
    await this.completeSession(client, targetOrgId, input, Number(code.project_id));
    return {
      action: "REPLY",
      state: "COMPLETED",
      reason: "valid_project_code",
      projectId: Number(code.project_id),
      projectName: code.project_name,
      conversationId: provisioned.conversationId,
      replyText: `เชื่อมกับโปรเจกต์ “${code.project_name}” ให้แล้วนะคะ ✅ พร้อมใช้งานได้เลยค่ะ`,
    };
  }

  private async resolveOrganization(client: PoolClient, destination: string): Promise<string> {
    const result = await client.query(
      `SELECT DISTINCT p.org_id
       FROM project_channels pc
       JOIN projects p ON p.id = pc.project_id
       WHERE pc.channel_id = $1
         AND COALESCE(pc.is_enabled, TRUE)
         AND COALESCE(pc.active, TRUE)
       LIMIT 2`,
      [destination]
    );
    return result.rows.length === 1 ? String(result.rows[0].org_id || "org_default") : "org_default";
  }

  private async findOnlyDestinationProject(
    client: PoolClient,
    orgId: string,
    destination: string
  ): Promise<{ id: number; name: string } | null> {
    const result = await client.query(
      `SELECT DISTINCT p.id, p.name
       FROM project_channels pc
       JOIN projects p ON p.id = pc.project_id
       WHERE pc.channel_id = $1
         AND p.org_id = $2
         AND COALESCE(pc.is_enabled, TRUE)
         AND COALESCE(pc.active, TRUE)
       ORDER BY p.id
       LIMIT 2`,
      [destination, orgId]
    );
    return result.rows.length === 1
      ? { id: Number(result.rows[0].id), name: result.rows[0].name }
      : null;
  }

  private async findReadyConversation(client: PoolClient, userId: string, destination: string): Promise<any | null> {
    const result = await client.query(
      `SELECT c.id AS conversation_id, c.project_id, p.name AS project_name, p.org_id
       FROM identities i
       JOIN conversations c ON c.identity_id = i.id
       JOIN projects p ON p.id = c.project_id
       LEFT JOIN line_onboarding_sessions s
         ON s.org_id = p.org_id
        AND s.line_user_id = $1
        AND s.destination = $2
       LEFT JOIN project_channels pc
         ON pc.project_id = p.id
        AND pc.channel_id = $2
        AND LOWER(pc.channel_type) = 'line'
        AND COALESCE(pc.is_enabled, TRUE)
        AND COALESCE(pc.active, TRUE)
       WHERE LOWER(i.channel) = 'line'
         AND i.channel_ref = $1
         AND (
           s.selected_project_id = c.project_id
           OR (s.selected_project_id IS NULL AND pc.project_id IS NOT NULL)
         )
         AND c.status = 'open'
         AND c.deleted_at IS NULL
       ORDER BY
         CASE WHEN s.selected_project_id = c.project_id THEN 0 ELSE 1 END,
         c.updated_at DESC NULLS LAST,
         c.created_at DESC,
         c.id DESC
       LIMIT 1`,
      [userId, destination]
    );
    return result.rows[0] || null;
  }

  private async findAvailableProjects(
    client: PoolClient,
    orgId: string,
    userId: string
  ): Promise<AvailableLineProject[]> {
    const result = await client.query(
      `SELECT DISTINCT p.id, p.name, p.org_id,
              COALESCE(co.name, '-') AS company_name,
              COALESCE(p.project_type, '-') AS project_type,
              COALESCE(p.environment, '-') AS environment,
              CASE WHEN p.org_id = $2 THEN 0 ELSE 1 END AS org_priority
       FROM identities i
       JOIN profiles pr ON pr.id = i.profile_id
       JOIN profile_projects pp ON pp.profile_id = pr.id
       JOIN projects p ON p.id = pp.project_id
       LEFT JOIN companies co ON co.id = p.company_id
       WHERE LOWER(i.channel) = 'line'
         AND i.channel_ref = $1
         AND i.deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM project_channels pc
           WHERE pc.project_id = p.id
             AND LOWER(pc.channel_type) = 'line'
             AND COALESCE(pc.is_enabled, TRUE)
             AND COALESCE(pc.active, TRUE)
         )
       ORDER BY org_priority, p.name, p.id`,
      [userId, orgId]
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      orgId: String(row.org_id || "org_default"),
      companyName: String(row.company_name || "-"),
      projectType: String(row.project_type || "-"),
      environment: String(row.environment || "-"),
    }));
  }

  private async getSession(client: PoolClient, orgId: string, userId: string, destination: string): Promise<any> {
    const result = await client.query(
      `SELECT * FROM line_onboarding_sessions
       WHERE org_id = $1 AND line_user_id = $2 AND destination = $3
       FOR UPDATE`,
      [orgId, userId, destination]
    );
    return result.rows[0] || null;
  }

  private async recordDmActivityAndCheckCarouselRecall(
    client: PoolClient,
    orgId: string,
    input: LineWebhookEventInput,
    projectId: number,
    conversationId: number
  ): Promise<boolean> {
    const now = new Date();
    await client.query(
      `INSERT INTO line_onboarding_sessions
        (org_id, line_user_id, destination, state, selected_project_id, expires_at, metadata)
       VALUES ($1, $2, $3, 'COMPLETED', $4, NOW() + INTERVAL '3650 days', '{}'::jsonb)
       ON CONFLICT (org_id, line_user_id, destination) DO NOTHING`,
      [orgId, input.userId, input.destination, projectId]
    );
    const lockedSession = await client.query(
      `SELECT metadata
       FROM line_onboarding_sessions
       WHERE org_id = $1 AND line_user_id = $2 AND destination = $3
       FOR UPDATE`,
      [orgId, input.userId, input.destination]
    );
    const metadata = lockedSession.rows[0]?.metadata || {};
    let previousActivityAt = Date.parse(String(metadata.lastDmActivityAt || ""));
    if (!Number.isFinite(previousActivityAt)) {
      const history = await client.query(
        `SELECT MAX(created_at) AS last_activity_at
         FROM messages
         WHERE conversation_id = $1 AND role = 'customer'`,
        [conversationId]
      );
      previousActivityAt = history.rows[0]?.last_activity_at
        ? new Date(history.rows[0].last_activity_at).getTime()
        : Number.NaN;
    }
    await client.query(
      `UPDATE line_onboarding_sessions
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{lastDmActivityAt}',
         to_jsonb($4::text),
         TRUE
       )
       WHERE org_id = $1 AND line_user_id = $2 AND destination = $3`,
      [orgId, input.userId, input.destination, now.toISOString()]
    );
    return Number.isFinite(previousActivityAt)
      && now.getTime() - previousActivityAt >= CAROUSEL_RECALL_AFTER_MS;
  }

  private async upsertSession(
    client: PoolClient,
    orgId: string,
    input: LineWebhookEventInput,
    state: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const sessionMetadata = {
      ...metadata,
      lastDmActivityAt: new Date().toISOString(),
    };
    await client.query(
      `INSERT INTO line_onboarding_sessions
        (org_id, line_user_id, destination, state, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (org_id, line_user_id, destination) DO UPDATE SET
         state = EXCLUDED.state,
         attempts = 0,
         locked_until = NULL,
         metadata = line_onboarding_sessions.metadata || EXCLUDED.metadata,
         expires_at = NOW() + INTERVAL '24 hours',
         updated_at = NOW()`,
      [orgId, input.userId, input.destination, state, JSON.stringify(sessionMetadata)]
    );
  }

  private async completeSession(
    client: PoolClient,
    orgId: string,
    input: LineWebhookEventInput,
    projectId: number
  ): Promise<void> {
    const lastDmActivityAt = new Date().toISOString();
    await client.query(
      `UPDATE line_onboarding_sessions
       SET state = 'AWAITING_CHOICE', selected_project_id = NULL, updated_at = NOW()
       WHERE line_user_id = $1
         AND destination = $2
         AND org_id <> $3
         AND state = 'COMPLETED'`,
      [input.userId, input.destination, orgId]
    );
    await client.query(
      `INSERT INTO line_onboarding_sessions
        (org_id, line_user_id, destination, state, selected_project_id, expires_at, metadata)
       VALUES (
         $1, $2, $3, 'COMPLETED', $4, NOW() + INTERVAL '3650 days',
         jsonb_build_object('lastDmActivityAt', $5::text)
       )
       ON CONFLICT (org_id, line_user_id, destination) DO UPDATE SET
         state = 'COMPLETED', selected_project_id = EXCLUDED.selected_project_id,
         attempts = 0, locked_until = NULL,
         expires_at = EXCLUDED.expires_at,
         metadata = jsonb_set(
           COALESCE(line_onboarding_sessions.metadata, '{}'::jsonb),
           '{lastDmActivityAt}',
           to_jsonb($5::text),
           TRUE
         ),
         updated_at = NOW()`,
      [orgId, input.userId, input.destination, projectId, lastDmActivityAt]
    );
  }

  private async provisionProject(
    client: PoolClient,
    orgId: string,
    userId: string,
    projectId: number
  ): Promise<{ conversationId: number }> {
    const result = await client.query(
      `WITH target_project AS (
         SELECT id, company_id, org_id FROM projects
         WHERE id = $1
       ),
       existing_identity AS (
         SELECT i.id, i.profile_id
         FROM identities i
         WHERE LOWER(i.channel) = 'line' AND i.channel_ref = $3 AND i.deleted_at IS NULL
         LIMIT 1
       ),
       new_profile AS (
         INSERT INTO profiles (id, company_id, name, metadata, is_pii_erased, is_merged, created_at, updated_at)
         SELECT 'line_' || SUBSTR(MD5($3), 1, 24), tp.company_id, '-',
                jsonb_build_object('source', 'line_project_onboarding'), FALSE, FALSE, NOW(), NOW()
         FROM target_project tp
         WHERE NOT EXISTS (SELECT 1 FROM existing_identity)
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       ),
       existing_profile AS (
         SELECT id FROM profiles WHERE id = 'line_' || SUBSTR(MD5($3), 1, 24)
       ),
       target_profile AS (
         SELECT profile_id AS id FROM existing_identity
         UNION ALL SELECT id FROM new_profile
         UNION ALL SELECT id FROM existing_profile
         LIMIT 1
       ),
       new_identity AS (
         INSERT INTO identities
           (profile_id, channel, channel_ref, is_shared, is_pii, account_type, is_shared_account, org_id, created_at, updated_at)
         SELECT tp.id, 'line', $3, FALSE, TRUE, 'individual', FALSE, $2, NOW(), NOW()
         FROM target_profile tp
         WHERE NOT EXISTS (SELECT 1 FROM existing_identity)
         ON CONFLICT (channel, channel_ref) DO NOTHING
         RETURNING id, profile_id
       ),
       current_identity AS (
         SELECT id, profile_id FROM existing_identity
         UNION ALL SELECT id, profile_id FROM new_identity
         LIMIT 1
       ),
       enrollment AS (
         INSERT INTO profile_projects (profile_id, project_id, created_at)
         SELECT ci.profile_id, $1, NOW() FROM current_identity ci
         ON CONFLICT (profile_id, project_id) DO NOTHING
         RETURNING profile_id
       ),
       existing_conversation AS (
         SELECT c.id
         FROM conversations c
         JOIN current_identity ci ON c.identity_id = ci.id
         WHERE c.project_id = $1 AND c.status = 'open' AND c.deleted_at IS NULL
         ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC, c.id DESC
         LIMIT 1
       ),
       touched_conversation AS (
         UPDATE conversations c
         SET updated_at = NOW()
         FROM existing_conversation ec
         WHERE c.id = ec.id
         RETURNING c.id
       ),
       new_conversation AS (
         INSERT INTO conversations
           (identity_id, project_id, channel, status, handled_by, org_id, created_at)
         SELECT ci.id, $1, 'line', 'open', 'ai', $2, NOW()
         FROM current_identity ci
         WHERE NOT EXISTS (SELECT 1 FROM touched_conversation)
         RETURNING id
       )
       SELECT id FROM touched_conversation
       UNION ALL SELECT id FROM new_conversation
       LIMIT 1`,
      [projectId, orgId, userId]
    );
    if (result.rows.length === 0) {
      throw new Error("Project onboarding could not create a tenant-compatible LINE identity");
    }
    return { conversationId: Number(result.rows[0].id) };
  }
}
