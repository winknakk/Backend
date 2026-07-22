import { FastifyRequest, FastifyReply } from "fastify";
import { WebChatAdapter } from "../adapters/WebChatAdapter";

export class WebChatMediaController {
  constructor(
    private webChatAdapter: WebChatAdapter,
    private orchestrator?: any
  ) {}

  async handleMultipartUpload(req: FastifyRequest, reply: FastifyReply) {
    try {
      const data = await (req as any).file();
      if (!data) {
        return reply.status(400).send({ error: "No file uploaded in multipart form" });
      }

      const buffer = await data.toBuffer();
      const fileName = data.filename;
      const mimeType = data.mimetype;
      
      const fields = data.fields;
      const identityId = fields?.identityId?.value || req.headers["x-identity-id"] || "webchat_guest";
      const sessionToken = fields?.sessionToken?.value || req.headers["authorization"] || "";
      const text = fields?.text?.value || "";

      // Adapt WebChat Direct Upload into INormalizedMessage
      const normalizedMsg = await this.webChatAdapter.adaptPayload({
        sessionToken: String(sessionToken),
        identityId: String(identityId),
        text: String(text),
        fileBuffer: buffer,
        fileName,
        mimeType
      });

      // If SessionOrchestrator is provided, process inbound message immediately
      if (this.orchestrator) {
        await this.orchestrator.processInboundMessage(normalizedMsg);
      }

      const attachment = normalizedMsg.attachments[0];

      return reply.status(200).send({
        success: true,
        messageType: normalizedMsg.messageType,
        attachment: attachment ? {
          fileUrl: attachment.fileUrl,
          fileName: attachment.fileName,
          fileType: attachment.fileType,
          fileSize: attachment.fileSize,
          storageKey: attachment.storageKey
        } : null
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: "Failed to process WebChat media upload",
        details: err.message
      });
    }
  }
}
