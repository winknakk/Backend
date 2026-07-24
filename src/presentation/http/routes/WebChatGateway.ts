import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import { JwtUtil } from "../../../shared/jwt";
import { pool } from "../../../adapters/postgres/PostgresAdapter";
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

const logger = createLogger("WebChatGateway");

// In-memory registry of active WebSocket sockets grouped by conversationId room
const activeConnections = new Map<string, Set<any>>();

// Redis Pub/Sub subscriber client for horizontal scaling
let redisSub: Redis | null = null;

const HandshakeSchema = z.object({
  customerToken: z.string().optional(),
  guestUuid: z.string().optional(),
  companyId: z.string().default("1"),
  projectId: z.string().default("1")
});

export default async function WebChatGateway(fastify: FastifyInstance) {
  const conversationRepo = new PostgresConversationRepository();
  const messageRepo = new PostgresMessageRepository();
  const identityRepo = new PostgresIdentityRepository();
  const profileRepo = new PostgresProfileRepository();
  const sessionRepo = new PostgresWebChatSessionRepository();

  const jwtSecret = config.API_KEY || "webchat_secret_fallback";

  // Setup Redis Subscriber once
  if (!redisSub) {
    redisSub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    redisSub.subscribe("webchat:outbound").catch(err => {
      logger.error({ error: err.message }, "Failed to subscribe to Redis outbound channel");
    });
    redisSub.on("message", (channel, message) => {
      if (channel === "webchat:outbound") {
        try {
          const payload = JSON.parse(message);
          const room = `conversation:${payload.conversationId}`;
          broadcastToRoom(room, {
            event: "message",
            data: {
              id: payload.id || randomUUID(),
              role: payload.role || "ai",
              content: payload.text,
              createdAt: payload.sentAt || new Date().toISOString(),
              attachments: payload.attachments || []
            }
          });
        } catch (err: any) {
          logger.error({ error: err.message }, "Failed to process Redis pub/sub message");
        }
      }
    });
  }

  /**
   * Endpoint 1: Handshake
   * Yields a short-lived signed JWT for guests or logged-in users.
   */
  fastify.post("/api/v1/webchat/handshake", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const parsed = HandshakeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Bad Request",
          message: parsed.error.issues.map(e => `${e.path.join(".")}: ${e.message}`).join(", ")
        });
      }

      const { customerToken, guestUuid, companyId, projectId } = parsed.data;

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

      // 2. Profile Resolution Strategy
      let identity: Identity | null = null;
      let resolvedGuestUuid = guestUuid || randomUUID();

      if (isGuest) {
        channelRef = resolvedGuestUuid;
        identity = await identityRepo.findByChannelAndRef("WebChat", channelRef);

        if (!identity) {
          // Dynamic Guest compilation
          const nextProfileIdRes = await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM profiles");
          const nextProfileId = String(nextProfileIdRes.rows[0].next_id);

          const guestProfile = new Profile({
            id: nextProfileId,
            companyId,
            name: `Guest_${channelRef.slice(0, 8)}`
          });
          await profileRepo.save(guestProfile);

          const nextIdentIdRes = await pool.query(
            "SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM identities"
          );
          const nextIdentId = String(nextIdentIdRes.rows[0].next_id);

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
          // Check if customer profile exists by name/company
          const profileCheck = await pool.query(
            "SELECT id FROM profiles WHERE name = $1 AND company_id = $2 LIMIT 1",
            [customerName, parseInt(companyId)]
          );

          let profileId = "";
          if (profileCheck.rows.length > 0) {
            profileId = String(profileCheck.rows[0].id);
          } else {
            const nextProfileIdRes = await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM profiles");
            profileId = String(nextProfileIdRes.rows[0].next_id);
            const customerProfile = new Profile({
              id: profileId,
              companyId,
              name: customerName
            });
            await profileRepo.save(customerProfile);
          }

          const nextIdentIdRes = await pool.query(
            "SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM identities"
          );
          const nextIdentId = String(nextIdentIdRes.rows[0].next_id);

          identity = new Identity({
            id: nextIdentId,
            profileId,
            channel: "WebChat",
            channelRef
          });
          await identityRepo.save(identity);
        }
      }

      // 3. Session Compilation & Token Generation
      // NOTE: jti is required here — without a nonce, two handshake calls with
      // identical claims (same identity, same second-precision exp) produce the
      // exact same signed token string, which collides on the
      // webchat_sessions.session_token UNIQUE constraint (root cause of the
      // 500 seen when React StrictMode double-invokes the mount effect).
      const sessionToken = JwtUtil.sign(
        { identityId: identity.id, channelRef, role: isGuest ? "guest" : "customer", jti: randomUUID() },
        jwtSecret,
        86400
      );

      const nextSessionIdRes = await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM webchat_sessions");
      const nextSessionId = String(nextSessionIdRes.rows[0].next_id);

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
        companyId,
        projectId,
        channelRef,
        role: isGuest ? "guest" : "customer"
      }, jwtSecret, 3600); // 1 hour expiration

      return reply.code(200).send({
        token: clientJwt,
        sessionToken,
        guestUuid: isGuest ? channelRef : undefined,
        projectId,
        companyId
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
   * WebSocket Integration endpoint
   * Handles real-time bidirectional message exchanges and typing notifications.
   */
  fastify.get("/api/v1/webchat/socket", { websocket: true }, (socket, req) => {
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token");

    if (!token) {
      socket.close(1008, "Token Required");
      return;
    }

    const decoded = JwtUtil.verify(token, jwtSecret);
    if (!decoded) {
      socket.close(1008, "Invalid or Expired Token");
      return;
    }

    const { identityId, projectId, companyId, channelRef } = decoded;
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
          const nextConvRes = await pool.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM conversations");
          const nextConvId = String(nextConvRes.rows[0].next_id);

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
        activeConnections.get(room)!.add(socket);        // Format Inbound Message shape for core engine (Let the PromptX Flow save it to database via HTTP endpoint!)
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

        // Broadcast back to current room to sync other user tabs (in-memory only, database insert happens in flow)
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