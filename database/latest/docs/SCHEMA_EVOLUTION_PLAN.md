# Schema Evolution Plan
## TicketX / PromptX Platform — Database Transformation History

```
Classification : SCHEMA EVOLUTION PLAN
Date           : 2026-07-21
Target         : Database Architecture Snapshot
```

---

## Evolution Stages

### Stage 1: Legacy Baseline (`nocodb_to_postgresql.sql` + `001_initial_schema.sql` - `003`)
* **State:** Prototype import from NoCoDB.
* **Entities:** `companies`, `projects`, `profiles`, `conversations`, `messages`, `tickets`.
* **Characteristics:** Primary keys were integer `SERIAL`. `tickets.conversation_id` was mandatory. No operator RBAC.

### Stage 2: Platform Schema V3 & Event Store (`004_v3_platform_schema.sql` - `008`)
* **State:** Introduction of multi-tenant configuration tables and event logging.
* **Entities Added:** `project_prompts`, `project_sla_policies`, `project_ai_settings`, `project_business_hours`, `project_holidays`, `project_feature_flags`, `webchat_sessions`, `message_attachments`, `outbox_events`, `conversation_events`.

### Stage 3: Ticket Intelligence V2 & Uniqueness (`010_ticket_intelligence_v2.sql` - `013`)
* **State:** Alignment of ticket identifiers and idempotency safeguards.
* **Entities Added/Altered:** `tickets.ticket_id` string identifier, `ticket_events`, `ticket_embeddings`, `admin_audit_logs`, `messages.external_id` UNIQUE constraint.

### Stage 4: Production Readiness & Minimum Viable Day 1 (`014_production_readiness.sql` - `015_day1_minimum_viable.sql`)
* **State:** Enterprise user hierarchy, security encryption, idempotency, and knowledge RAG.
* **Entities Added:** `operators`, `operator_project_access`, `takeover_sessions`, `internal_notes`, `company_holiday_calendars`, `company_holidays`, `webhook_events`, `knowledge_documents`, `knowledge_embeddings`.
* **State Added:** `deleted_at` (Soft Delete) and GDPR consent fields on `profiles` and `identities`.

### Stage 5: Domain Tables & Architectural Corrections (`016_domain_tables.sql` - `017_architectural_corrections.sql`)
* **State:** Alignment with DDD multi-context architecture.
* **Entities Added:** `conversation_participants`, `customer_enrollments`, `conversation_ticket_links`, `teams`.
* **Structural Fixes:** `tickets.conversation_id` made NULLABLE. `messages.ticket_id` and `messages.message_purpose` added to decouple messaging from tickets.

---

## Final Production Snapshot Layout (`database/latest/`)

The resulting database after running all migrations (001 through 017) corresponds 1:1 with the clean DDL files stored in `database/latest/`:

* `schema/01_identity_tenant.sql` (14 tables)
* `schema/02_messaging.sql` (3 tables)
* `schema/03_support_operations.sql` (6 tables)
* `schema/04_agent_ai.sql` (3 tables)
* `schema/05_knowledge_rag.sql` (3 tables)
* `schema/06_ingestion_automation.sql` (4 tables)
* `schema/07_context_mapping.sql` (4 tables)
* `functions/01_helper_functions.sql`
* `views/01_reporting_views.sql`
* `triggers/01_audit_and_updated_at.sql`
* `policies/01_rls_tenant_isolation.sql`
