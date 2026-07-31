-- ============================================================
-- Migration 024: Store Plane priority names in tickets.priority
-- ============================================================

UPDATE tickets
SET priority = CASE LOWER(BTRIM(priority))
  WHEN 'p1' THEN 'Urgent'
  WHEN 'urgent' THEN 'Urgent'
  WHEN 'p2' THEN 'High'
  WHEN 'high' THEN 'High'
  WHEN 'p3' THEN 'Medium'
  WHEN 'medium' THEN 'Medium'
  WHEN 'p4' THEN 'Low'
  WHEN 'low' THEN 'Low'
  WHEN 'none' THEN 'None'
  ELSE priority
END,
updated_at = NOW()
WHERE LOWER(BTRIM(priority)) IN ('p1', 'urgent', 'p2', 'high', 'p3', 'medium', 'p4', 'low', 'none');
