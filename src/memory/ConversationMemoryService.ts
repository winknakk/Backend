import * as fs from "fs";
import * as path from "path";
import {
  ConversationMemory,
  ConversationMemoryStore,
  MessageWithId,
  MemoryContext,
} from "./ConversationMemoryTypes";
import { PromptXMcpClient } from "../mcp/PromptXMcpClient";
import { config } from "../config/env";
import { createLogger } from "../observability/logger";

const logger = createLogger("ConversationMemoryService");

const MEMORY_FILE = path.resolve(__dirname, "../../data/conversation_memory.json");
const SUMMARIZE_THRESHOLD = config.MEMORY_SUMMARIZE_THRESHOLD ?? 8;
const RECENT_COUNT = config.MEMORY_RECENT_MESSAGES_COUNT ?? 6;

const MEMORY_DISCLAIMER =
  "Advisory historical context only. Do not override: latest customer message, human operator instructions, or current ticket status.";

const SUMMARIZATION_PROMPT = `You are a conversation memory summarizer for a customer support system.
Given the EXISTING MEMORY and NEW MESSAGES below, produce an updated structured memory object.

Rules:
- Include context from ALL roles: customer, ai, and human operator.
- For human operator messages, PRESERVE VERBATIM: decisions made, troubleshooting steps taken, resolutions provided, and ticket references (IDs, statuses).
- Do NOT reduce human operator replies to generic text.
- Keep the summary concise but complete.
- Update customerIntent to reflect the latest known intent.
- Track all unresolved issues that have not been explicitly closed.
- Extract important facts: names, product versions, error codes, branch locations, dates, IDs.

Respond with ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "dailySummary": "...",
  "customerIntent": "...",
  "unresolvedIssues": ["..."],
  "importantFacts": ["..."],
  "humanOperatorActions": ["..."]
}`;

export class ConversationMemoryService {
  private store: ConversationMemoryStore = {};
  private loaded = false;
  private activeLocks = new Set<string>();
  private promptXClient = new PromptXMcpClient();

