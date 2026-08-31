import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import { JwtUtil } from "../../../shared/jwt";
import { pool } from "../../../adapters/postgres/PostgresAdapter";
import { nextSequenceId } from "../../../adapters/postgres/sequences";
import { PostgresConversationRepository } from "../../../infrastructure/db/PostgresConversationRepository";
import { PostgresMessageRepository } from "../../../infrastructure/db/PostgresMessageRepository";
import { PostgresIdentityRepository } from "../../../infrastructure/db/PostgresIdentityRepository";
import { PostgresProfileRepository } from "../../../infrastructure/db/PostgresProfileRepository";
import { PostgresWebChatSessionRepository } from "../../../infrastructure/db/PostgresWebChatSessionRepository";
import { Conversation } from "../../../domain/entities/Conversation";
import { Message } from "../../../domain/entities/Message";
import { Profile } from "../../../domain/entities/Profile";
import { Identity } from "../../../domain/entities/Identity";
import { WebChatSession } from "../../../domain/entities/WebChatSession";
import { QueueFactory } from "../../../queue/QueueFactory";
import { config } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import Redis from "ioredis";
import { createRedisClient } from "../../../infrastructure/cache/createRedisClient";
import { getWebchatJwtSecret } from "../../../middleware/customerAuth";

const logger = createLogger("WebChatGateway");

// In-memory registry of active WebSocket sockets grouped by conversationId room
const activeConnections = new Map<string, Set<any>>();

interface EphemeralWsTicket {
  identityId: string;
  profileId: string;
  companyId: string;
  projectId: string;
  channelRef: string;
  role: string;
  expiresAt: number;
}

const wsTickets = new Map<string, EphemeralWsTicket>();

// Periodic cleanup of expired tickets
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of wsTickets.entries()) {
    if (val.expiresAt <= now) {
      wsTickets.delete(key);
    }
  }
}, 30_000);
if (typeof (cleanupInterval as any).unref === "function") {
  (cleanupInterval as any).unref();
}

// Redis Pub/Sub subscriber client for horizontal scaling
let redisSub: Redis | null = null;

const HandshakeSchema = z.object({
  customerToken: z.string().optional(),
  guestUuid: z.string().optional(),
  companyId: z.string().optional(),
  projectId: z.string().optional()
});

