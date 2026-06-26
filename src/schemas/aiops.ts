import { z } from "zod";

// --- Dashboard Metrics ---
export const HandoffNodeSchema = z.object({
  agentId: z.string(),
  timestamp: z.string().datetime(),
  reason: z.string().optional(),
});
export type HandoffNode = z.infer<typeof HandoffNodeSchema>;

export const ConversationTraceSummarySchema = z.object({
  conversationId: z.string(),
  tenantId: z.string(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional(),
  durationMs: z.number().optional(),
  handoffChain: z.array(HandoffNodeSchema),
  status: z.enum(["RUNNING", "COMPLETED", "FAILED", "HANDOFF"]),
  slaViolated: z.boolean(),
});
export type ConversationTraceSummary = z.infer<typeof ConversationTraceSummarySchema>;

// --- RAG Ingestion Payload ---
export const DocumentIngestionPayloadSchema = z.object({
  tenantId: z.string().min(1, "Tenant ID is required"),
  projectId: z.string().optional(),
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Content is required"),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type DocumentIngestionPayload = z.infer<typeof DocumentIngestionPayloadSchema>;

export const KnowledgeChunkSchema = z.object({
  chunkId: z.string(),
  docId: z.string(),
  tenantId: z.string(),
  projectId: z.string().optional(),
  content: z.string(),
  chunkIndex: z.number(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

// --- Agent Evaluation ---
export const EvalTestCaseSchema = z.object({
  testCaseId: z.string(),
  inputMessage: z.string(),
  expectedAgentId: z.string(),
  expectedToolCalls: z.array(z.string()).optional(),
});
export type EvalTestCase = z.infer<typeof EvalTestCaseSchema>;

export const EvalResultSchema = z.object({
  testCaseId: z.string(),
  actualAgentId: z.string(),
  actualToolCalls: z.array(z.string()),
  success: z.boolean(),
  accuracyScore: z.number().min(0).max(1),
  error: z.string().optional(),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

// --- Human Takeover Status ---
export const RoomStatusSchema = z.enum(["ACTIVE_AI", "PENDING_HUMAN", "ACTIVE_HUMAN"]);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const TakeoverStateSchema = z.object({
  conversationId: z.string(),
  status: RoomStatusSchema,
  assignedHumanAgentId: z.string().optional(),
  updatedAt: z.string().datetime(),
  leaseExpiresAt: z.string().datetime().optional(),
});
export type TakeoverState = z.infer<typeof TakeoverStateSchema>;

// --- Prompt A/B Testing ---
export const PromptVersionMetadataSchema = z.object({
  version: z.string(),
  filePath: z.string(),
  description: z.string().optional(),
});
export type PromptVersionMetadata = z.infer<typeof PromptVersionMetadataSchema>;

export const AbTestWeightSchema = z.object({
  tenantId: z.string(),
  promptName: z.string(),
  variants: z.array(
    z.object({
      version: z.string(),
      weight: z.number().min(0).max(1),
    })
  ),
});
export type AbTestWeight = z.infer<typeof AbTestWeightSchema>;
