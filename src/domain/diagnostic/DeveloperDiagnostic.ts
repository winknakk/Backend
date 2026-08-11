import { z } from "zod";

export const EvidenceSourceSchema = z.enum([
  "CUSTOMER_REPORTED",
  "CUSTOMER_ATTACHMENT",
  "CONVERSATION_EVIDENCE",
  "KNOWLEDGE_BASE",
  "SYSTEM_OBSERVED",
  "AI_INFERENCE",
  "HUMAN_VERIFIED",
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceItemSchema = z.object({
  type: z.string(), // e.g. "text", "screenshot", "error_code", "url", "timestamp", "log"
  value: z.string(),
  source: EvidenceSourceSchema,
  location: z.string().optional(),
  rawExtraction: z.string().optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/**
 * Diagnostic Confidence Semantics:
 * Score (0-100) represents deterministic evidence/rule strength, not statistical probability.
 * - 90-100: Verified Technical Fact (verified by human or direct code/system match)
 * - 70-89:  Strong Correlation (matched with tenant project documentation)
 * - 40-69:  Reasonable Hypothesis (inferred from customer symptoms/errors)
 * - 1-39:   Weak Hypothesis (sparse customer clues)
 * - 0:      UNKNOWN / NOT_FOUND_IN_KNOWLEDGE_BASE
 */
export const ConfidenceTypeSchema = z.enum([
  "HEURISTIC_RULE_STRENGTH",
  "AI_REASONING_CONFIDENCE",
  "HUMAN_VERIFIED",
  "SYSTEM_VERIFIED",
  "MODEL_DERIVED",
]);
export type ConfidenceType = z.infer<typeof ConfidenceTypeSchema>;

export const DiagnosticFieldSchema = z.object({
  value: z.string(),
  source: EvidenceSourceSchema,
  confidence: z.number().min(0).max(100), // 0 to 100
  confidence_type: ConfidenceTypeSchema.default("HEURISTIC_RULE_STRENGTH"),
  evidence: z.string().optional(),
  isHypothesis: z.boolean().optional(),
});
export type DiagnosticField<T = string> = {
  value: T;
  source: EvidenceSource;
  confidence: number;
  confidence_type?: ConfidenceType;
  evidence?: string;
  isHypothesis?: boolean;
};

export const KnowledgeCitationSchema = z.object({
  title: z.string(),
  docId: z.string().optional(),
  snippet: z.string().optional(),
  score: z.number().optional(),
  tenantId: z.string().optional(),
  section: z.string().optional(),
});
export type KnowledgeCitation = z.infer<typeof KnowledgeCitationSchema>;

export const AttachmentEvidenceSchema = z.object({
  filename: z.string().optional(),
  url: z.string().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  extractionStatus: z.string().optional(),
  source: EvidenceSourceSchema.default("CUSTOMER_ATTACHMENT"),
});
export type AttachmentEvidence = z.infer<typeof AttachmentEvidenceSchema>;

export const CodeEvidenceSchema = z.object({
  repositoryId: z.string(),
  filePath: z.string(),
  symbolName: z.string().optional(),
  symbolType: z.string().optional(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
  language: z.string().optional(),
  snippet: z.string(),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
});
export type CodeEvidence = z.infer<typeof CodeEvidenceSchema>;

export const DeveloperDiagnosticSchema = z.object({
  project: z.union([z.string(), DiagnosticFieldSchema]).default("UNKNOWN"),
  module: z.union([z.string(), DiagnosticFieldSchema]).default("UNKNOWN"),
  feature: z.union([z.string(), DiagnosticFieldSchema]).default("UNKNOWN"),
  customer_report: z.string(),
  customer_evidence: z.array(EvidenceItemSchema).default([]),
  conversation_context: z.string().optional(),
  attachments: z.array(AttachmentEvidenceSchema).default([]),
  environment: z.string().optional(),
  reproduction_steps: z.array(z.string()).default([]),
  expected_behavior: z.string().default("System should function normally without errors"),
  actual_behavior: z.string(),
  suspected_layer: DiagnosticFieldSchema.default({
    value: "UNKNOWN",
    source: "AI_INFERENCE",
    confidence: 0,
    confidence_type: "HEURISTIC_RULE_STRENGTH",
    isHypothesis: true,
  }),
  suspected_component: DiagnosticFieldSchema.default({
    value: "UNKNOWN",
    source: "AI_INFERENCE",
    confidence: 0,
    confidence_type: "HEURISTIC_RULE_STRENGTH",
    isHypothesis: true,
  }),
  suspected_api: DiagnosticFieldSchema.default({
    value: "NOT_FOUND_IN_KNOWLEDGE_BASE",
    source: "AI_INFERENCE",
    confidence: 0,
    confidence_type: "HEURISTIC_RULE_STRENGTH",
    isHypothesis: true,
  }),
  suspected_database_object: DiagnosticFieldSchema.default({
    value: "NOT_FOUND_IN_KNOWLEDGE_BASE",
    source: "AI_INFERENCE",
    confidence: 0,
    confidence_type: "HEURISTIC_RULE_STRENGTH",
    isHypothesis: true,
  }),
  root_cause_hypothesis: DiagnosticFieldSchema.default({
    value: "Requires further technical investigation",
    source: "AI_INFERENCE",
    confidence: 0,
    confidence_type: "HEURISTIC_RULE_STRENGTH",
    isHypothesis: true,
  }),
  confidence: z.number().min(0).max(100).default(0),
  confidence_type: ConfidenceTypeSchema.default("HEURISTIC_RULE_STRENGTH"),
  knowledge_sources: z.array(KnowledgeCitationSchema).default([]),
  code_evidence: z.array(CodeEvidenceSchema).default([]),
  unknowns: z.array(z.string()).default([]),
  recommended_next_action: z.string().default("Review customer logs and reproduce in staging environment"),
});

export type DeveloperDiagnostic = z.infer<typeof DeveloperDiagnosticSchema>;

/**
 * Sanitizes sensitive credentials and secrets from text.
 */
export function sanitizeSensitiveData(text: string): string {
  if (!text) return "";
  return text
    .replace(/(?:api[_-]?key|secret|token|password|pass|auth|bearer)\s*[:=]\s*['"]?([a-zA-Z0-9_\-.~+/%]{8,})['"]?/gi, (m, g1) => {
      return m.replace(g1, "[REDACTED_SECRET]");
    })
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-[REDACTED_API_KEY]")
    .replace(/plane_api_[a-zA-Z0-9_-]{20,}/g, "plane_api_[REDACTED]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED_JWT]");
}
