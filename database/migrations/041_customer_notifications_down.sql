-- Rollback for migration 041.
DROP INDEX IF EXISTS uq_customer_notifications_idempotency;
DROP INDEX IF EXISTS idx_customer_notifications_conversation;
DROP INDEX IF EXISTS idx_customer_notifications_ticket;
DROP TABLE IF EXISTS customer_notifications;
