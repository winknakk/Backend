/**
 * Phase 3: Customer & Conversation Intelligence Configuration
 * Centralized, versioned constants avoiding scattered magic numbers.
 */

export const INTELLIGENCE_CONFIG = {
  weights: {
    // Approved Phase 3 Discovery baseline weights
    lowRetrieval: 0.35,
    customerRephrasing: 0.25,
    evasiveResponse: 0.20,
    immediateTakeover: 0.20,
  },
  thresholds: {
    knowledgeGapScore: 0.50,
    lowRetrievalConfidence: 0.65,
    evalPassThreshold: 0.85,
    lateEscalationTurnCount: 5,
  },
  windows: {
    rephrasingWindowSeconds: 300,
    handoffWindowSeconds: 120,
    repeatProblemDays: 30,
  },
  clustering: {
    minInquiries: 3,
    minUniqueProfiles: 2,
    evidenceWindowDays: 7,
    similarityThreshold: 0.80,
  },
  batching: {
    classificationBatchSize: 10,
    maxTokenBudgetPerCall: 2000,
  },
  queue: {
    name: "conversation-intelligence-queue",
    concurrency: 3,
    priority: 10,
    maxRetries: 3,
    backoffDelayMs: 5000,
  },
  versions: {
    algorithmVersion: "v1",
    taxonomyVersion: "v1",
    modelVersion: "v1",
    evaluationPolicyVersion: "eval-v1",
  },
} as const;

/**
 * Resolves the authoritative timezone for a project, avoiding hardcoded Bangkok logic.
 * Precedence: project.timezone -> process.env.DEFAULT_TIMEZONE -> 'UTC'
 */
export function resolveProjectTimezone(projectTimezone?: string | null): string {
  if (projectTimezone && typeof projectTimezone === "string" && projectTimezone.trim() !== "") {
    return projectTimezone.trim();
  }
  return process.env.DEFAULT_TIMEZONE || "UTC";
}
