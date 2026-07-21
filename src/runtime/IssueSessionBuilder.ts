import { randomUUID } from "crypto";
import { IssueSession, RuntimeFlags, RuntimeMetadata, ConversationState, TicketState } from "./IssueSession";
import { RuntimeContext } from "../services/RuntimeContextResolver";

export class IssueSessionBuilder {
  private sessionId: string = randomUUID();
  private context?: RuntimeContext;
  private flags: RuntimeFlags = {
    allowReply: true,
    allowWorkflow: true,
    allowToolExecution: true,
    allowTicketCreation: true,
    allowTakeover: true,
    allowMemoryWrite: true
  };
  private metadata: RuntimeMetadata = {
    locale: "th",
    timezone: "Asia/Bangkok"
  };
  private conversation?: ConversationState;
  private ticket?: TicketState;

  withSessionId(id: string): this {
    this.sessionId = id;
    return this;
  }

  withContext(context: RuntimeContext): this {
    this.context = context;
    return this;
  }

  withFlags(flags: Partial<RuntimeFlags>): this {
    this.flags = { ...this.flags, ...flags };
    return this;
  }

  withMetadata(metadata: Partial<RuntimeMetadata>): this {
    this.metadata = { ...this.metadata, ...metadata };
    return this;
  }

  withConversation(conversation: ConversationState): this {
    this.conversation = conversation;
    return this;
  }

  withTicket(ticket: TicketState): this {
    this.ticket = ticket;
    return this;
  }

  build(): IssueSession {
    if (!this.context) {
      throw new Error("Cannot build IssueSession without a RuntimeContext");
    }
    if (!this.conversation) {
      throw new Error("Cannot build IssueSession without ConversationState");
    }

    const session = new IssueSession(
      this.sessionId,
      this.context,
      this.flags,
      this.metadata,
      this.conversation,
      this.ticket || { slaBreached: false }
    );
    return session;
  }
}
