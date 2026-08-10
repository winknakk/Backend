import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config/env";
import {
  LineOnboardingDecision,
  LineProjectOnboardingService,
} from "../../services/LineProjectOnboardingService";
import { createLogger } from "../../observability/logger";
import { pool } from "../../adapters/postgres/PostgresAdapter";
import { resolveLineWebhookPayload, verifyLineSignature } from "../../services/lineWebhookSecurity";
import {
  buildLineChoicePrompt,
  buildLineOnboardingCarousel,
  buildLineProjectLinkConfirmation,
  buildLineProjectMenu,
  LINE_ONBOARDING_CARDS,
  lineOnboardingCardDirectory,
} from "../../services/LineOnboardingCarouselService";

const logger = createLogger("line-webhook");

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

function buildLineReply(decision: LineOnboardingDecision): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: "text",
    text: decision.replyText || "รับข้อมูลแล้วนะคะ",
  };
  if (decision.quickReplies?.length) {
    message.quickReply = {
      items: decision.quickReplies.map((item) => ({
        type: "action",
        action: {
          type: "postback",
          label: item.label,
          data: item.data,
          displayText: item.label,
        },
      })),
    };
  }
  return message;
}

async function sendLineReply(replyToken: string, decision: LineOnboardingDecision): Promise<void> {
  if (!replyToken) throw new Error("LINE event cannot be replied to because replyToken is missing");
  const messages = decision.replyWithOnboardingCarousel
    ? [buildLineOnboardingCarousel(config.BACKEND_PUBLIC_URL)]
    : decision.projectLinkConfirmation
      ? [buildLineProjectLinkConfirmation(decision.projectLinkConfirmation)]
    : decision.projectMenu
      ? buildLineProjectMenu(decision.projectMenu)
    : decision.quickReplies?.length
      ? [buildLineChoicePrompt(decision.replyText || "เลือกวิธีดำเนินการได้เลยค่ะ", decision.quickReplies)]
    : [buildLineReply(decision)];
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages },
    {
      headers: {
        Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );
}

async function sendLinePush(userId: string, text: string): Promise<void> {
  await sendLinePushMessages(userId, [{ type: "text", text }]);
}

async function sendLinePushMessages(
  userId: string,
  messages: Array<Record<string, unknown>>,
  notificationDisabled = false
): Promise<void> {
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: userId, messages, notificationDisabled },
    {
      headers: {
        Authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );
}

async function forwardPromptXWebhook(
  url: string,
  destination: string,
  event: any,
  ticketx?: Record<string, unknown>
): Promise<void> {
  await axios.post(
    url,
    {
      destination,
      events: [event],
      ...(ticketx ? { ticketx } : {}),
    },
    { headers: { "Content-Type": "application/json" }, timeout: 15000 }
  );
}

function requireProjectId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Invalid project ID");
  return parsed;
}

async function requireConfiguredAdminApiKey(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!config.API_KEY) {
    await reply.code(503).send({
      error: "Admin onboarding API is disabled until API_KEY is configured",
    });
  }
}

const adminRouteOptions = { preHandler: requireConfiguredAdminApiKey };

