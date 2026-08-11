import { pool } from "../../adapters/postgres/PostgresAdapter";
import {
  GitRepositoryRecord,
  GitSyncLogRecord,
  CreateGitRepoInput,
  UpdateGitRepoInput,
  hashWebhookSecret,
} from "../../domain/entities/GitRepositoryEntity";

export class PostgresGitRepository {
  /**
   * Enforces strict tenant and project isolation on database query execution.
   */
  private assertTenantContext(orgId: string, projectId: number): void {
    if (!orgId || typeof orgId !== "string" || !orgId.trim()) {
      throw new Error("Security Violation: Tenant Context orgId is mandatory for Git repository access");
    }
    if (projectId === undefined || projectId === null || isNaN(Number(projectId)) || Number(projectId) <= 0) {
      throw new Error("Security Violation: Valid Project ID is mandatory for Git repository access");
    }
  }

  async createRepository(
    input: CreateGitRepoInput,
    orgId: string,
    projectId: number
  ): Promise<GitRepositoryRecord> {
    this.assertTenantContext(orgId, projectId);

    const secretHash = input.webhookSecret ? hashWebhookSecret(input.webhookSecret) : null;

    const query = `
      INSERT INTO project_git_repos (
        org_id, project_id, repo_url, provider, default_branch, webhook_secret_hash, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      RETURNING id, org_id, project_id, repo_url, provider, default_branch, webhook_secret_hash, is_active, last_synced_at, created_at, updated_at;
    `;

    const { rows } = await pool.query(query, [
      orgId,
      projectId,
      input.repoUrl,
      input.provider || "github",
      input.defaultBranch || "main",
      secretHash,
    ]);

    return this.mapToRecord(rows[0]);
  }

  async getRepositoryById(
    repoId: string | number,
    orgId: string,
    projectId: number
  ): Promise<GitRepositoryRecord | null> {
    this.assertTenantContext(orgId, projectId);

    const query = `
      SELECT id, org_id, project_id, repo_url, provider, default_branch, webhook_secret_hash, is_active, last_synced_at, created_at, updated_at
      FROM project_git_repos
      WHERE id = $1 AND org_id = $2 AND project_id = $3
      LIMIT 1;
    `;

    const { rows } = await pool.query(query, [repoId, orgId, projectId]);
    if (rows.length === 0) return null;
    return this.mapToRecord(rows[0]);
  }

  async listRepositories(
    orgId: string,
    projectId: number
  ): Promise<GitRepositoryRecord[]> {
    this.assertTenantContext(orgId, projectId);

    const query = `
      SELECT id, org_id, project_id, repo_url, provider, default_branch, webhook_secret_hash, is_active, last_synced_at, created_at, updated_at
      FROM project_git_repos
      WHERE org_id = $1 AND project_id = $2
      ORDER BY created_at DESC;
    `;

    const { rows } = await pool.query(query, [orgId, projectId]);
    return rows.map((r) => this.mapToRecord(r));
  }

  async updateRepository(
    repoId: string | number,
    input: UpdateGitRepoInput,
    orgId: string,
    projectId: number
  ): Promise<GitRepositoryRecord | null> {
    this.assertTenantContext(orgId, projectId);

    const existing = await this.getRepositoryById(repoId, orgId, projectId);
    if (!existing) return null;

    const secretHash = input.webhookSecret !== undefined
      ? (input.webhookSecret ? hashWebhookSecret(input.webhookSecret) : null)
      : existing.webhookSecretHash;

    const repoUrl = input.repoUrl ?? existing.repoUrl;
    const provider = input.provider ?? existing.provider;
    const defaultBranch = input.defaultBranch ?? existing.defaultBranch;
    const isActive = input.isActive ?? existing.isActive;

    const query = `
      UPDATE project_git_repos
      SET repo_url = $1, provider = $2, default_branch = $3, webhook_secret_hash = $4, is_active = $5, updated_at = NOW()
      WHERE id = $6 AND org_id = $7 AND project_id = $8
      RETURNING id, org_id, project_id, repo_url, provider, default_branch, webhook_secret_hash, is_active, last_synced_at, created_at, updated_at;
    `;

    const { rows } = await pool.query(query, [
      repoUrl,
      provider,
      defaultBranch,
      secretHash,
      isActive,
      repoId,
      orgId,
      projectId,
    ]);

    return rows.length > 0 ? this.mapToRecord(rows[0]) : null;
  }

  async deleteRepository(
    repoId: string | number,
    orgId: string,
    projectId: number
  ): Promise<boolean> {
    this.assertTenantContext(orgId, projectId);

    const query = `
      DELETE FROM project_git_repos
      WHERE id = $1 AND org_id = $2 AND project_id = $3;
    `;

    const { rowCount } = await pool.query(query, [repoId, orgId, projectId]);
    return (rowCount ?? 0) > 0;
  }

  async createSyncLog(
    repoId: string | number,
    eventType: string,
    orgId: string,
    projectId: number,
    commitHash?: string,
    filesChanged: number = 0
  ): Promise<GitSyncLogRecord> {
    this.assertTenantContext(orgId, projectId);

    // Verify repo ownership first
    const repo = await this.getRepositoryById(repoId, orgId, projectId);
    if (!repo) {
      throw new Error(`Git Repository ${repoId} not found under org ${orgId} project ${projectId}`);
    }

    const query = `
      INSERT INTO project_git_sync_logs (repo_id, event_type, commit_hash, status, files_changed, started_at)
      VALUES ($1, $2, $3, 'pending', $4, NOW())
      RETURNING id, repo_id, event_type, commit_hash, status, files_changed, error_message, started_at, completed_at, created_at;
    `;

    const { rows } = await pool.query(query, [repoId, eventType || "push", commitHash || null, filesChanged]);
    return this.mapToSyncLogRecord(rows[0]);
  }

  async listSyncLogs(
    repoId: string | number,
    orgId: string,
    projectId: number,
    limit: number = 20
  ): Promise<GitSyncLogRecord[]> {
    this.assertTenantContext(orgId, projectId);

    const repo = await this.getRepositoryById(repoId, orgId, projectId);
    if (!repo) return [];

    const query = `
      SELECT id, repo_id, event_type, commit_hash, status, files_changed, error_message, started_at, completed_at, created_at
      FROM project_git_sync_logs
      WHERE repo_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `;

    const { rows } = await pool.query(query, [repoId, limit]);
    return rows.map((r) => this.mapToSyncLogRecord(r));
  }

  private mapToRecord(row: any): GitRepositoryRecord {
    return {
      id: String(row.id),
      orgId: row.org_id,
      projectId: Number(row.project_id),
      repoUrl: row.repo_url,
      provider: row.provider,
      defaultBranch: row.default_branch,
      webhookSecretHash: row.webhook_secret_hash || undefined,
      isActive: Boolean(row.is_active),
      lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : undefined,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private mapToSyncLogRecord(row: any): GitSyncLogRecord {
    return {
      id: String(row.id),
      repoId: String(row.repo_id),
      eventType: row.event_type,
      commitHash: row.commit_hash || undefined,
      status: row.status,
      filesChanged: Number(row.files_changed || 0),
      errorMessage: row.error_message || undefined,
      startedAt: new Date(row.started_at).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }
}
