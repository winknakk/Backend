-- Migration 039: Reverse-sync change detection
--
-- Problem this addresses:
--   The reverse-sync poller fetched every linked work item from Plane every
--   30 seconds and wrote the result back unconditionally. Observed over a
--   single 100-second boot:
--
--     11:28:25  checked 19  updated 16  failed 3
--     11:29:52  checked 19  updated  3  failed 16
--
--   The same 19 items were rewritten on each cycle, and the inversion to
--   16 failures is the signature of Plane throttling a client that
--   re-writes 16 records every 30 seconds.
--
--   Recording the Plane-side version we last applied lets the poller skip
--   items that have not changed, which is both the correctness fix (no
--   spurious writes, no spurious ticket_events) and the reason the
--   throttling stops.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS plane_last_seen_updated_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN tickets.plane_last_seen_updated_at IS
  'Plane work item updated_at last applied by reverse sync. Used to skip unchanged records.';

-- Reverse sync scans linked tickets per Plane project mapping.
CREATE INDEX IF NOT EXISTS idx_tickets_plane_linkage
  ON tickets (plane_workspace_slug, plane_project_id, plane_issue_id)
  WHERE plane_issue_id IS NOT NULL;
