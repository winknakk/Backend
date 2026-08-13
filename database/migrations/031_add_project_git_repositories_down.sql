-- Down migration 031: Live Project Knowledge Foundation & Tenant-Safe Git Repository Mapping

DROP TABLE IF EXISTS project_git_sync_logs CASCADE;
DROP TABLE IF EXISTS project_git_repos CASCADE;
