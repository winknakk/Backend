import { WebChatSession } from "../entities/WebChatSession";

export interface IWebChatSessionRepository {
  findByToken(token: string): Promise<WebChatSession | null>;
  save(session: WebChatSession): Promise<WebChatSession>;
}
