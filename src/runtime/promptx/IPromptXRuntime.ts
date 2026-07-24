import { PromptXFormattedPayload } from "./formatters/PromptXMultimodalFormatter";

export interface PromptXExecuteRequest {
  sessionId: string;
  agentKey: 'support' | 'gate' | 'sales' | 'faq';
  formattedMessage: PromptXFormattedPayload;
  history?: any[];
  companyId: string;
  channel: string;
}

export interface PromptXExecuteResponse {
  content: string;
  toolCalls: any[];
}

export interface IPromptXRuntime {
  execute(request: PromptXExecuteRequest): Promise<PromptXExecuteResponse>;
  executeWithToolResults(request: any): Promise<string>;
}
