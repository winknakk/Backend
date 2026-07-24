# Production Schema Triage
## Minimum Viable Database for Day 1

```
Classification : SCHEMA TRIAGE — REVERSE REVIEW
Date           : 2026-07-21
Objective      : Identify every premature, over-engineered, or ownerless table
                 Keep only what has a real runtime owner on Day 1
Review basis   : Post-migration 014 + 015 (44 tables total)
```

---

## Methodology

For every table, answer four questions:

1. **Who writes to it on Day 1?** (which service, worker, or API endpoint)
2. **Who reads from it on Day 1?** (which service, worker, or UI)
3. **When is the first real use?** (Milestone number)
4. **Verdict:** KEEP / DEFER / MERGE / REDESIGN

A table MUST be KEEP if:
- A running service writes to it on Day 1, OR
- Removing it would break a Day 1 runtime flow, OR
- Adding it later requires a migration under live traffic that cannot be done safely

A table SHOULD be DEFER if:
- No service writes to it until Milestone 4+
- It can be added in a clean migration without any existing data depending on it
- Its absence does not block any Day 1 flow

---

## THE VERDICT TABLE

```
KEEP on Day 1 = Must exist before first webhook arrives
DEFER         = Can be added in later migration without schema redesign
MERGE         = Fold into another table
DROP NOW      = Remove from schema entirely
```

| # | Table | Verdict | First Real Use | Notes |
|---|-------|---------|---------------|-------|
| 1 | `companies` | ✅ KEEP | Day 1 | Root tenant anchor |
| 2 | `projects` | ✅ KEEP | Day 1 | Every message needs project scope |
| 3 | `profiles` | ✅ KEEP | Day 1 | Customer identity |
| 4 | `identities` | ✅ KEEP | Day 1 | Channel lookup on every webhook |
| 5 | `profile_projects` | ⏳ DEFER | M3+ | Nobody queries this on Day 1 |
| 6 | `operators` | ✅ KEEP | Day 1 | FK anchor, Admin UI auth |
| 7 | `operator_project_access` | ⏳ DEFER | M3 | RBAC needed only when multi-operator |
| 8 | `project_channels` | ✅ KEEP | Day 1 | Webhook routing config |
| 9 | `project_prompts` | ✅ KEEP | Day 1 | PromptX reads on every inference |
| 10 | `project_sla_policies` | ✅ KEEP | Day 1 | SLA assigned on ticket create |
| 11 | `project_ai_settings` | ✅ KEEP | Day 1 | PromptX reads confidence threshold |
| 12 | `project_routing_rules` | ⏳ DEFER | M2 | No routing logic built yet |
| 13 | `project_business_hours` | ✅ KEEP | Day 1 | SLA calculation |
| 14 | `project_holidays` | ✅ KEEP | Day 1 | SLA calculation |
| 15 | `project_mcp_permissions` | ⏳ DEFER | M2 | MCP auth not enforced yet |
| 16 | `project_feature_flags` | ✅ KEEP | Day 1 | AgentRuntime reads flags |
| 17 | `company_holiday_calendars` | ⏳ DEFER | M2 | SLA chain, not M1 |
| 18 | `company_holidays` | ⏳ DEFER | M2 | Depends on calendars |
| 19 | `conversations` | ✅ KEEP | Day 1 | Core entity |
| 20 | `conversation_participants` | ⏳ DEFER | M3 | Group convs not in M1 |
| 21 | `conversation_handoffs` | ✅ KEEP | Day 1 | Takeover history needed immediately |
| 22 | `takeover_sessions` | ✅ KEEP | Day 1 | TakeoverManager writes on claim |
| 23 | `messages` | ✅ KEEP | Day 1 | Core entity |
| 24 | `message_attachments` | ✅ KEEP | Day 1 | LINE sends images on Day 1 |
| 25 | `message_media_analysis` | ⏳ DEFER | M4+ | No OCR/Vision worker on Day 1 |
| 26 | `internal_notes` | ⏳ DEFER | M3 | No operator UI on Day 1 |
| 27 | `webchat_sessions` | ⏳ DEFER | M2 | WebChat not first channel |
| 28 | `tickets` | ✅ KEEP | Day 1 | AI creates tickets via MCP tool |
| 29 | `ticket_events` | ✅ KEEP | Day 1 | Ticket domain emits events |
| 30 | `ticket_embeddings` | ⏳ DEFER | M2 | DuplicateDetector not M1 |
| 31 | `traces` | ✅ KEEP | Day 1 | AgentRuntime logs every tool call |
| 32 | `ai_thinking_traces` | ⏳ DEFER | M2 | No consumer/viewer on Day 1 |
| 33 | `ai_inference_logs` | ⏳ DEFER | M2 | Analytics, no Day 1 dashboard |
| 34 | `ai_memory` | ⏳ DEFER | M5 | Long-term memory not M1 |
| 35 | `knowledge_documents` | ✅ KEEP | Day 1 | RAG search needed from M1 |
| 36 | `knowledge_embeddings` | ✅ KEEP | Day 1 | Paired with knowledge_documents |
| 37 | `document_embeddings` | ❌ DROP | — | Deprecated, replaced by 35+36 |
| 38 | `learning_samples` | ⏳ DEFER | M6+ | No labeling pipeline on Day 1 |
| 39 | `webhook_events` | ✅ KEEP | Day 1 | Idempotency needed on first webhook |
| 40 | `domain_events` | ⏳ DEFER | M2 | Over-engineered for Day 1 |
| 41 | `outbox_events` | ✅ KEEP | Day 1 | PlaneSyncWorker uses this today |
| 42 | `conversation_events` | ✅ KEEP | Day 1 | Conversation state event log |
| 43 | `admin_audit_logs` | ✅ KEEP | Day 1 | Settings changes must be audited |
| 44 | `retention_policies` | ❌ DROP | — | Config table, no runtime owner |

