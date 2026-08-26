import { InboundMessage, OutboundMessage } from "../schemas/validation";
import { IMemoryService } from "../memory/types";
import { AgentManager } from "../agent/AgentRuntime";
import { createLogger } from "../observability/logger";
import { startTimer } from "../observability/timing";
import { randomUUID } from "crypto";
import { TakeoverManager } from "../human-takeover/TakeoverManager";
import { ConversationResolver } from "../conversation/ConversationResolver";
import { IssueSessionBuilder } from "../runtime/IssueSessionBuilder";
import { IssueSessionResolver } from "../runtime/IssueSessionResolver";
import { LifecycleState } from "../runtime/IssueSession";
import { RuntimeContextResolver } from "../services/RuntimeContextResolver";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { projectResolver } from "../domain/project/ProjectResolver";

const logger = createLogger("Orchestrator");

export class Orchestrator {
  public memoryService: IMemoryService;
  public agentManager: AgentManager;
  public takeoverManager: TakeoverManager;
  public conversationResolver: ConversationResolver;

  constructor(
    memoryService: IMemoryService,
    agentManager: AgentManager,
    takeoverManager = new TakeoverManager(),
    conversationResolver = new ConversationResolver()
  ) {
    this.memoryService = memoryService;
    this.agentManager = agentManager;
    this.takeoverManager = takeoverManager;
    this.conversationResolver = conversationResolver;
  }

