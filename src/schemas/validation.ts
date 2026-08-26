import { z } from "zod";

// --- Channel payloads ---
export const SeveritySchema = z.string().min(1, "Severity is required");
export type Severity = string;

export const PrioritySchema = z.string().min(1, "Priority is required");
export type Priority = string;

export const ChannelTypeSchema = z.enum(["LINE", "line", "line_group", "LINE_GROUP", "Email", "WebChat", "Teams"]);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const InboundMessageSchema = z.object({
  senderId: z.string().min(1, "Sender ID cannot be empty"),
  channel: ChannelTypeSchema,
  text: z.string().min(1, "Message content cannot be empty"),
  receivedAt: z.string().datetime(),
  companyId: z.string().optional(),
  externalId: z.string().optional(),
  replyToMessageId: z.union([z.string(), z.number()]).optional(),
  quotedMessageId: z.union([z.string(), z.number()]).optional(),
  quoteToken: z.string().optional(),
  isMentioned: z.boolean().optional(),
  senderRef: z.string().optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const OutboundMessageSchema = z.object({
  recipientId: z.string().min(1, "Recipient ID cannot be empty"),
  channel: ChannelTypeSchema,
  text: z.string(),
  sentAt: z.string().datetime(),
  externalId: z.string().optional(),
  suppressReply: z.boolean().optional(),
}).superRefine((message, context) => {
  if (!message.suppressReply && message.text.trim().length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["text"],
      message: "Response content cannot be empty unless suppressReply is true",
    });
  }
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;

// --- Ticket payloads ---
export const TicketInputSchema = z.object({
  conversationId: z.string().min(1, "Conversation ID is required"),
  subject: z.string().min(5, "Subject must be at least 5 characters long"),
  summary: z.string().min(10, "Summary must be at least 10 characters long"),
  severity: SeveritySchema,
  priority: PrioritySchema,
  projectId: z.string().min(1, "Project ID is required"),
  createdByType: z.string().optional(),
  createdByName: z.string().optional(),
  diagnostic: z.any().optional(),
  attachments: z.array(z.any()).optional(),
});
export type TicketInput = z.infer<typeof TicketInputSchema>;

export const TicketSchema = TicketInputSchema.extend({
  ticketId: z.string(), // e.g. TCK-2026-0001
  // TicketX customer lifecycle. Plane's engineering vocabulary lives in
  // plane_status; see src/domain/ticket/TicketLifecycle.ts.
  status: z.enum([
    "NEW",
    "TRIAGED",
    "OPEN",
    "IN_PROGRESS",
    "WAITING_CUSTOMER",
    "WAITING_INTERNAL",
    "RESOLVED",
    "CUSTOMER_CONFIRMED",
    "CLOSED",
    "REOPENED",
    "CANCELLED",
  ]),
  planeStatus: z.enum(["Backlog", "Open", "Done", "Cancelled"]).optional(),
  startDate: z.string().datetime(),
  dueDate: z.string().datetime(),
  createdBy: z.string(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const CloseTicketInputSchema = z.object({
  ticketId: z.string().min(1, "Ticket ID is required"),
  cancellation_reason: z.string().min(10, "A valid cancellation_reason (at least 10 characters) is required"),
});
export type CloseTicketInput = z.infer<typeof CloseTicketInputSchema>;

export const RestoreTicketInputSchema = z.object({
  ticketId: z.string().min(1, "Ticket ID is required"),
});
export type RestoreTicketInput = z.infer<typeof RestoreTicketInputSchema>;

// --- Policy & Audit payloads ---
export const PolicyRuleSchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  type: z.enum(["permission", "sanitization", "rate-limit"]),
  action: z.enum(["allow", "deny", "modify"]),
  mcpToolNames: z.array(z.string()),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const AuditLogSchema = z.object({
  traceId: z.string().uuid(),
  sessionId: z.string(),
  agentId: z.string().optional(),
  toolName: z.string(),
  calledAt: z.string().datetime(),
  reason: z.string().optional(),
  arguments: z.record(z.string(), z.any()),
  result: z.record(z.string(), z.any()).optional(),
  status: z.enum(["RUNNING", "COMPLETED", "FAILED", "HANDOFF"]),
  errorMessage: z.string().optional(),
  completedAt: z.string().datetime().optional(),
  requestId: z.string().optional(),
  conversationId: z.string().optional(),
  parentTraceId: z.string().optional(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

// --- V2 Execution Result Wrapper ---
export const ExecutionResultSchema = z.object({
  success: z.boolean(),
  data: z.any().nullable(),
  error: z
    .union([
      z.string(),
      z.object({
        errorCode: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        correlationId: z.string(),
      }),
    ])
    .nullable(),
  source: z.string(), // e.g. "nocodb_mock", "nocodb_live"
  executionId: z.string().uuid(),
  errorCode: z.string().optional(),
  retryable: z.boolean().optional(),
  correlationId: z.string().optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

// --- V2 Knowledge Result Schema ---
export const KnowledgeResultSchema = z.object({
  source: z.string(),
  id: z.string(),
  type: z.enum(["ticket", "message", "document"]),
  content: z.string(),
  confidence: z.number(), // score 0.0 to 1.0
  metadata: z.record(z.string(), z.any()).optional(),
});
export type KnowledgeResult = z.infer<typeof KnowledgeResultSchema>;
