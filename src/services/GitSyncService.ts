import * as crypto from "crypto";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { PostgresGitRepository } from "../infrastructure/db/PostgresGitRepository";
import { hashWebhookSecret } from "../domain/entities/GitRepositoryEntity";
import { createLogger } from "../observability/logger";

const logger = createLogger("GitSyncService");

export interface GitWebhookPayload {
  ref?: string;
  before?: string;
  after?: string;
  checkout_sha?: string;
  commits?: Array<{
    id: string;
    message?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
    timestamp?: string;
  }>;
  head_commit?: {
    id: string;
    message?: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  };
  repository?: {
    html_url?: string;
    clone_url?: string;
    git_http_url?: string;
    default_branch?: string;
    name?: string;
  };
  files?: Array<{
    path: string;
    content: string;
    action?: "add" | "modify" | "delete";
  }>;
}

export interface CodeSymbolInfo {
  symbolName: string;
  symbolType: "class" | "interface" | "method" | "function" | "sql_object" | "config" | "constant";
  lineStart: number;
  lineEnd: number;
}

export const ALLOWED_EXTENSIONS = new Set([
  ".java",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".sql",
  ".xml",
  ".yml",
  ".yaml",
  ".properties",
  ".json",
]);

export const IGNORED_PATHS = [
  "node_modules/",
  ".git/",
  "target/",
  "build/",
  "dist/",
  "coverage/",
  "vendor/",
];

export const IGNORED_SECRET_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
];

export class GitSyncService {
  private repoDb: PostgresGitRepository;

  constructor(repoDb: PostgresGitRepository = new PostgresGitRepository()) {
    this.repoDb = repoDb;
  }

  /**
   * Verifies Webhook HMAC Signature using raw payload and expected signature.
   */
  public verifyWebhookSignature(
    rawBody: string | Buffer,
    signatureHeader: string | undefined,
    secretHash: string
  ): boolean {
    if (!signatureHeader || !secretHash) return false;

    try {
      const cleanSig = signatureHeader.replace(/^sha256=/i, "").trim();
      const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

      // Verify HMAC SHA256 against body string
      const computedHash = crypto.createHmac("sha256", secretHash).update(bodyStr).digest("hex");
      return crypto.timingSafeEqual(Buffer.from(computedHash, "hex"), Buffer.from(cleanSig.padStart(64, "0").slice(0, 64), "hex"));
    } catch {
      return false;
    }
  }

  /**
   * Redacts sensitive keys, secrets, tokens, passwords from source code content.
   */
  public redactSensitiveContent(content: string): string {
    if (!content) return "";
    return content
      .replace(/(?:password|passwd|api[_-]?key|secret|private[_-]?key|auth[_-]?token|bearer)\s*[:=]\s*['"]?([a-zA-Z0-9_\-.~+/%]{8,})['"]?/gi, (match, secretVal) => {
        return match.replace(secretVal, "[REDACTED_SECRET]");
      })
      .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
  }

