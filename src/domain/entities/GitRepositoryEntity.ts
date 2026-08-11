import { z } from "zod";
import * as crypto from "crypto";

export const GitProviderSchema = z.enum(["github", "gitlab", "bitbucket", "gitea", "custom"]);
export type GitProvider = z.infer<typeof GitProviderSchema>;

/**
 * Validates and normalizes Git Repository URLs.
 * Enforces protocol security: allows https:// and git@/ssh:// schemes only.
 * Rejects unsupported protocols (e.g. file://, ftp://, http:// plain).
 */
export function validateAndNormalizeRepoUrl(rawUrl: string): string {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) {
    throw new Error("Repository URL is required");
  }

  // Reject malformed or dangerous protocol schemes
  if (/^(file|ftp|gopher|telnet|javascript|data):/i.test(trimmed)) {
    throw new Error(`Unsupported or insecure Git repository URL scheme: ${trimmed}`);
  }

  // Reject plain HTTP URLs in production (require HTTPS or SSH)
  if (/^http:\/\//i.test(trimmed)) {
    throw new Error(`Insecure HTTP Git repository URL is not permitted. Use HTTPS or SSH: ${trimmed}`);
  }

  // Standard HTTPS Git URL validation
  if (/^https:\/\/[a-zA-Z0-9.\-_~]+(?::\d+)?\/[a-zA-Z0-9._\-\/]+(?:\.git)?$/i.test(trimmed)) {
    return trimmed;
  }

  // Standard SSH Git URL validation (git@github.com:user/repo.git or ssh://git@domain/repo.git)
  if (/^(?:git@[a-zA-Z0-9.\-_]+:|ssh:\/\/git@[a-zA-Z0-9.\-_~]+(?::\d+)?\/)[a-zA-Z0-9._\-\/]+(?:\.git)?$/i.test(trimmed)) {
    return trimmed;
  }

  throw new Error(`Invalid Git repository URL format: ${trimmed}`);
}

/**
 * Hashes raw webhook secret using HMAC-SHA256.
 * Never stores raw plaintext secret in database.
 */
export function hashWebhookSecret(rawSecret: string, pepper: string = process.env.WEBHOOK_SECRET || "ticketx_git_secret_pepper"): string {
  if (!rawSecret) return "";
  return crypto.createHmac("sha256", pepper).update(rawSecret).digest("hex");
}

export const CreateGitRepoInputSchema = z.object({
  repoUrl: z.string().min(5).transform(validateAndNormalizeRepoUrl),
  provider: GitProviderSchema.default("github"),
  defaultBranch: z.string().min(1).default("main"),
  webhookSecret: z.string().optional(),
});
export type CreateGitRepoInput = z.infer<typeof CreateGitRepoInputSchema>;

export const UpdateGitRepoInputSchema = z.object({
  repoUrl: z.string().min(5).transform(validateAndNormalizeRepoUrl).optional(),
  provider: GitProviderSchema.optional(),
  defaultBranch: z.string().min(1).optional(),
  webhookSecret: z.string().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateGitRepoInput = z.infer<typeof UpdateGitRepoInputSchema>;

export interface GitRepositoryRecord {
  id: string;
  orgId: string;
  projectId: number;
  repoUrl: string;
  provider: GitProvider;
  defaultBranch: string;
  webhookSecretHash?: string;
  isActive: boolean;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitSyncLogRecord {
  id: string;
  repoId: string;
  eventType: string;
  commitHash?: string;
  status: "pending" | "processing" | "success" | "failed";
  filesChanged: number;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
}