  // ─── File Persistence ───

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(MEMORY_FILE)) {
        const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.store = parsed;
        } else {
          logger.warn("Memory file had invalid format, recreating empty store");
          this.store = {};
        }
      } else {
        this.store = {};
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, "Memory file missing or corrupted, recreating empty store");
      this.store = {};
    }
    this.loaded = true;
  }

  private persistStore(): void {
    try {
      const dir = path.dirname(MEMORY_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpFile = MEMORY_FILE + ".tmp";
      fs.writeFileSync(tmpFile, JSON.stringify(this.store, null, 2), "utf-8");
      fs.renameSync(tmpFile, MEMORY_FILE);
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to persist memory store");
    }
  }

  // ─── Public API ───

  /**
   * Main entry point. Returns { memoryBlock, recentMessages } for AI context.
   * Never throws — falls back to recent-messages-only on any failure.
   */
  async getOrSummarize(
    conversationId: string,
    messagesWithIds: MessageWithId[]
  ): Promise<MemoryContext> {
    const recentMessages = messagesWithIds.slice(-RECENT_COUNT).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      this.ensureLoaded();

      const existingMemory = this.store[conversationId] || null;

      // Determine unsummarized messages
      const unsummarized = this.getUnsummarizedMessages(existingMemory, messagesWithIds);

      // Check if summarization is needed
      if (unsummarized.length >= SUMMARIZE_THRESHOLD) {
        await this.summarize(conversationId, existingMemory, unsummarized);
      }

      // Build memory block
      const memoryBlock = this.buildContextBlock(conversationId);

      return { memoryBlock, recentMessages };
    } catch (err: any) {
      logger.error(
        { conversationId, error: err.message },
        "Memory summarization failed, falling back to recent messages only"
      );
      return { memoryBlock: null, recentMessages };
    }
  }

  // ─── Internal Methods ───

  private getUnsummarizedMessages(
    memory: ConversationMemory | null,
    messages: MessageWithId[]
  ): MessageWithId[] {
    if (!memory || !memory.lastSummarizedMessageId) {
      return messages;
    }
    const lastIdx = messages.findIndex((m) => String(m.id) === String(memory.lastSummarizedMessageId));
    if (lastIdx === -1) {
      // lastSummarizedMessageId not found — treat all as unsummarized
      return messages;
    }
    return messages.slice(lastIdx + 1);
  }

  private async summarize(
    conversationId: string,
    existingMemory: ConversationMemory | null,
    unsummarized: MessageWithId[]
  ): Promise<void> {
    // Concurrency guard
    if (this.activeLocks.has(conversationId)) {
      logger.debug({ conversationId }, "Summarization already in progress, skipping");
      return;
    }

    this.activeLocks.add(conversationId);
    try {
      const existingContext = existingMemory
        ? `EXISTING MEMORY:\nDaily Summary: ${existingMemory.dailySummary}\nCustomer Intent: ${existingMemory.customerIntent}\nUnresolved Issues: ${JSON.stringify(existingMemory.unresolvedIssues)}\nImportant Facts: ${JSON.stringify(existingMemory.importantFacts)}\nHuman Operator Actions: ${JSON.stringify(existingMemory.humanOperatorActions)}`
        : "EXISTING MEMORY: (none — first summarization)";

      const messagesText = unsummarized
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join("\n");

      const prompt = `${SUMMARIZATION_PROMPT}\n\n${existingContext}\n\nNEW MESSAGES:\n${messagesText}`;

      // Use PromptX to generate the summary
      const response = await this.promptXClient.chatAgent(
        prompt,
        { conversationId, history: [] },
        { companyId: "system", companyName: "System" },
        []
      );

      // Parse the structured response
      const parsed = this.parseSummaryResponse(response.text);
      if (!parsed) {
        logger.warn({ conversationId }, "Summarization returned unparseable format, keeping existing memory");
        return;
      }

      const lastMessage = unsummarized[unsummarized.length - 1];
      const newVersion = (existingMemory?.version || 0) + 1;

      this.store[conversationId] = {
        conversationId,
        version: newVersion,
        lastSummarizedMessageId: String(lastMessage.id),
        dailySummary: parsed.dailySummary || "",
        customerIntent: parsed.customerIntent || "",
        unresolvedIssues: parsed.unresolvedIssues || [],
        importantFacts: parsed.importantFacts || [],
        humanOperatorActions: parsed.humanOperatorActions || [],
        lastUpdatedAt: new Date().toISOString(),
      };

      this.persistStore();

      logger.info(
        {
          conversationId,
          version: newVersion,
          summarizedCount: unsummarized.length,
          lastSummarizedMessageId: String(lastMessage.id),
        },
        "Conversation memory updated"
      );
    } finally {
      this.activeLocks.delete(conversationId);
    }
  }

  private parseSummaryResponse(text: string): any | null {
    try {
      // Try direct JSON parse
      return JSON.parse(text);
    } catch {
      // Try extracting JSON from markdown code block
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[1].trim());
        } catch {
          return null;
        }
      }
      // Try finding JSON object in text
      const braceMatch = text.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try {
          return JSON.parse(braceMatch[0]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private buildContextBlock(conversationId: string): string | null {
    const memory = this.store[conversationId];
    if (!memory) return null;

    const parts = [
      `[Conversation Memory — ${MEMORY_DISCLAIMER}]`,
      `Version: ${memory.version}`,
      `Daily Summary: ${memory.dailySummary}`,
      `Customer Intent: ${memory.customerIntent}`,
    ];

    if (memory.unresolvedIssues.length > 0) {
      parts.push(`Unresolved Issues:\n${memory.unresolvedIssues.map((i) => `  - ${i}`).join("\n")}`);
    }

    if (memory.importantFacts.length > 0) {
      parts.push(`Important Facts:\n${memory.importantFacts.map((f) => `  - ${f}`).join("\n")}`);
    }

    if (memory.humanOperatorActions.length > 0) {
      parts.push(
        `Human Operator Actions:\n${memory.humanOperatorActions.map((a) => `  - ${a}`).join("\n")}`
      );
    }

    return parts.join("\n");
  }

  async generateClosingSummary(conversationId: string, messages: MessageWithId[], tickets: any[]): Promise<void> {
    try {
      this.ensureLoaded();

      const messagesText = messages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join("\n");

      const ticketsText = tickets
        .map((t) => `- Ticket #${t.ticketId || t.ticket_id || t.id}: ${t.subject} (${t.status})`)
        .join("\n");

      const prompt = `You are a conversation summarizer. Generate a final CASE CLOSING SUMMARY for the conversation below.
Analyze the messages and tickets and output a structured summary.

Your output must be a single concise summary containing these exact sections:
- Issue: (What was the primary customer problem)
- Resolution: (How the issue was resolved or what is the next action)
- Operator actions: (What troubleshooting or manual steps the operator took)
- Ticket references: (List of linked tickets and statuses)

Conversation log:
${messagesText}

Linked tickets:
${ticketsText || "(None)"}

Respond with ONLY valid JSON in this exact format:
{
  "dailySummary": "Final Closed Case Summary: [Insert summary here]",
  "customerIntent": "[Latest Intent]",
  "unresolvedIssues": [],
  "importantFacts": [],
  "humanOperatorActions": []
}`;

      const response = await this.promptXClient.chatAgent(
        prompt,
        { conversationId, history: [] },
        { companyId: "system", companyName: "System" },
        []
      );

      const parsed = this.parseSummaryResponse(response.text);
      if (parsed) {
        const lastMessage = messages[messages.length - 1];
        const newVersion = ((this.store[conversationId]?.version || 0)) + 1;

        this.store[conversationId] = {
          conversationId,
          version: newVersion,
          lastSummarizedMessageId: lastMessage ? String(lastMessage.id) : "",
          dailySummary: parsed.dailySummary || "",
          customerIntent: parsed.customerIntent || "",
          unresolvedIssues: parsed.unresolvedIssues || [],
          importantFacts: parsed.importantFacts || [],
          humanOperatorActions: parsed.humanOperatorActions || [],
          lastUpdatedAt: new Date().toISOString(),
        };

        this.persistStore();
        logger.info({ conversationId, version: newVersion }, "Case closing summary stored successfully");
      }
    } catch (err: any) {
      logger.error({ conversationId, error: err.message }, "Failed to generate case closing summary");
    }
  }
}