  /**
   * Accepts raw inbound message, loads memory, runs the Agent, and yields outbound message.
   */
  async handleIncomingMessage(message: InboundMessage, requestId?: string): Promise<OutboundMessage> {
    const reqId = requestId || randomUUID();
    const timer = startTimer();

    logger.info(
      { requestId: reqId, senderId: message.senderId, channel: message.channel, component: "Orchestrator" },
      `Intake Webhook: From ${message.senderId} | Channel ${message.channel}`
    );

    try {
      // Ensure local conversation and identity exist first for the customer
      await this.memoryService.ensureConversation(message.senderId, "1", message.channel);

      // 1. Hydrate memory and load session context
      const sessionContext = await this.memoryService.loadSessionContext(message.senderId, message.channel);
      const conversationId = sessionContext.conversationId;

      // Multi-Channel First-Contact Identity Verification Check (LINE, WebChat, Widget, Email, WhatsApp)
      const dbAdapter = (this.memoryService as any).dbAdapter;
      if (dbAdapter) {
        try {
          const identRes = await pool.query(
            `SELECT id, verification_status, is_verified, profile_id FROM identities WHERE channel_ref = $1 LIMIT 1`,
            [message.senderId]
          );

          if (identRes.rows.length > 0) {
            const ident = identRes.rows[0];
            const isGuest = ident.verification_status === "UNVERIFIED_GUEST" || !ident.is_verified;

            if (isGuest) {
              const inputText = (message.text || "").trim();
              const metaProjectCode = (
                (message as any).metadata?.projectCode ||
                (message as any).metadata?.slug ||
                ""
              ).trim();
              const candidateCode = metaProjectCode || inputText;

              // Delegates to the single project-resolution authority.
              //
              // This used to run its own query matching the raw input against
              // projects.name / projects.slug / projects.code with no
              // organization filter. It referenced `code` and `is_active`,
              // neither of which exists in the schema, so it threw on every
              // call — and had it worked it would have let a customer join
              // another tenant's project by typing its name.
              //
              // Join codes are salted digests in project_join_codes with
              // expiry, revocation and a per-channel enablement check. The
              // resolver fails closed: no match means no project, never a
              // default.
              const resolution = await projectResolver.resolveByJoinCode(candidateCode, {
                channel: String(message.channel || "line").toLowerCase(),
              });

              if (resolution.ok && resolution.project) {
                const matchedProject = { id: resolution.project.projectId, name: resolution.project.projectName };
                await pool.query(
                  `UPDATE identities SET verification_status = 'VERIFIED_CUSTOMER', is_verified = TRUE WHERE id = $1`,
                  [ident.id]
                );
                await pool.query(
                  `UPDATE conversations SET project_id = $1 WHERE id = $2`,
                  [matchedProject.id, conversationId]
                );

                await this.memoryService.appendConversationLog(
                  conversationId,
                  "customer",
                  message.text,
                  message.externalId
                );

                const welcomeText = `✅ ยืนยันตัวตนสำเร็จแล้วค่ะ! ยินดีต้อนรับสู่ระบบบริการซัพพอร์ตโครงการ "${matchedProject.name}" มีข้อสงสัยหรือต้องการความช่วยเหลือเรื่องอะไร พิมพ์สอบถามมาได้เลยค่ะ`;

                await this.memoryService.appendConversationLog(conversationId, "ai", welcomeText);

                return {
                  recipientId: message.senderId,
                  channel: message.channel,
                  text: welcomeText,
                  sentAt: new Date().toISOString(),
                };
              } else {
                // Intercept guest message and send challenge prompt tailored for the channel
                await this.memoryService.appendConversationLog(
                  conversationId,
                  "customer",
                  message.text,
                  message.externalId
                );

                const isEmailChannel = String(message.channel).toLowerCase() === "email";
                const challengeText = isEmailChannel
                  ? `[TicketX System Notification]\n\nสวัสดีค่ะ ยินดีต้อนรับสู่ระบบบริการซัพพอร์ต\n\nกรุณาตอบกลับอีเมลฉบับนี้โดยระบุ **รหัสโครงการ (Project Code)** หรือ **ชื่อโปรเจกต์** ของท่าน เพื่อยืนยันตัวตนก่อนเริ่มต้นเปิดตั๋วงานค่ะ`
                  : `👋 สวัสดีค่ะ ยินดีต้อนรับสู่ระบบบริการซัพพอร์ตอัตโนมัติ\n\nกรุณาพิมพ์ **รหัสโครงการ (Project Code)** หรือ **ชื่อโปรเจกต์** ของท่าน เพื่อยืนยันตัวตนก่อนเริ่มต้นใช้งานบริการค่ะ`;

                await this.memoryService.appendConversationLog(conversationId, "ai", challengeText);

                return {
                  recipientId: message.senderId,
                  channel: message.channel,
                  text: challengeText,
                  sentAt: new Date().toISOString(),
                };
              }
            }
          }
        } catch (identErr: any) {
          logger.warn({ error: identErr.message }, "Identity verification check error, proceeding with standard orchestration");
        }
      }

      logger.info(
        {
          requestId: reqId,
          conversationId,
          companyId: sessionContext.companyId,
          component: "Orchestrator",
        },
        `Hydrated session context for company ID: ${sessionContext.companyId}`
      );

      // Resolve database adapter and project context to build IssueSession
      const contextResolver = new RuntimeContextResolver(dbAdapter);
      const runtimeContext = await contextResolver.resolveRuntimeContext(conversationId);
      if (!runtimeContext) {
        throw new Error(`Failed to resolve RuntimeContext for conversation ${conversationId}`);
      }

      const activeTicket = await dbAdapter.getLatestTicketForConversation(conversationId);

      const conversationState = {
        id: runtimeContext.conversationId,
        status: sessionContext.status as any,
        handledBy: sessionContext.handledBy,
        channel: runtimeContext.channel
      };

      const ticketState = {
        id: activeTicket?.id,
        ticketCode: activeTicket?.ticket_id,
        status: activeTicket?.status,
        priority: activeTicket?.priority,
        slaBreached: activeTicket?.sla_breached || false
      };

      const session = new IssueSessionBuilder()
        .withSessionId(reqId)
        .withContext(runtimeContext)
        .withConversation(conversationState)
        .withTicket(ticketState)
        .build();

      session.transitionTo(LifecycleState.HYDRATING);
      session.transitionTo(LifecycleState.READY);

      return await IssueSessionResolver.run(session, async () => {
        session.transitionTo(LifecycleState.PROCESSING);

        // Check Human Takeover State
        const takeoverState = await this.takeoverManager.getTakeoverState(conversationId);
        const isHumanHandoffActive = takeoverState.status === "PENDING_HUMAN" || takeoverState.status === "ACTIVE_HUMAN" || sessionContext.handledBy === "human";

        // Verify active participant status & group mentions (only if human handoff is NOT active)
        if (!isHumanHandoffActive) {
          const resolution = await this.conversationResolver.shouldProcess(message, conversationId);
          if (!resolution.shouldProcess) {
            const durationMs = timer();
            logger.info(
              { requestId: reqId, conversationId, reason: resolution.reason, component: "Orchestrator" },
              "Group conversation message ignored (not mentioned and no active participant session)"
            );
            session.transitionTo(LifecycleState.RESPONDING);
            session.transitionTo(LifecycleState.COMPLETED);
            return {
              recipientId: message.senderId,
              channel: message.channel,
              text: `Muted: ${resolution.reason}`,
              sentAt: new Date().toISOString(),
            };
          }
        }
        
        // If human session expired, switch handled_by back to AI in DB
        if (takeoverState.status === "ACTIVE_AI" && sessionContext.handledBy === "human") {
          logger.info(
            {
              requestId: reqId,
              conversationId: sessionContext.conversationId,
              component: "Orchestrator",
            },
            "Human session expired. Switching database handoff state back to 'ai'."
          );
          await this.memoryService.updateHandoffState(sessionContext.conversationId, "ai");
          sessionContext.handledBy = "ai";
          session.conversation = { ...session.conversation, handledBy: "ai" };
        }

        if (takeoverState.status === "PENDING_HUMAN" || takeoverState.status === "ACTIVE_HUMAN") {
          logger.info(
            {
              requestId: reqId,
              conversationId: sessionContext.conversationId,
              status: takeoverState.status,
              component: "Orchestrator",
            },
            "Human takeover active: bypassing AgentRuntime reasoning loop."
          );

          let replyToId: number | undefined = undefined;
          if (message.quotedMessageId || message.replyToMessageId) {
            const rawRef = message.quotedMessageId || message.replyToMessageId;
            try {
              const res = await (this.memoryService as any).dbAdapter.pool?.query(
                `SELECT id FROM messages WHERE external_id = $1 LIMIT 1`,
                [String(rawRef)]
              );
              if (res && res.rows.length > 0) {
                replyToId = res.rows[0].id;
              }
            } catch (e) {}
          }

          await this.memoryService.appendConversationLog(
            sessionContext.conversationId,
            "customer",
            message.text,
            message.externalId,
            "text",
            replyToId,
            message.quoteToken
          );

          const durationMs = timer();
          session.transitionTo(LifecycleState.RESPONDING);
          session.transitionTo(LifecycleState.COMPLETED);
          return {
            recipientId: message.senderId,
            channel: message.channel,
            text: "",
            suppressReply: true,
            sentAt: new Date().toISOString(),
          };
        }

        // 2. Resolve Agent session
        const agentSession = await this.agentManager.getOrCreateSession(message.senderId, sessionContext.companyId, message.channel);

        // 3. Trigger Agent reasoning and tool loop
        const reply = await agentSession.chat(message, reqId);

        session.transitionTo(LifecycleState.RESPONDING);
        const durationMs = timer();
        logger.info(
          {
            requestId: reqId,
            conversationId: sessionContext.conversationId,
            durationMs,
            component: "Orchestrator",
          },
          `Webhook process completed in ${durationMs.toFixed(2)}ms`
        );

        session.transitionTo(LifecycleState.COMPLETED);
        return reply;
      });
    } catch (err: any) {
      const durationMs = timer();
      logger.error(
        {
          requestId: reqId,
          durationMs,
          component: "Orchestrator",
          error: err.message,
        },
        "Failed to handle incoming message"
      );
      throw err;
    }
  }
}
