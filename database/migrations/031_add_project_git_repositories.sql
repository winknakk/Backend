-- Migration 031: Live Project Knowledge Foundation & Tenant-Safe Git Repository Mapping

CREATE TABLE IF NOT EXISTS project_git_repos (
  id BIGSERIAL PRIMARY KEY,
  org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id),
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_url VARCHAR(1024) NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'github'
    CHECK (provider IN ('github', 'gitlab', 'bitbucket', 'gitea', 'custom')),
  default_branch VARCHAR(128) NOT NULL DEFAULT 'main',
  webhook_secret_hash VARCHAR(128),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_project_git_repos_org_project_url UNIQUE (org_id, project_id, repo_url)
);

CREATE INDEX IF NOT EXISTS idx_project_git_repos_lookup
  ON project_git_repos (org_id, project_id, is_active);

CREATE TABLE IF NOT EXISTS project_git_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  repo_id BIGINT NOT NULL REFERENCES project_git_repos(id) ON DELETE CASCADE,
  event_type VARCHAR(32) NOT NULL DEFAULT 'push',
  commit_hash VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'success', 'failed')),
  files_changed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_git_sync_logs_repo
  ON project_git_sync_logs (repo_id, created_at DESC);
