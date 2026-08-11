import { sanitizeSensitiveData, CodeEvidence } from "../../domain/diagnostic/DeveloperDiagnostic";
import { KnowledgeResult } from "../../schemas/validation";
import { RawAttachmentInput, ProcessedAttachmentResult } from "./AttachmentIntelligenceAdapter";

export interface DiagnosticContextInput {
  customerText: string;
  conversationContext?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  ticketId?: string;
  ticketSubject?: string;
  ticketSummary?: string;
  severity?: string;
  priority?: string;
  attachments?: Array<RawAttachmentInput | ProcessedAttachmentResult>;
  knowledgeResults?: KnowledgeResult[];
  codeEvidence?: CodeEvidence[];
  projectId?: string | number;
  projectName?: string;
  tenantId?: string;
  customerProfile?: {
    customerId?: string;
    displayName?: string;
    organization?: string;
  };
}

export interface BoundedDiagnosticContext {
  customerReport: string;
  boundedHistory: string;
  ticketMetadata: string;
  attachmentSummary: string;
  ragKnowledgeContext: string;
  codeEvidenceContext: string;
  tenantId: string;
  projectId: string;
}

/**
 * DiagnosticContextBuilder assembles a token-budgeted, sanitized,
 * and tenant-isolated context for AI diagnostic analysis.
 */
export class DiagnosticContextBuilder {
  private static readonly MAX_CUSTOMER_TEXT_LENGTH = 2000;
  private static readonly MAX_HISTORY_MESSAGES = 6;
  private static readonly MAX_KNOWLEDGE_SNIPPETS = 4;
  private static readonly MAX_CODE_EVIDENCE_SNIPPETS = 3;

  public static buildBoundedContext(input: DiagnosticContextInput): BoundedDiagnosticContext {
    const tenantId = input.tenantId || "org_default";
    const projectId = String(input.projectId || "1");

    // 1. Sanitize customer report
    const rawCustomerText = (input.customerText || "").trim();
    const customerReport = sanitizeSensitiveData(
      rawCustomerText.length > this.MAX_CUSTOMER_TEXT_LENGTH
        ? rawCustomerText.slice(0, this.MAX_CUSTOMER_TEXT_LENGTH) + "\n...[Truncated]"
        : rawCustomerText
    );

    // 2. Build Bounded Conversation History
    let boundedHistory = "No previous conversation history.";
    if (input.conversationHistory && input.conversationHistory.length > 0) {
      const recentMessages = input.conversationHistory.slice(-this.MAX_HISTORY_MESSAGES);
      boundedHistory = recentMessages
        .map((m) => `${m.role.toUpperCase()}: ${sanitizeSensitiveData(m.content)}`)
        .join("\n");
    } else if (input.conversationContext) {
      boundedHistory = sanitizeSensitiveData(input.conversationContext);
    }

    // 3. Build Ticket Metadata Summary
    const ticketParts: string[] = [];
    if (input.ticketId) ticketParts.push(`Ticket ID: ${input.ticketId}`);
    if (input.ticketSubject) ticketParts.push(`Subject: ${input.ticketSubject}`);
    if (input.ticketSummary) ticketParts.push(`Summary: ${input.ticketSummary}`);
    if (input.severity) ticketParts.push(`Severity: ${input.severity}`);
    if (input.priority) ticketParts.push(`Priority: ${input.priority}`);
    if (input.customerProfile?.displayName) ticketParts.push(`Customer: ${input.customerProfile.displayName}`);
    if (input.customerProfile?.organization) ticketParts.push(`Customer Org: ${input.customerProfile.organization}`);
    const ticketMetadata = ticketParts.length > 0 ? ticketParts.join(" | ") : "No prior ticket metadata.";

    // 4. Build Attachment Summary
    let attachmentSummary = "No attachments provided.";
    if (input.attachments && input.attachments.length > 0) {
      attachmentSummary = input.attachments
        .map((att, idx) => {
          const name = att.filename || `attachment_${idx + 1}`;
          const status = (att as any).extractionStatus || "UNKNOWN";
          const textSnippet = att.extractedText
            ? `Extracted Content: "${sanitizeSensitiveData(att.extractedText.slice(0, 300))}"`
            : "Content unextracted";
          return `[File ${idx + 1}: ${name} (${status})] ${textSnippet}`;
        })
        .join("\n");
    }

    // 5. Build Bounded RAG Knowledge Context
    let ragKnowledgeContext = "No project documentation citations retrieved.";
    if (input.knowledgeResults && input.knowledgeResults.length > 0) {
      const topResults = input.knowledgeResults.slice(0, this.MAX_KNOWLEDGE_SNIPPETS);
      ragKnowledgeContext = topResults
        .map((kb, idx) => {
          const title = (kb as any).title || kb.metadata?.title || `Doc #${idx + 1}`;
          const content = kb.content ? sanitizeSensitiveData(kb.content.slice(0, 400)) : "No text content";
          return `--- Citation ${idx + 1}: ${title} ---\n${content}`;
        })
        .join("\n\n");
    }

    // 6. Build Bounded Live Code Evidence Context with Prompt Injection Defense
    let codeEvidenceContext = "No live repository code evidence retrieved.";
    if (input.codeEvidence && input.codeEvidence.length > 0) {
      const topCode = input.codeEvidence.slice(0, this.MAX_CODE_EVIDENCE_SNIPPETS);
      codeEvidenceContext = topCode
        .map((code, idx) => {
          const file = code.filePath;
          const symbol = code.symbolName ? ` symbol="${code.symbolName}"` : "";
          const lines = code.lineStart ? ` lines="${code.lineStart}-${code.lineEnd || ""}"` : "";
          const commit = code.commitSha ? ` commit="${code.commitSha}"` : "";
          const snippet = sanitizeSensitiveData(code.snippet.slice(0, 600));

          return `<CODE_EVIDENCE index="${idx + 1}" file="${file}"${symbol}${lines}${commit}>\n${snippet}\n</CODE_EVIDENCE>`;
        })
        .join("\n\n");
    }

    return {
      customerReport,
      boundedHistory,
      ticketMetadata,
      attachmentSummary,
      ragKnowledgeContext,
      codeEvidenceContext,
      tenantId,
      projectId,
    };
  }
}
