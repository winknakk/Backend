# Migration Plan
## TicketX / PromptX Platform — PostgreSQL Migration Assessment & Forward Strategy

```
Classification : MIGRATION PLAN
Date           : 2026-07-21
Status         : APPROVED & FORWARD-ONLY
Target         : PostgreSQL 16 Target Database
```

---

## 1. Migration History Assessment Matrix

The table below documents every migration file in `database/migrations/`. Existing migrations (001 through 013 + NoCoDB dump) are **immutable sources of truth**. Forward-only migrations (014 through 017) apply all missing architectural requirements.

| Migration File | Purpose / Description | Still Valid? | Replace? | Superseded? | Needs Follow-up Migration? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `nocodb_to_postgresql.sql` | Legacy dump from NoCoDB prototype export | ✅ Yes (Historical) | ❌ No | ⚠️ Partial (004 & 010 alter schema) | ❌ No (Immutable baseline) |
| `001_initial_schema.sql` | Core schema (companies, projects, profiles, conversations, messages, tickets) | ✅ Yes | ❌ No | ⚠️ Partial (columns added in 004/010/014) | ✅ Yes (014, 015, 017) |
| `002_indexes.sql` | Basic performance indexes | ✅ Yes | ❌ No | ❌ No | ✅ Yes (Composite indexes in 014/015) |
| `003_pgvector_embeddings.sql` | Vector extension & `document_embeddings` table | ✅ Yes | ❌ No | ⚠️ Deprecated by `knowledge_documents` in 015 | ✅ Yes (015 knowledge tables) |
| `004_v3_platform_schema.sql` | Multi-tenant config tables (prompts, sla, business hours, feature flags) | ✅ Yes | ❌ No | ❌ No | ✅ Yes (014, 015 prompt versioning) |
| `005_extended_sla_policies.sql` | Enhanced SLA policy columns | ✅ Yes | ❌ No | ❌ No | ✅ Yes (017 total exposure time) |
| `005_fix_plane_issue_id_type.sql` | Fix Plane issue ID type to VARCHAR | ✅ Yes | ❌ No | ❌ No | ❌ No |
| `006_add_tickets_created_at.sql` | Add created_at timestamp to tickets | ✅ Yes | ❌ No | ❌ No | ❌ No |
| `007_add_projects_metadata.sql` | Add environment and project_type to projects | ✅ Yes | ❌ No | ❌ No | ✅ Yes (015 slug & status) |
| `007_webchat_support.sql` | `webchat_sessions` and `message_attachments` | ✅ Yes | ❌ No | ❌ No | ✅ Yes (014/015 attachment storage keys) |
| `008_event_store_and_outbox.sql` | `outbox_events` and `conversation_events` | ✅ Yes | ❌ No | ❌ No | ✅ Yes (014 aggregate reference columns) |
| `010_ticket_intelligence_v2.sql` | Ticket re-alignment (`ticket_id` string, `ticket_events`, `ticket_embeddings`) | ✅ Yes | ❌ No | ❌ No | ✅ Yes (014 SLA, 017 nullable conv_id) |
| `011_add_enrichment_state.sql` | Add enrichment_state column to tickets | ✅ Yes | ❌ No | ❌ No | ❌ No |
| `012_add_audit_logs_table.sql` | `admin_audit_logs` table | ✅ Yes | ❌ No | ❌ No | ✅ Yes (014 operator_id column) |
| `013_message_uniqueness.sql` | Add external_id & UNIQUE constraint to messages | ✅ Yes | ❌ No | ❌ No | ✅ Yes (015 webhook idempotency) |
| **014_production_readiness.sql** | Adds `operators`, `takeover_sessions`, `internal_notes`, `company_holidays` | 🆕 **Forward-Only** | ❌ No | ❌ No | ❌ No |
| **015_day1_minimum_viable.sql** | Adds `webhook_events`, `knowledge_documents`, `knowledge_embeddings`, Soft Delete, GDPR | 🆕 **Forward-Only** | ❌ No | ❌ No | ❌ No |
| **016_domain_tables.sql** | Adds `conversation_participants`, `customer_enrollments` + Backfill Script | 🆕 **Forward-Only** | ❌ No | ❌ No | ❌ No |
| **017_architectural_corrections.sql** | Makes `tickets.conversation_id` Nullable, adds `conversation_ticket_links`, `messages.ticket_id`, `teams` | 🆕 **Forward-Only** | ❌ No | ❌ No | ❌ No |

---

## 2. Rules of Engagement

1. **Existing Migrations Are Immutable:** Files `001` through `013` and `nocodb_to_postgresql.sql` MUST NOT be edited, renumbered, or deleted.
2. **Forward-Only Migrations Only:** All new schema requirements are applied via `014_production_readiness.sql`, `015_day1_minimum_viable.sql`, `016_domain_tables.sql`, and `017_architectural_corrections.sql`.
3. **Additive Preference:** Column drops and table drops are avoided in favor of nullable additive columns and soft-delete flags.
