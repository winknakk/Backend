import { z } from "zod";

// --- Channel payloads ---
export const SeveritySchema = z.string().min(1, "Severity is required");
export type Severity = string;

export const PrioritySchema = z.string().min(1, "Priority is required");
export type Priority = string;

export const ChannelTypeSchema = z.enum(["LINE", "Email", "WebChat", "Teams"]);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const InboundMessageSchema = z.object({
  senderId: z.string().min(1, "Sender ID cannot be empty"),
  channel: ChannelTypeSchema,
  text: z.string().min(1, "Message content cannot be empty"),
  receivedAt: z.string().datetime(),
  companyId: z.string().optional(),
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

export const OutboundMessageSchema = z.object({
  recipientId: z.string().min(1, "Recipient ID cannot be empty"),
  channel: ChannelTypeSchema,
  text: z.string().min(1, "Response content cannot be empty"),
  sentAt: z.string().datetime(),
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
});
export type TicketInput = z.infer<typeof TicketInputSchema>;

export const TicketSchema = TicketInputSchema.extend({
  ticketId: z.string(), // e.g. TCK-2026-0001
  status: z.enum(["Open", "In Progress", "Pending", "Resolved"]),
  startDate: z.string().datetime(),
  dueDate: z.string().datetime(),
  createdBy: z.string(),
});
export type Ticket = z.infer<typeof TicketSchema>;

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
  error: z.string().nullable(),
  source: z.string(), // e.g. "nocodb_mock", "nocodb_live"
  executionId: z.string().uuid(),
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