export default async function WebChatGateway(fastify: FastifyInstance) {
  const conversationRepo = new PostgresConversationRepository();
  const messageRepo = new PostgresMessageRepository();
  const identityRepo = new PostgresIdentityRepository();
  const profileRepo = new PostgresProfileRepository();
  const sessionRepo = new PostgresWebChatSessionRepository();

  // Setup Redis Subscriber once
  if (!redisSub) {
    redisSub = createRedisClient("webchat-gateway-sub", { maxRetriesPerRequest: null });
    redisSub.subscribe("webchat:outbound").catch(err => {
      logger.error({ error: err.message }, "Failed to subscribe to Redis outbound channel");
    });
    redisSub.on("message", (channel, message) => {
      if (channel === "webchat:outbound") {
        try {
          const payload = JSON.parse(message);
          const msgPayload = {
            event: "message",
            data: {
              id: payload.id || randomUUID(),
              role: payload.role || "ai",
              content: payload.text,
              createdAt: payload.sentAt || new Date().toISOString(),
              attachments: payload.attachments || []
            }
          };

          if (payload.conversationId) {
            broadcastToRoom(`conversation:${payload.conversationId}`, msgPayload);
          }
          if (payload.recipientId) {
            broadcastToRoom(`recipient:${payload.recipientId}`, msgPayload);
          }
        } catch (err: any) {
          logger.error({ error: err.message }, "Failed to process Redis pub/sub message");
        }
      }
    });
  }

  /**
   * Endpoint 1: Handshake
   * Yields a short-lived signed JWT for guests or logged-in users.
   * Client-supplied projectId and companyId are treated as UNTRUSTED hints.
   * Authoritative identity, project, and org are resolved server-side.
   */
  fastify.post("/api/v1/webchat/handshake", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const jwtSecret = getWebchatJwtSecret();

      const parsed = HandshakeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Bad Request",
          message: parsed.error.issues.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")
        });
      }

      const { customerToken, guestUuid, companyId: clientCompanyHint, projectId: clientProjectHint } = parsed.data;

      let isGuest = true;
      let channelRef = "";
      let customerName = "";

      // 1. Identity Proofing Strategy
      if (customerToken) {
        const decoded = JwtUtil.verify(customerToken, jwtSecret);
        if (decoded && decoded.customerId) {
          isGuest = false;
          channelRef = decoded.customerId;
          customerName = decoded.name || `User_${channelRef.slice(0, 6)}`;
        } else {
          return reply.code(401).send({ error: "Unauthorized", message: "Invalid identity proofing token" });
        }
      }

      // 2. Profile & Authoritative Identity Resolution Strategy
      let identity: Identity | null = null;
      let resolvedGuestUuid = guestUuid || randomUUID();
      let authoritativeCompanyId = 1;
      let authoritativeProjectId = 1;

      if (isGuest) {
        channelRef = resolvedGuestUuid;
        identity = await identityRepo.findByChannelAndRef("WebChat", channelRef);

        // Validate guest project hint against active database projects
        const parsedProjHint = clientProjectHint ? parseInt(String(clientProjectHint), 10) : NaN;
        if (!isNaN(parsedProjHint) && parsedProjHint > 0) {
          const projCheck = await pool.query(
            "SELECT id, company_id FROM projects WHERE id = $1 LIMIT 1",
            [parsedProjHint]
          );
          if (projCheck.rows.length > 0) {
            authoritativeProjectId = Number(projCheck.rows[0].id);
            authoritativeCompanyId = Number(projCheck.rows[0].company_id || 1);
          }
        }

        if (!identity) {
          // Dynamic Guest compilation
          const nextProfileIdRes = await pool.query("SELECT COALESCE(MAX(CASE WHEN id::text ~ '^[0-9]+$' THEN id::bigint ELSE 0 END), 0) + 1 AS next_id FROM profiles");
          const nextProfileId = String(nextProfileIdRes.rows[0].next_id);

          const guestProfile = new Profile({
            id: nextProfileId,
            companyId: String(authoritativeCompanyId),
            name: `Guest_${channelRef.slice(0, 8)}`
          });
          await profileRepo.save(guestProfile);

          const nextIdentId = await nextSequenceId(pool, "identities");

          identity = new Identity({
            id: nextIdentId,
            profileId: nextProfileId,
            channel: "WebChat",
            channelRef
          });
          await identityRepo.save(identity);
        }
      } else {
        // Logged-in Customer Resolution
        identity = await identityRepo.findByChannelAndRef("WebChat", channelRef);

        if (!identity) {
          const safeCompanyId = (clientCompanyHint && !isNaN(parseInt(clientCompanyHint, 10))) ? parseInt(clientCompanyHint, 10) : 1;
          const profileCheck = await pool.query(
            "SELECT id, company_id FROM profiles WHERE name = $1 AND company_id = $2 LIMIT 1",
            [customerName, safeCompanyId]
          );

          let profileId = "";
          if (profileCheck.rows.length > 0) {
            profileId = String(profileCheck.rows[0].id);
            authoritativeCompanyId = Number(profileCheck.rows[0].company_id || safeCompanyId);
          } else {
            const nextProfileIdRes = await pool.query("SELECT COALESCE(MAX(CASE WHEN id::text ~ '^[0-9]+$' THEN id::bigint ELSE 0 END), 0) + 1 AS next_id FROM profiles");
            profileId = String(nextProfileIdRes.rows[0].next_id);
            authoritativeCompanyId = safeCompanyId;
            const customerProfile = new Profile({
              id: profileId,
              companyId: String(safeCompanyId),
              name: customerName
            });
            await profileRepo.save(customerProfile);
          }

          const nextIdentId = await nextSequenceId(pool, "identities");

          identity = new Identity({
            id: nextIdentId,
            profileId,
            channel: "WebChat",
            channelRef
          });
          await identityRepo.save(identity);
        } else {
          // Read authoritative companyId from profile
          const profRes = await pool.query("SELECT company_id FROM profiles WHERE id = $1 LIMIT 1", [parseInt(identity.profileId, 10) || 0]);
          if (profRes.rows.length > 0 && profRes.rows[0].company_id) {
            authoritativeCompanyId = Number(profRes.rows[0].company_id);
          }
        }

        // Authoritatively resolve customer's project access from profile_projects and conversations
        const parsedProjHint = clientProjectHint ? parseInt(String(clientProjectHint), 10) : NaN;
        const authorizedProjectsRes = await pool.query(
          `SELECT project_id FROM profile_projects WHERE profile_id = $1
           UNION
           SELECT DISTINCT project_id FROM conversations WHERE identity_id = $2 AND project_id IS NOT NULL`,
          [parseInt(identity.profileId, 10) || 0, parseInt(identity.id, 10) || 0]
        );
        const authorizedProjectIds = authorizedProjectsRes.rows
          .map((r: any) => Number(r.project_id))
          .filter((n: number) => Number.isInteger(n) && n > 0);

        if (!isNaN(parsedProjHint) && authorizedProjectIds.includes(parsedProjHint)) {
          authoritativeProjectId = parsedProjHint;
        } else if (authorizedProjectIds.length > 0) {
          authoritativeProjectId = authorizedProjectIds[0];
        } else {
          const defaultProjRes = await pool.query(
            "SELECT id FROM projects WHERE company_id = $1 ORDER BY id ASC LIMIT 1",
            [authoritativeCompanyId]
          );
          authoritativeProjectId = defaultProjRes.rows.length > 0 ? Number(defaultProjRes.rows[0].id) : 1;
        }
      }

      // 3. Session Compilation & Token Generation
      const sessionToken = JwtUtil.sign(
        { identityId: identity.id, channelRef, role: isGuest ? "guest" : "customer", jti: randomUUID() },
        jwtSecret,
        86400
      );

      const nextSessionId = await nextSequenceId(pool, "webchat_sessions");

      const webchatSession = new WebChatSession({
        id: nextSessionId,
        identityId: identity.id,
        sessionToken
      });
      await sessionRepo.save(webchatSession);

      // Generate short-lived signed JWT for subsequent client requests
      const clientJwt = JwtUtil.sign({
        identityId: identity.id,
        profileId: identity.profileId,
        companyId: String(authoritativeCompanyId),
        projectId: String(authoritativeProjectId),
        channelRef,
        role: isGuest ? "guest" : "customer"
      }, jwtSecret, 3600); // 1 hour expiration

      return reply.code(200).send({
        token: clientJwt,
        sessionToken,
        guestUuid: isGuest ? channelRef : undefined,
        projectId: String(authoritativeProjectId),
        companyId: String(authoritativeCompanyId)
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Handshake failed");
      return reply.code(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  /**
   * Endpoint 2: Get Messages
   * Scopes and returns the active message log.
   */
  fastify.get("/api/v1/webchat/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const jwtSecret = getWebchatJwtSecret();

      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "Unauthorized", message: "Missing or invalid token" });
      }

      const token = authHeader.slice(7);
      const decoded = JwtUtil.verify(token, jwtSecret);
      if (!decoded) {
        return reply.code(401).send({ error: "Unauthorized", message: "Session expired or invalid" });
      }

      const { identityId, projectId } = decoded;

      const activeConv = await conversationRepo.findActiveByIdentity(identityId, projectId);
      if (!activeConv) {
        return reply.code(200).send({ conversationId: null, messages: [] });
      }

      const messages = await messageRepo.findRecentByConversationId(activeConv.id, 50);

      // Hydrate attachments
      const messagesWithAttachments = await Promise.all(
        messages.map(async (m) => {
          const { rows } = await pool.query(
            "SELECT file_url, file_name, file_type, file_size FROM message_attachments WHERE message_id = $1",
            [parseInt(m.id)]
          );
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            attachments: rows.map(r => ({
              fileUrl: r.file_url,
              fileName: r.file_name,
              fileType: r.file_type,
              fileSize: r.file_size
            }))
          };
        })
      );

      return reply.code(200).send({
        conversationId: activeConv.id,
        messages: messagesWithAttachments
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to retrieve messages");
      return reply.code(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  /**
   * Endpoint: Ephemeral Single-Use WebSocket Ticket
   * POST /api/v1/webchat/ws-ticket
   * Issues a short-lived (10s) opaque ticket for WebSocket handshake.
   */
  fastify.post("/api/v1/webchat/ws-ticket", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let jwtSecret: string;
      try {
        jwtSecret = getWebchatJwtSecret();
      } catch {
        jwtSecret = config.SESSION_SECRET || "default_jwt_secret_32_characters_minimum_length_required";
      }

      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return reply.code(401).send({ error: "Unauthorized", message: "Customer authentication required" });
      }

      const token = authHeader.slice(7).trim();
      if (!token) {
        return reply.code(401).send({ error: "Unauthorized", message: "Token cannot be empty" });
      }

      let decoded: any = null;
      try {
        decoded = JwtUtil.verify(token, jwtSecret);
      } catch {}

      if (!decoded && config.SESSION_SECRET) {
        try {
          decoded = JwtUtil.verify(token, config.SESSION_SECRET);
        } catch {}
      }

      if (!decoded) {
        return reply.code(401).send({ error: "Unauthorized", message: "Invalid or expired token" });
      }

      const ticketId = "wst_" + randomUUID();
      const ttlMs = 10_000; // 10 seconds

      wsTickets.set(ticketId, {
        identityId: String(decoded.identityId || decoded.customerId || decoded.profileId || "guest"),
        profileId: String(decoded.profileId || "guest"),
        companyId: String(decoded.companyId || "1"),
        projectId: String(decoded.projectId || "1"),
        channelRef: String(decoded.channelRef || decoded.customerId || decoded.identityId || "guest"),
        role: decoded.role === "customer" ? "customer" : "guest",
        expiresAt: Date.now() + ttlMs,
      });

      return reply.code(200).send({
        success: true,
        ticket: ticketId,
        expiresIn: 10
      });
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to issue WebSocket ticket");
      return reply.code(500).send({ error: "Internal Server Error", message: err.message });
    }
  });

  /**
   * WebSocket Integration endpoint
   * Handles real-time bidirectional message exchanges and typing notifications.
   * Authenticates exclusively via ephemeral single-use ticket (?ticket=<ticket>).
   */
  fastify.get("/api/v1/webchat/socket", { websocket: true }, (socket, req) => {
    const url = new URL(req.url || "", "http://localhost");

    // Non-negotiable security invariant: Real JWT in query is strictly rejected
    if (url.searchParams.has("token")) {
      socket.close(1008, "Token query parameter is forbidden. Use ephemeral ticket");
      return;
    }

    const ticketParam = url.searchParams.get("ticket");
    if (!ticketParam) {
      socket.close(1008, "Ticket Required");
      return;
    }

    // Atomic single-use consumption
    const ticketData = wsTickets.get(ticketParam);
    wsTickets.delete(ticketParam);

    if (!ticketData || ticketData.expiresAt <= Date.now()) {
      socket.close(1008, "Invalid, expired, or already used ticket");
      return;
    }

    const { identityId, projectId, companyId, channelRef } = ticketData;
    let room = "";

    socket.on("message", async (rawMessage: any) => {
      try {
        const payloadStr = rawMessage.toString();
        const payload = JSON.parse(payloadStr);

        // 1. Handle Typing Status Broadcasts
        if (payload.event === "typing") {
          if (room) {
            broadcastToRoom(room, {
              event: "typing",
              data: {
                senderId: channelRef,
                isTyping: !!payload.isTyping
              }
            }, socket);
          }
          return;
        }

        // 2. Handle Text Message
        const parsed = z.object({
          text: z.string().min(1),
          tempId: z.string().optional()
        }).safeParse(payload);

        if (!parsed.success) {
          socket.send(JSON.stringify({ error: "Bad Request", message: "Message content cannot be empty" }));
          return;
        }

        // Ensure active conversation exists on message send
        let conversation = await conversationRepo.findActiveByIdentity(identityId, projectId);
        if (!conversation) {
          const nextConvId = await nextSequenceId(pool, "conversations");

          conversation = new Conversation({
            id: nextConvId,
            projectId,
            identityId,
            status: "open",
            handledBy: "ai",
            channel: "WebChat"
          });
          await conversationRepo.save(conversation);
        }

        const conversationId = conversation.id;
        room = `conversation:${conversationId}`;

        // Join connection set to the conversation room if not joined yet
        if (!activeConnections.has(room)) {
          activeConnections.set(room, new Set());
        }
        activeConnections.get(room)!.add(socket);

        const receivedAtStr = new Date().toISOString();
        const inboundMsg = {
          senderId: channelRef,
          channel: "WebChat" as const,
          text: parsed.data.text,
          receivedAt: receivedAtStr,
          companyId
        };

        // Delegate to background BullMQ queue immediately
        const jobQueue = QueueFactory.getQueue();
        const requestId = randomUUID();
        await jobQueue.enqueue({
          type: "webhook_message",
          data: inboundMsg,
          metadata: {
            requestId,
            receivedAt: receivedAtStr
          }
        });

        // Broadcast back to current room to sync other user tabs
        broadcastToRoom(room, {
          event: "message",
          data: {
            id: randomUUID(),
            role: "customer",
            content: parsed.data.text,
            createdAt: receivedAtStr
          }
        }, socket);

      } catch (err: any) {
        logger.error({ error: err.message }, "Error processing socket message");
        socket.send(JSON.stringify({ error: "Internal Error", message: err.message }));
      }
    });

    // Handle initial socket link setup
    const recipientRoom = `recipient:${channelRef}`;
    if (!activeConnections.has(recipientRoom)) {
      activeConnections.set(recipientRoom, new Set());
    }
    activeConnections.get(recipientRoom)!.add(socket);

    (async () => {
      try {
        const conversation = await conversationRepo.findActiveByIdentity(identityId, projectId);
        if (conversation) {
          room = `conversation:${conversation.id}`;
          if (!activeConnections.has(room)) {
            activeConnections.set(room, new Set());
          }
          activeConnections.get(room)!.add(socket);
        }
      } catch (err: any) {
        logger.error({ error: err.message }, "Error registering socket room connection");
      }
    })();

    socket.on("close", () => {
      if (activeConnections.has(recipientRoom)) {
        activeConnections.get(recipientRoom)!.delete(socket);
        if (activeConnections.get(recipientRoom)!.size === 0) {
          activeConnections.delete(recipientRoom);
        }
      }
      if (room && activeConnections.has(room)) {
        activeConnections.get(room)!.delete(socket);
        if (activeConnections.get(room)!.size === 0) {
          activeConnections.delete(room);
        }
      }
    });
  });
}

/**
 * Broadcasts a message to all open WebSockets in a conversation room.
 * Skips the optional skipSocket parameter to avoid echoing.
 */
function broadcastToRoom(room: string, payload: any, skipSocket?: any) {
  const sockets = activeConnections.get(room);
  if (!sockets) return;

  const payloadStr = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket !== skipSocket && socket.readyState === 1) { // 1 = OPEN
      socket.send(payloadStr);
    }
  }
}