---

## DETAILED TRIAGE — TABLE BY TABLE

---

### ✅ KEEP: `companies` `projects` `profiles` `identities`

**Writer:** ProcessIncomingMessageWorker on first webhook  
**Reader:** AgentRuntime, ConfigLoaderService, all API routes  
**First use:** Millisecond 1 — every webhook resolves identity → project  
**Verdict:** Non-negotiable core. Cannot defer.

---

### ⏳ DEFER: `profile_projects`

**What it is:** Junction table mapping profiles ↔ projects  
**Who writes on Day 1?** Nobody. No service currently populates this.  
**Who reads on Day 1?** Nobody. Profile-to-project scoping is done via `conversations.project_id`.  
**When first used?** Milestone 3 — when building customer-facing project selection  
**Can defer?** Yes — it's a many-to-many with no runtime dependency today  
**Risk of deferring:** None. Data exists in `nocodb_to_postgresql.sql` seed but no service queries it.

**Verdict: DEFER to migration 016 (Milestone 3 sprint)**

---

### ⏳ DEFER: `operator_project_access`

**What it is:** RBAC table — which operator can access which project  
**Who writes on Day 1?** Nobody. Admin UI for RBAC not built yet.  
**Who reads on Day 1?** Nobody. No middleware enforces project-level RBAC yet.  
**When first used?** Milestone 2 — when Admin CRUD APIs have JWT middleware  
**Can defer?** Yes — exists in migration 014 but no code references it  
**Risk of deferring:** If you have only 1 operator and 1 project (which is Day 1 reality), this table adds zero value.

**Verdict: DEFER to migration 016 (when JWT middleware ships)**

---

### ⏳ DEFER: `project_routing_rules`

**What it is:** Stores routing conditions for directing messages to handlers  
**Who writes on Day 1?** Nobody. No routing engine reads from this table yet.  
**Who reads on Day 1?** The `ConfigLoaderService.getRoutingRules()` reads it — but routing is not yet implemented in AgentRuntime.  
**When first used?** Milestone 2 — when multi-intent routing is built  
**Can defer?** Yes — removing it does not break any current runtime flow  
**Risk of deferring:** None. The table exists in the schema but the logic consuming it is not implemented.

**Verdict: DEFER to migration 016**

---

### ⏳ DEFER: `project_mcp_permissions`

**What it is:** Per-tool permission policies for MCP tools  
**Who writes on Day 1?** Nobody. Seeded with static values.  
**Who reads on Day 1?** McpToolRouter does NOT currently enforce permission checks.  
**When first used?** Milestone 2 — when MCP SSE gateway has auth middleware  
**Can defer?** Yes  
**Risk of deferring:** None. No enforcement code exists yet.

**Verdict: DEFER to migration 016**

---

### ⏳ DEFER: `company_holiday_calendars` + `company_holidays`

**What it is:** Company-level holiday chain for SLA calculation  
**Who writes on Day 1?** Nobody. Admin UI for holiday management not built.  
**Who reads on Day 1?** SLA engine doesn't exist yet. SLA calculation currently uses `project_holidays` only.  
**When first used?** Milestone 2 — when SLA engine is built  
**Can defer?** Yes — `project_holidays` is sufficient for M1  
**Risk of deferring:** None. Adding this table later requires only additive migration + FK on `project_business_hours`.

