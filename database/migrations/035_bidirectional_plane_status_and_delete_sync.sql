-- ============================================================
-- Migration 035: Bidirectional Plane Status and Delete Synchronization
-- ============================================================

-- 1. Function and Trigger for Ticket Status and Priority Updates -> Plane Work Item
CREATE OR REPLACE FUNCTION queue_linked_plane_work_item_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Plane-originated sync updates set this transaction-local flag to avoid infinite loops
  IF COALESCE(current_setting('ticketx.skip_plane_sync', TRUE), 'off') = 'on' THEN
    RETURN NEW;
  END IF;

  -- Only trigger when status or priority actually changed and linked Plane Issue ID is a valid UUID
  IF (OLD.status IS DISTINCT FROM NEW.status OR OLD.priority IS DISTINCT FROM NEW.priority)
     AND NULLIF(BTRIM(NEW.plane_issue_id), '') IS NOT NULL
     AND NEW.plane_issue_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    
    INSERT INTO outbox_events (
      aggregate_type,
      aggregate_id,
      event_type,
      payload,
      status,
      attempts,
      created_at,
      updated_at
    )
    VALUES (
      'ticket',
      COALESCE(NEW.ticket_number, NEW.ticket_id, NEW.id::text),
      'PlaneWorkItemUpdateRequested',
      jsonb_build_object(
        'ticketId', COALESCE(NEW.ticket_number, NEW.ticket_id, NEW.id::text),
        'dbId', NEW.id,
        'planeIssueId', NEW.plane_issue_id,
        'projectId', NEW.project_id,
        'orgId', NEW.org_id,
        'planeWorkspaceSlug', NEW.plane_workspace_slug,
        'planeProjectId', NEW.plane_project_id,
        'oldStatus', OLD.status,
        'newStatus', NEW.status,
        'oldPriority', OLD.priority,
        'newPriority', NEW.priority
      ),
      'pending',
      0,
      NOW(),
      NOW()
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_linked_plane_work_item_update ON tickets;

CREATE TRIGGER trg_queue_linked_plane_work_item_update
AFTER UPDATE ON tickets
FOR EACH ROW
EXECUTE FUNCTION queue_linked_plane_work_item_update();

-- 2. Enhanced Trigger for Ticket Deletion -> Plane Work Item (Includes Multi-Project Context)
CREATE OR REPLACE FUNCTION queue_linked_plane_work_item_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Plane-originated deletes set this transaction-local flag to avoid infinite loops
  IF COALESCE(current_setting('ticketx.skip_plane_delete', TRUE), 'off') = 'on' THEN
    RETURN OLD;
  END IF;

  -- Plane work-item IDs are UUIDs. Ignore legacy placeholders and mock links.
  IF NULLIF(BTRIM(OLD.plane_issue_id), '') IS NOT NULL
     AND OLD.plane_issue_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    INSERT INTO outbox_events (
      aggregate_type,
      aggregate_id,
      event_type,
      payload,
      status,
      attempts,
      created_at,
      updated_at
    )
    VALUES (
      'ticket',
      COALESCE(OLD.ticket_number, OLD.ticket_id, OLD.id::text),
      'PlaneWorkItemDeleteRequested',
      jsonb_build_object(
        'ticketId', COALESCE(OLD.ticket_number, OLD.ticket_id, OLD.id::text),
        'dbId', OLD.id,
        'planeIssueId', OLD.plane_issue_id,
        'projectId', OLD.project_id,
        'orgId', OLD.org_id,
        'planeWorkspaceSlug', OLD.plane_workspace_slug,
        'planeProjectId', OLD.plane_project_id
      ),
      'pending',
      0,
      NOW(),
      NOW()
    );
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_linked_plane_work_item_delete ON tickets;

CREATE TRIGGER trg_queue_linked_plane_work_item_delete
BEFORE DELETE ON tickets
FOR EACH ROW
EXECUTE FUNCTION queue_linked_plane_work_item_delete();
