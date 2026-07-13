import { PromptXMcpClient } from "../mcp/PromptXMcpClient";
import { config } from "../config/env";

export class AiService {
  private static mcpClient = new PromptXMcpClient();

  static async generateTitle(subject: string, summary: string): Promise<string> {
    if (config.NODE_ENV === "test") {
      return `AI Title: ${subject}`;
    }

    try {
      const prompt = `You are a helpful assistant. Generate a short, concise, professional support ticket title (maximum 5 words) based on this subject: "${subject}" and description: "${summary}". Do not include quotes.`;
      
      const response = await this.mcpClient.chatAgent(
        prompt,
        { conversationId: "ai-title", history: [] },
        { companyId: "1", companyName: "System" },
        []
      );
      
      return response.text.trim().replace(/^"|"$/g, "");
    } catch (err) {
      return `AI Title: ${subject}`;
    }
  }

  static async generateSummary(
    runningSummary: string,
    newMessage: string
  ): Promise<{ runningSummary: string; lastAiSummary: string }> {
    if (config.NODE_ENV === "test") {
      const lastAiSummary = `Customer message: ${newMessage}`;
      const newRunning = runningSummary
        ? `${runningSummary}\n- ${lastAiSummary}`
        : `- ${lastAiSummary}`;
      return { runningSummary: newRunning, lastAiSummary };
    }

    try {
      const prompt = `You are a support assistant maintaining a ticket history log. 
Given the existing running summary: "${runningSummary || 'None'}" and the new customer message: "${newMessage}", 
output a JSON object containing two fields:
"runningSummary": (the updated running summary of the ticket)
"lastAiSummary": (a brief one-sentence summary of the new message)
Ensure your output is strictly a valid JSON object.`;

      const response = await this.mcpClient.chatAgent(
        prompt,
        { conversationId: "ai-summary", history: [] },
        { companyId: "1", companyName: "System" },
        []
      );

      const jsonStr = response.text.substring(response.text.indexOf("{"), response.text.lastIndexOf("}") + 1);
      const parsed = JSON.parse(jsonStr);
      return {
        runningSummary: parsed.runningSummary || runningSummary || newMessage,
        lastAiSummary: parsed.lastAiSummary || newMessage,
      };
    } catch (err) {
      const lastAiSummary = `Customer message: ${newMessage}`;
      const newRunning = runningSummary
        ? `${runningSummary}\n- ${lastAiSummary}`
        : `- ${lastAiSummary}`;
      return { runningSummary: newRunning, lastAiSummary };
    }
  }
}