**Verdict: DEFER to migration 016**

---

### ⏳ DEFER: `conversation_participants`

**What it is:** Tracks participants in group conversations  
**Who writes on Day 1?** Nobody. Group conversations not in scope for M1.  
**Who reads on Day 1?** Nobody.  
**When first used?** Milestone 3 — LINE Group feature  
**Can defer?** Yes — it's a pure additive table with no existing FK dependencies  
**Risk of deferring:** None.

**Verdict: DEFER to migration 017 (Milestone 3 sprint)**

---

### ✅ KEEP: `conversation_handoffs`

**What it is:** Records every AI↔Human ownership transition  
**Who writes on Day 1?** TakeoverManager — writes when operator claims or releases conversation  
**Who reads on Day 1?** AgentRuntime — reads to determine current ownership before processing  
**When first used?** Day 1 — the moment the first human takeover happens  
**Can defer?** NO — if deferred, there is no persistent record of who owned the conversation and when. The takeover_sessions table alone does not capture the handoff sequence.  
**Risk of deferring:** AgentRuntime cannot distinguish "AI processing" from "Human active" without this.

**Verdict: KEEP — essential for Human Takeover M1**

---

### ⏳ DEFER: `message_media_analysis`

**What it is:** Stores OCR, Vision, and transcription results for media messages  
**Who writes on Day 1?** Nobody. No OCR or Vision worker exists yet.  
**Who reads on Day 1?** Nobody.  
**When first used?** Milestone 4 — when Vision/OCR pipeline is built  
**Can defer?** Yes — adding it later is a clean additive migration  
**Risk of deferring:** None. `message_attachments.storage_key` is sufficient for Day 1 (store the file, analyze later).

**Verdict: DEFER to migration 018 (Milestone 4 sprint)**

---

### ⏳ DEFER: `internal_notes`

**What it is:** Operator-written internal notes on conversations  
**Who writes on Day 1?** Nobody. No Admin UI for notes on Day 1.  
**Who reads on Day 1?** Nobody.  
**When first used?** Milestone 3 — when Admin Conversation UI is complete  
**Can defer?** Yes  
**Risk of deferring:** None.

**Verdict: DEFER to migration 017**

---

### ⏳ DEFER: `webchat_sessions`

**What it is:** Tracks authenticated webchat widget sessions  
**Who writes on Day 1?** Nobody. WebChat is not the first channel.  
**Who reads on Day 1?** Nobody. LINE is Day 1 channel.  
**When first used?** Milestone 2 — when WebChat widget is deployed  
**Can defer?** Yes  
**Risk of deferring:** None.

**Verdict: DEFER to migration 016**

---

### ⏳ DEFER: `ticket_embeddings`

**What it is:** Stores vector embedding per ticket for duplicate detection  
**Who writes on Day 1?** DuplicateDetectorWorker — but this worker is not running on Day 1  
**Who reads on Day 1?** Nobody.  
**When first used?** Milestone 2 — when DuplicateDetector is activated  
**Can defer?** Yes — the worker can be activated and the table added together  
**Risk of deferring:** None.

**Verdict: DEFER to migration 016**

---

### ⏳ DEFER: `ai_thinking_traces`

**What it is:** Detailed PromptX agent reasoning steps per inference  
**Who writes on Day 1?** AgentRuntime — but writing is optional (can be feature-flagged off)  
**Who reads on Day 1?** Nobody. No viewer/debugger on Day 1.  
**When first used?** Milestone 2 — when AI debugger tool is built  
**Can defer?** Yes  
**Risk of deferring:** Low. The `traces` table already captures tool calls. `ai_thinking_traces` is a richer version for debugging. Both are useful but only one is needed on Day 1.

**Verdict: DEFER to migration 016. Use `traces` table for Day 1 AI observability.**

---

### ⏳ DEFER: `ai_inference_logs`

**What it is:** Per-inference cost, token, latency tracking for analytics  
**Who writes on Day 1?** AgentRuntime (would need integration)  
**Who reads on Day 1?** Analytics dashboard — not built yet  
**When first used?** Milestone 5 — when Analytics Dashboard ships  
**Can defer?** Yes — token/latency can be logged to `traces` table temporarily  
**Risk of deferring:** Low. Missing some cost data for early conversations. Acceptable tradeoff.

**Verdict: DEFER to migration 017. Add token/cost columns to `traces` as a bridge.**

---

### ⏳ DEFER: `ai_memory`