  /**
   * Extracts lightweight code symbols (Classes, Methods, Interfaces, Functions, SQL Tables).
   */
  public extractCodeSymbols(filePath: string, content: string): CodeSymbolInfo[] {
    const symbols: CodeSymbolInfo[] = [];
    const lines = content.split("\n");
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmed = line.trim();

      if (ext === ".java") {
        // Java Class / Interface / Method
        const classMatch = trimmed.match(/\b(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(class|interface|enum)\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          symbols.push({
            symbolName: classMatch[2],
            symbolType: classMatch[1] === "interface" ? "interface" : "class",
            lineStart: lineNum,
            lineEnd: Math.min(lineNum + 50, lines.length),
          });
        }

        const methodMatch = trimmed.match(/\b(?:public|protected|private)\s+(?:static\s+)?(?:[\w<>\[\]]+\s+)+([A-Za-z0-9_]+)\s*\(/);
        if (methodMatch && !["if", "for", "while", "switch", "catch"].includes(methodMatch[1])) {
          symbols.push({
            symbolName: methodMatch[1],
            symbolType: "method",
            lineStart: lineNum,
            lineEnd: Math.min(lineNum + 30, lines.length),
          });
        }
      } else if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
        // JS/TS Class / Function / Exported Constant
        const classMatch = trimmed.match(/\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_]+)/);
        if (classMatch) {
          symbols.push({
            symbolName: classMatch[1],
            symbolType: "class",
            lineStart: lineNum,
            lineEnd: Math.min(lineNum + 50, lines.length),
          });
        }

        const funcMatch = trimmed.match(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
        if (funcMatch) {
          symbols.push({
            symbolName: funcMatch[1],
            symbolType: "function",
            lineStart: lineNum,
            lineEnd: Math.min(lineNum + 30, lines.length),
          });
        }

        const constFuncMatch = trimmed.match(/\bexport\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/);
        if (constFuncMatch) {
          symbols.push({
            symbolName: constFuncMatch[1],
            symbolType: "function",
            lineStart: lineNum,
            lineEnd: Math.min(lineNum + 30, lines.length),
          });
        }
      } else if (ext === ".sql") {
        // SQL Table / Function / Procedure
        const tableMatch = trimmed.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)/i);
        if (tableMatch) {
          symbols.push({
            symbolName: tableMatch[1].replace(/"/g, ""),
            symbolType: "sql_object",
            lineStart: lineNum,
            lineEnd: Math.min(lineNum + 40, lines.length),
          });
        }
      }
    });

    return symbols;
  }

  /**
   * Processes Git Push Event, indexes changed files incrementally, and creates sync log.
   */
  public async processPushEvent(
    repoId: string | number,
    orgId: string,
    projectId: number,
    payload: GitWebhookPayload
  ): Promise<{ success: boolean; filesIndexed: number; commitHash: string; message: string }> {
    const startTime = Date.now();

    // 1. Verify Repository Ownership
    const repoRecord = await this.repoDb.getRepositoryById(repoId, orgId, projectId);
    if (!repoRecord || !repoRecord.isActive) {
      throw new Error(`Git Repository #${repoId} is inactive or does not belong to Org ${orgId} Project ${projectId}`);
    }

    const commitSha = payload.after || payload.head_commit?.id || payload.checkout_sha || `commit_${Date.now()}`;
    const branch = (payload.ref || "refs/heads/main").replace("refs/heads/", "");

    // 2. Idempotency Check: Prevent duplicate sync for same repo + commit
    const existingLog = await pool.query(
      `SELECT id FROM project_git_sync_logs WHERE repo_id = $1 AND commit_hash = $2 AND status = 'success' LIMIT 1`,
      [repoRecord.id, commitSha]
    );

    if (existingLog.rows.length > 0) {
      logger.info({ repoId: repoRecord.id, commitSha }, "Commit already indexed, skipping duplicate sync");
      return { success: true, filesIndexed: 0, commitHash: commitSha, message: "Commit already indexed (idempotent skip)" };
    }

    // 3. Extract changed files from payload or payload files array
    const filesToProcess = payload.files || [];
    let indexedCount = 0;

    for (const fileItem of filesToProcess) {
      const filePath = fileItem.path;
      if (!filePath) continue;

      // Filter allowed extension and ignore secret/vendor paths
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      if (IGNORED_PATHS.some((ignored) => filePath.includes(ignored))) continue;
      if (IGNORED_SECRET_FILES.some((sec) => filePath.endsWith(sec))) continue;

      const rawContent = fileItem.content || "";
      const redactedContent = this.redactSensitiveContent(rawContent);
      const symbols = this.extractCodeSymbols(filePath, redactedContent);

      const docId = `code_${repoRecord.id}_${filePath.replace(/[^a-zA-Z0-9_\-.]/g, "_")}`;
      const metadata = {
        type: "code_symbol",
        orgId: repoRecord.orgId,
        projectId: repoRecord.projectId,
        repoId: repoRecord.id,
        filePath,
        branch,
        commitSha,
        language: ext.slice(1),
        symbols,
        updatedAt: new Date().toISOString(),
      };

      // Persist into document_embeddings table using DELETE + INSERT for maximum schema compatibility
      await pool.query(`DELETE FROM document_embeddings WHERE doc_id = $1`, [docId]);
      await pool.query(
        `INSERT INTO document_embeddings (doc_id, content, metadata)
         VALUES ($1, $2, $3::jsonb)`,
        [docId, redactedContent, JSON.stringify(metadata)]
      );

      indexedCount++;
    }

    // 4. Update repository last_synced_at timestamp
    await pool.query(
      `UPDATE project_git_repos SET last_synced_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [repoRecord.id]
    );

    // 5. Create Sync Log
    await pool.query(
      `INSERT INTO project_git_sync_logs (repo_id, event_type, commit_hash, status, files_changed, started_at, completed_at)
       VALUES ($1, 'push', $2, 'success', $3, $4, NOW())`,
      [repoRecord.id, commitSha, indexedCount, new Date(startTime)]
    );

    return {
      success: true,
      filesIndexed: indexedCount,
      commitHash: commitSha,
      message: `Indexed ${indexedCount} changed files for commit ${commitSha}`,
    };
  }
}
