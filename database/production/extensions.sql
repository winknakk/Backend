-- Target Schema Setup
CREATE SCHEMA IF NOT EXISTS cs_tickets;
SET search_path TO cs_tickets, public;

-- ============================================================================
-- AutomationX V3 Platform — Production Database Extensions
-- Target Database: PostgreSQL 16+
-- Execution Privilege: SUPERUSER
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