**What it is:** Long-term cross-conversation memory per customer/project  
**Who writes on Day 1?** Nobody. No agent memory feature exists yet.  
**Who reads on Day 1?** Nobody.  
**When first used?** Milestone 5 — when Agent Memory is implemented  
**Can defer?** Yes  
**Risk of deferring:** None. This is explicitly a future milestone feature.

**Verdict: DEFER to migration 018**

---

### ⏳ DEFER: `domain_events`

**What it is:** Append-only global event store for event sourcing  
**Who writes on Day 1?** Nobody. No service publishes to `domain_events` on Day 1.  
**Who reads on Day 1?** Nobody. No consumer or projector exists.  
**When first used?** Milestone 2 — when event-driven architecture is formalized  
**Can defer?** Yes — `outbox_events` and `conversation_events` already cover Day 1 needs  
**Risk of deferring:** This is the most painful deferral. Any conversations that flow through before `domain_events` is created cannot be retroactively sourced.

**Mitigation:** Add a lightweight bridge — write 3-5 critical event types to `conversation_events` on Day 1 (message.created, takeover.acquired, takeover.released). This preserves enough replay capability until `domain_events` ships.

**Verdict: DEFER to migration 016. Bridge with `conversation_events` on Day 1.**

---

### ⏳ DEFER: `learning_samples`

**What it is:** Curated training data for AI learning pipeline  
**Who writes on Day 1?** Nobody. No labeling pipeline or curation tool exists.  
**Who reads on Day 1?** Nobody.  
**When first used?** Milestone 6+ — after enough historical data exists and a labeling UI is built  
**Can defer?** Yes — completely  
**Risk of deferring:** None for Day 1. Small risk: conversations from Day 1 through Milestone 6 cannot be retroactively labeled *without* manual effort. Acceptable.

**Verdict: DEFER to migration 019**

---

### ⏳ DEFER: `retention_policies`

**What it is:** Configuration table for data archiving rules  
**Who writes on Day 1?** Nobody. No retention job runs on Day 1.  
**Who reads on Day 1?** Nobody.  
**When first used?** When the first retention cron job is built — likely Milestone 8+  
**Can defer?** Yes  
**Risk of deferring:** None.

**Verdict: DEFER to migration 020. Replace with a simple config file or env var initially.**

---

### ❌ DROP: `document_embeddings`

**What it is:** Original pgvector table from migration 003, now replaced  
**Who writes on Day 1?** PgVectorStore.ts — but this should be migrated to `knowledge_embeddings`  
**Issue:** Two competing tables doing the same thing is a data split risk  
**Action:** Migrate all data to `knowledge_documents` + `knowledge_embeddings`, then DROP  
**Risk of keeping:** Confusion over which table is authoritative. PgVectorStore may write to old table while new table exists.

**Verdict: DROP — migrate data, then remove from schema**

---

### ❌ DROP: `retention_policies`

Already covered above. A config table with no runtime owner is dead weight.

---

## DAY 1 SCHEMA — THE MINIMUM VIABLE PRODUCTION SET

After triage, the **minimum schema needed before the first webhook arrives** is:

```
CORE TENANT (5 tables)
  companies
  projects
  operators
  profiles
  identities

PROJECT CONFIG (6 tables)
  project_channels
  project_prompts
  project_sla_policies
  project_ai_settings
  project_business_hours
  project_holidays

FEATURE FLAGS (1 table)
  project_feature_flags

CONVERSATION (6 tables)
  conversations
  messages
  message_attachments
  takeover_sessions
  conversation_handoffs
  conversation_events

TICKET (2 tables)
  tickets
  ticket_events

KNOWLEDGE / RAG (2 tables)
  knowledge_documents
  knowledge_embeddings

OPERATIONS (4 tables)
  webhook_events
  outbox_events
  traces
  admin_audit_logs

TOTAL: 26 tables
```

**DROP from Day 1 (defer or remove):**

```
DEFER to M1.5–M2 (migration 016):
  operator_project_access
  project_routing_rules
  project_mcp_permissions
  webchat_sessions
  ticket_embeddings
  ai_thinking_traces
  company_holiday_calendars
  company_holidays

DEFER to M3 (migration 017):
  conversation_participants
  internal_notes
  ai_inference_logs

DEFER to M4 (migration 018):
  message_media_analysis
  ai_memory

DEFER to M6+ (migration 019+):
  learning_samples
  domain_events

DROP NOW:
  document_embeddings      (replaced by knowledge_documents + knowledge_embeddings)
  retention_policies       (no runtime owner, use config file instead)
  profile_projects         (no current reader/writer in codebase)
```

---

