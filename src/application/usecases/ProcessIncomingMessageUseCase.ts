import { Orchestrator } from "../../orchestrator/Orchestrator";
import { InboundMessage, OutboundMessage } from "../../schemas/validation";

export class ProcessIncomingMessageUseCase {
  constructor(private orchestrator: Orchestrator) {}

  /**
   * Executes the inbound message processing use case.
   */
  async execute(message: InboundMessage, requestId?: string): Promise<OutboundMessage> {
    return await this.orchestrator.handleIncomingMessage(message, requestId);
  }
}
