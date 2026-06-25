import { InboundMessage } from "../../schemas/validation";

export interface AgentResult {
  text: string;
  handoffTo?: string;
  handoffReason?: string;
  handoffContext?: Record<string, any>;
  handoffHistory?: string[];
}

export interface IAgent {
  readonly id: string;
  readonly name: string;
  handle(message: InboundMessage, sessionContext: any): Promise<AgentResult>;
}

export interface IAgentRouter {
  route(message: InboundMessage, sessionContext: any): Promise<IAgent>;
  registerAgent(agent: IAgent): void;
  getAgent(id: string): IAgent | null;
  listAgents(): IAgent[];
}