export function registerLineWebhookRoutes(
  fastify: FastifyInstance,
  onboardingService: LineProjectOnboardingService
): void {
  fastify.get("/api/v1/media/line-onboarding/cards/:filename", async (request, reply) => {
    const filename = String((request.params as any).filename || "");
    if (!LINE_ONBOARDING_CARDS.some((card) => card.fileName === filename)) {
      return reply.code(404).send({ error: "LINE onboarding card not found" });
    }
    const imagePath = path.join(lineOnboardingCardDirectory(), filename);
    try {
      const image = await fs.promises.readFile(imagePath);
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "public, max-age=86400, immutable")
        .header("X-Content-Type-Options", "nosniff")
        .send(image);
    } catch (error: any) {
      logger.error({ error: error.message, filename }, "LINE onboarding card could not be read");
      return reply.code(503).send({ error: "LINE onboarding card unavailable" });
    }
  });

  fastify.post("/api/v1/webhooks/line", async (request: FastifyRequest, reply) => {
    if (!config.LINE_CHANNEL_SECRET) {
      logger.error("LINE webhook rejected because LINE_CHANNEL_SECRET is not configured");
      return reply.code(503).send({ error: "LINE webhook is not configured" });
    }
    let signedPayload;
    try {
      signedPayload = resolveLineWebhookPayload({
        body: request.body,
        requestRawBody: request.rawBody,
        headerSignature: request.headers["x-line-signature"],
      });
    } catch {
      return reply.code(400).send({ error: "Invalid forwarded LINE raw body" });
    }
    if (!verifyLineSignature(signedPayload.rawBody, signedPayload.signature, config.LINE_CHANNEL_SECRET)) {
      logger.warn({ ip: request.ip }, "Invalid LINE webhook signature");
      return reply.code(403).send({ error: "Invalid LINE webhook signature" });
    }

    const body = signedPayload.body;
    const destination = String(body.destination || "").trim();
    const events = Array.isArray(body.events) ? body.events : [];
    if (!destination || events.length === 0) {
      return reply.code(200).send({ success: true, processed: 0 });
    }

    let processed = 0;
    try {
      for (const event of events) {
        const sourceType = String(event?.source?.type || "");
        if (sourceType === "group" || sourceType === "room") {
          await forwardPromptXWebhook(config.LINE_GROUP_GATEWAY_WEBHOOK_URL, destination, event);
          processed += 1;
          continue;
        }

        const webhookEventId = String(event?.webhookEventId || "").trim();
        const decision = await onboardingService.processEvent({
          type: String(event?.type || "unknown"),
          webhookEventId,
          destination,
          userId: event?.source?.userId ? String(event.source.userId) : undefined,
          messageText: event?.message?.type === "text" ? String(event.message.text || "") : undefined,
          postbackData: event?.postback?.data ? String(event.postback.data) : undefined,
          isUnblocked: event?.follow?.isUnblocked === true,
        });

        if (decision.duplicate || decision.action === "IGNORE") {
          processed += 1;
          continue;
        }
        try {
          if (decision.action === "REPLY") {
            await sendLineReply(String(event.replyToken || ""), decision);
          } else if (decision.action === "PASS_TO_AI") {
            await forwardPromptXWebhook(config.LINE_DM_GATEWAY_WEBHOOK_URL, destination, event, {
              onboardingVerified: true,
              projectId: decision.projectId,
              projectName: decision.projectName,
              conversationId: decision.conversationId,
            });
            if (decision.pushOnboardingCarousel && event?.source?.userId) {
              try {
                await sendLinePushMessages(
                  String(event.source.userId),
                  [buildLineOnboardingCarousel(config.BACKEND_PUBLIC_URL)],
                  true
                );
              } catch (carouselError: any) {
                logger.error(
                  { error: carouselError.message, webhookEventId },
                  "LINE AI forwarding succeeded but the 24-hour carousel recall push failed"
                );
              }
            }
          }
        } catch (deliveryError) {
          await onboardingService.releaseWebhookEventForRetry(webhookEventId);
          throw deliveryError;
        }
        processed += 1;
      }
      return reply.code(200).send({ success: true, processed });
    } catch (error: any) {
      logger.error({ error: error.message }, "LINE webhook processing failed");
      return reply.code(503).send({ error: "LINE webhook processing failed" });
    }
  });

  fastify.get("/api/v1/admin/projects/:projectId/join-code", adminRouteOptions, async (request, reply) => {
    const projectId = requireProjectId((request.params as any).projectId);
    const status = await onboardingService.getJoinCodeStatus(projectId, request.tenantContext.orgId);
    if (!status) return reply.code(404).send({ error: "Project not found" });
    return reply.send({ success: true, data: status });
  });

  fastify.post("/api/v1/admin/projects/:projectId/join-code/rotate", adminRouteOptions, async (request, reply) => {
    const projectId = requireProjectId((request.params as any).projectId);
    const body = (request.body || {}) as any;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return reply.code(400).send({ error: "Invalid expiresAt" });
    }
    const result = await onboardingService.rotateJoinCode({
      projectId,
      orgId: request.tenantContext.orgId,
      createdBy: request.tenantContext.correlationId,
      expiresAt,
    });
    return reply.send({
      success: true,
      data: result,
      warning: "The plaintext code is returned once. Store and distribute it securely.",
    });
  });

  fastify.delete("/api/v1/admin/projects/:projectId/join-code", adminRouteOptions, async (request, reply) => {
    const projectId = requireProjectId((request.params as any).projectId);
    const revoked = await onboardingService.revokeJoinCode(projectId, request.tenantContext.orgId);
    return reply.send({ success: true, revoked });
  });

  fastify.get("/api/v1/admin/line-onboarding/requests", adminRouteOptions, async (request, reply) => {
    const result = await pool.query(
      `SELECT id, line_user_id, destination, requested_details, status,
              resolved_project_id, created_at, updated_at
       FROM line_onboarding_requests
       WHERE org_id = $1
       ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 200`,
      [request.tenantContext.orgId]
    );
    return reply.send({ success: true, data: result.rows });
  });

  fastify.post("/api/v1/admin/line-onboarding/requests/:requestId/resolve", adminRouteOptions, async (request, reply) => {
    const requestId = requireProjectId((request.params as any).requestId);
    const projectId = requireProjectId((request.body as any)?.projectId);
    const result = await onboardingService.resolveManualRequest({
      requestId,
      projectId,
      orgId: request.tenantContext.orgId,
    });
    let notificationDelivered = false;
    try {
      await sendLinePush(
        result.lineUserId,
        `เจ้าหน้าที่เช็กให้แล้วนะคะ บัญชีเชื่อมกับโปรเจกต์ “${result.projectName}” เรียบร้อยแล้ว ✅ พร้อมใช้งานได้เลยค่ะ`
      );
      notificationDelivered = true;
    } catch (error: any) {
      logger.error(
        { error: error.message, requestId, projectId },
        "Manual onboarding was resolved but the LINE confirmation push failed"
      );
    }
    return reply.send({ success: true, data: result, notificationDelivered });
  });

  fastify.post("/api/v1/admin/line-onboarding/requests/:requestId/reject", adminRouteOptions, async (request, reply) => {
    const requestId = requireProjectId((request.params as any).requestId);
    const rejected = await onboardingService.rejectManualRequest(requestId, request.tenantContext.orgId);
    if (!rejected) return reply.code(404).send({ error: "Pending onboarding request not found" });
    return reply.send({ success: true, rejected: true });
  });
}
