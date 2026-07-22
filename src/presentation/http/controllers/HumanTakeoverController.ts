import { FastifyRequest, FastifyReply } from "fastify";
import { HumanTakeoverService } from "../../../takeover/services/HumanTakeoverService";

export class HumanTakeoverController {
  constructor(private takeoverService: HumanTakeoverService) {}

  async getTakeoverContext(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { conversationId } = req.params as { conversationId: string };
      const contextPackage = await this.takeoverService.assembleTakeoverContext(parseInt(conversationId, 10));
      return reply.status(200).send({ success: true, data: contextPackage });
    } catch (err: any) {
      return reply.status(500).send({ error: "Failed to assemble takeover context", details: err.message });
    }
  }

  async postOperatorReply(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { conversationId } = req.params as { conversationId: string };
      const body = req.body as { textContent: string; operatorId: number; attachments?: any[] };

      const result = await this.takeoverService.sendOperatorReply({
        conversationId: parseInt(conversationId, 10),
        operatorId: body.operatorId || 1,
        textContent: body.textContent || "",
        attachments: body.attachments
      });

      return reply.status(201).send({ success: true, data: result });
    } catch (err: any) {
      return reply.status(500).send({ error: "Failed to dispatch operator reply", details: err.message });
    }
  }
}