## MIGRATION PHASING PLAN

```
MIGRATION 014 — Production Readiness (existing)
  Creates: operators, takeover_sessions, internal_notes,
           company_holiday_calendars, company_holidays,
           conversation_participants, ai_thinking_traces, ai_memory

MIGRATION 015 — Final Freeze (existing, but REVISED)
  Creates: webhook_events, conversation_handoffs,
           knowledge_documents, knowledge_embeddings
  Adds: soft delete, GDPR columns, slug, prompt versioning
  Drops: document_embeddings (after migration)
  Drops from scope: domain_events, learning_samples,
                    ai_inference_logs, message_media_analysis,
                    retention_policies

MIGRATION 016 — M1.5/M2 Sprint (post-Day 1)
  Creates: operator_project_access, project_routing_rules,
           project_mcp_permissions, webchat_sessions,
           ticket_embeddings, ai_thinking_traces,
           company_holiday_calendars, company_holidays,
           domain_events (proper event sourcing)
  Adds: ai_inference_logs (split from traces)

MIGRATION 017 — M3 Sprint (Group + Notes)
  Creates: conversation_participants, internal_notes,
           group_sessions

MIGRATION 018 — M4 Sprint (AI Vision + Memory)
  Creates: message_media_analysis, ai_memory

MIGRATION 019 — M6+ Sprint (AI Learning)
  Creates: learning_samples
```

---

## THE HONEST ASSESSMENT OF PREMATURE TABLES

The previous review introduced 18 new tables in migration 015. Of those 18, only **5 are truly needed on Day 1:**

| Table | Truly Day 1? | Reason |
|-------|-------------|--------|
| `webhook_events` | ✅ YES | First webhook arrives before any other code runs |
| `conversation_handoffs` | ✅ YES | TakeoverManager needs this on first claim |
| `knowledge_documents` | ✅ YES | RAG must work before first AI response |
| `knowledge_embeddings` | ✅ YES | Paired with above |
| GDPR columns on profiles/identities | ✅ YES | Cheaper to add now than after data exists |

Tables that were premature in migration 015:

| Table | Milestone | Premature Reason |
|-------|-----------|-----------------|
| `domain_events` | M2 | No publisher, no consumer exists |
| `learning_samples` | M6+ | No labeling pipeline, no training infrastructure |
| `message_media_analysis` | M4 | No OCR/Vision worker |
| `ai_inference_logs` | M5 | No analytics dashboard |
| `retention_policies` | M8+ | No retention job |

---

## IMPACT ON `traces` TABLE — BRIDGE SOLUTION

Since `ai_thinking_traces` and `ai_inference_logs` are deferred, the `traces` table must carry more weight temporarily.

**Add these bridge columns to `traces` before Day 1:**

```sql
ALTER TABLE traces
  ADD COLUMN IF NOT EXISTS project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS input_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cost_usd      NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS latency_ms    INTEGER,
  ADD COLUMN IF NOT EXISTS model_name    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS guardrail_result VARCHAR(20);
```

This makes `traces` a sufficient observability store for Milestones 1 and 2, without needing two additional tables immediately.

---

## FINAL RECOMMENDATION

**Run migration 014 as-is** (operators, takeover_sessions, etc.)

**Revise migration 015** to include only:
- webhook_events
- conversation_handoffs
- knowledge_documents + knowledge_embeddings
- Soft delete columns
- GDPR columns
- Prompt versioning columns
- traces bridge columns
- DROP document_embeddings

**Remove from migration 015:**
- domain_events → migration 016
- learning_samples → migration 019
- message_media_analysis → migration 018
- ai_inference_logs → migration 016
- retention_policies → migration 020
- ai_memory → migration 018

**Result:** Migration 015 drops from ~500 lines of SQL to ~180 lines. The production schema shrinks from 44 tables to 26 tables on Day 1, with a clear migration path for every deferred table.

---

## CONFIDENCE IN EACH DEFERRED TABLE

Every deferred table can be added with a clean `CREATE TABLE IF NOT EXISTS` migration — no existing data depends on them, no existing FKs reference them. Deferring them carries **zero technical risk** and significantly reduces the complexity of the Day 1 deployment.

The only table where deferral has a non-zero cost is `domain_events` — because conversations that flow before it is created cannot be retroactively sourced into it. This is mitigated by ensuring `conversation_events` captures the 5 most critical event types from Day 1.

---

*Triage completed: 2026-07-21*  
*Tables on Day 1: 26 (down from 44)*  
*Tables deferred: 16*  
*Tables dropped: 2 (document_embeddings, retention_policies)*
