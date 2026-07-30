-- ============================================================
-- Migration 022: Queue Plane deletion before a linked Ticket is deleted
-- ============================================================

CREATE OR REPLACE FUNCTION queue_linked_plane_work_item_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Plane-originated deletes set this transaction-local flag so the database
  -- does not enqueue a redundant delete back to Plane.
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
        'planeIssueId', OLD.plane_issue_id
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
