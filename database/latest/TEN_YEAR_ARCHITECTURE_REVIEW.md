# Ten-Year Database Architecture Review
## TicketX / PromptX Platform — Long-Term Evolution Strategy

```
Classification : FINAL ARCHITECTURE REVIEW — 10-YEAR HORIZON
Date           : 2026-07-21
Scope          : Not individual tables. The system as an evolving architecture.
Method         : Challenge every aggregate boundary. Find every hidden coupling.
                 Recommend only what survives 5 years of production growth.
Goal           : Freeze decisions that become exponentially expensive after data exists.
```

---

## EXECUTIVE POSITION

The current schema has a foundational tension that will not resolve itself.

The platform is **built as Conversation-centric** today.
The platform is **designed to become Issue-centric** tomorrow.

These two architectures are not compatible at the aggregate level.

The core question is not "which tables to add or remove."
The core question is:

> **What is the primary unit of work in this system?**

If the answer is **Conversation** — then all entities belong to a conversation.
If the answer is **Issue/Ticket** — then conversations are just communication channels into an issue.

**The answer cannot be both simultaneously.** And the choice made in the schema
today will cost weeks of engineering to change after production data exists.

This document answers that question and its consequences.

---

## QUESTION 1: Conversation-centric or Issue-centric?

### The Honest Assessment

The current schema is conversation-centric by implementation but issue-centric by intent.

Evidence of **conversation-centric implementation:**
- `tickets.conversation_id` — ticket BELONGS TO conversation (conversation is parent)
- `takeover_sessions.conversation_id` — takeover is scoped to conversation
- `conversation_handoffs.conversation_id` — handoff is scoped to conversation
- `traces.conversation_id` — AI trace is scoped to conversation
- `ai_thinking_traces.conversation_id` — reasoning is scoped to conversation
- `conversation_participants.conversation_id` — participants of conversation, not issue

Evidence of **issue-centric intent:**
- The system creates tickets (issues) via AI tool calls — ticket IS the work unit
- SLA is on the ticket, not the conversation
- Priority/severity/status is on the ticket
- The platform is called "TicketX"
- Human takeover is conceptually "taking over the issue," not the conversation thread

**The schema says:** conversations own tickets.
**The business says:** issues own conversations.

This inversion is the most expensive architectural mistake in the current schema,
and it will compound with every table added before it is corrected.

### Which is Correct for This Platform?

For a platform called TicketX that:
- Creates tickets via AI tool calls
- Applies SLA to tickets
- Assigns operators to tickets
- Syncs tickets to Plane.io
- Eventually allows one conversation to contain multiple independent issues

**The Issue/Ticket must be the aggregate root.**

The conversation is the communication channel.
The ticket is the unit of work.

They must coexist, but the FK direction between them must reflect which is primary.

### The Correct Long-Term Relationship

```
WRONG (current):
  Conversation (parent)
      └── Ticket (child, via tickets.conversation_id)

CORRECT (for 10-year evolution):
  Issue/Ticket (aggregate root)
      ├── linked_conversations[] (channels where issue was discussed)
      └── messages scoped to this issue (optional — via ticket_id on messages)
```

The practical consequence:

Today, if a customer talks in one LINE thread and later sends an email about
the same problem, they create two separate conversations but only one issue.
In the current schema, you would create two tickets (one per conversation).
In the correct model, one ticket exists and both conversations reference it.

---

## QUESTION 2: What to Do NOW Without Creating an Issue Table

The following decisions cost nothing today and prevent expensive migrations later.

### Decision 1: Make `tickets.conversation_id` nullable

**Current:**
```sql
conversation_id INTEGER NOT NULL REFERENCES conversations(id)
```

**Change to:**
```sql
conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL
```

**Why:** This one column being NOT NULL locks the entire ticket concept to conversation-origin.
Tickets created via API, email, phone, or admin interface will have no conversation.
After production data exists, changing NOT NULL to nullable requires a careful ALTER
that can lock a table with millions of rows.

**Cost today:** Zero. One ALTER TABLE.
**Cost after production with 1M tickets:** Table lock risk, application code audit.

### Decision 2: Add `ticket_id` (nullable) to `messages`

**Current:** messages belong only to a conversation.

**Add:**
```sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
```

**Why:** This enables "scoping a message to an issue" without changing the conversation
structure. When Issue #1 (printer) is resolved and Issue #2 (login) begins in the same
conversation, the messages for Issue #2 can be tagged with the new ticket_id.

Without this column, the AI has no way to know "which messages in this conversation
are about THIS issue vs. the previous resolved issue."

**Cost today:** Zero. One nullable column with index.
**Cost after production with 100M messages:** Index rebuild on a massive table.

### Decision 3: Add `parent_ticket_id` to `tickets` (self-referential)

```sql
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS parent_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
```

**Why:** Enables ticket hierarchy (epic → issue → sub-task) without a schema change.
If the platform later introduces "Issue Clusters" or "Epic-level problems," the table
already supports it.

### Decision 4: Add `conversation_ticket_links` junction table

Instead of tickets.conversation_id being the only link, add an explicit junction:

```sql
CREATE TABLE conversation_ticket_links (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  link_type       VARCHAR(50) NOT NULL DEFAULT 'primary'
                  CHECK (link_type IN ('primary','related','escalated_from','merged_from')),
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by       VARCHAR(50) DEFAULT 'system',  -- 'ai','operator','system'
  PRIMARY KEY (conversation_id, ticket_id)
);
```

This allows: one ticket → many conversations, and one conversation → many tickets,
without changing the existing FK on tickets.

### Decision 5: Never use `conversation_id` as the SLA anchor

SLA timing must always reference `tickets.created_at`, `tickets.first_response_at`,
and `tickets.due_date` — never conversation timing.

This is not a schema change but an application contract that should be documented
and enforced via code review.

### Decision 6: Establish naming canon before any new tables

Document this before production:

| Current Name | Long-term Name | Note |
|-------------|---------------|------|
| `tickets` | `issues` (eventually) | Or accept "ticket" = "issue" permanently |
| `profiles` | `customers` (conceptually) | Rename column-by-column |
| `identities` | `channel_identities` | More precise |
| `projects` | `projects` (keep) | Or evolve to `workspaces` |
| `companies` | `organizations` (eventually) | Enterprise terminology |

**None of these need to change now.** But the decision of whether they will change
must be made now — because renaming tables after millions of FK references exist
requires a coordinated migration across database, application, and API layers.

---

## QUESTION 3: Which Tables Are Wrongly Coupled to Conversation?

### `tickets` — MOST WRONG

**Current:** `tickets.conversation_id` — ticket belongs to conversation.
**Should be:** Conversation can be linked to a ticket, but ticket is independent.
**Migration difficulty (later):** HIGH — requires nullifying existing FKs, creating junction table,
updating every query that does `JOIN tickets ON tickets.conversation_id = conversations.id`.
**Action now:** Make nullable + add `conversation_ticket_links`.

### `takeover_sessions` — PARTIALLY WRONG

**Current:** `takeover_sessions.conversation_id` — takeover is for a conversation.
**The argument for keeping it:** In a single-issue world, taking over a conversation
is the same as taking over the issue. Correct for Day 1.
**The future problem:** If one conversation contains Issue #1 (resolved) and Issue #2
(active), a takeover should be scoped to Issue #2 — not the entire conversation.
An operator taking over "the conversation" when Issue #1 is resolved and Issue #2
is active is ambiguous.
**Action now:** Add nullable `ticket_id` column to `takeover_sessions`.
**Migration difficulty (later):** MEDIUM — additive column, but backfill is complex.

### `conversation_handoffs` — PARTIALLY WRONG

**Current:** `conversation_handoffs.conversation_id` — handoff is for a conversation.
**Same argument as takeover_sessions.** A handoff should be scoped to an active issue,
not just a conversation thread.
**Future problem:** Historical handoff data will not be queryable by issue — only by conversation.
For AI learning ("how was this class of issue handled during human takeover?"),
handoffs must be issue-scoped.
**Action now:** Add nullable `ticket_id` to `conversation_handoffs`.

### `ai_memory` — WRONG

**Current:** `ai_memory.source_conv_id` — memory comes from a conversation.
**Should be:** Memory comes from an issue, not a conversation. The AI should remember
"Customer X has a recurring printer problem" — which is about an issue pattern, not
a specific conversation.
**Future problem:** If the same customer has 50 conversations, the AI's memory is
conversation-scoped and fragmented. It should be issue-type-scoped or pattern-scoped.
**Action now:** Add `source_ticket_id` to `ai_memory`. Change `source_conv_id` to nullable.
**Migration difficulty (later):** MEDIUM.

### `traces` / `ai_thinking_traces` — PARTIALLY WRONG

**Current:** Both use `conversation_id` (string in traces, INTEGER FK in ai_thinking_traces).
**Issue:** AI reasoning is triggered by a message in a conversation, but the reasoning
is about an issue. Analytics query "how did AI reason about printer problems?" cannot
be answered if traces are only conversation-scoped.
**Action now:** Add `ticket_id` (nullable) to both tables.

### `messages.role` — CONCEPTUALLY WRONG

**Current:** `role IN ('customer','ai','human_operator','system','bot','internal')`
**Problem:** `role` conflates two different concepts:
- Who sent this message? (`sender_type`: customer, operator, ai, system)
- What is the message's function? (`message_purpose`: reply, note, escalation, system_event)

A message from a human operator might be a direct reply (visible to customer) or
an internal note (not visible). These require different handling but have the same `role`.

**Action now:** Add `message_purpose VARCHAR(50)` column to messages.
**Migration difficulty (later):** Adding this after millions of messages means classifying
historical messages retroactively — requires ML classification or manual effort.

---

## QUESTION 4: Evolution Roadmap

---

### Phase 1 — Day 1 (Current Frozen Schema: 27 tables)

```
PRIMARY AGGREGATE:  Conversation
ISSUE MODEL:        ticket belongs to conversation (1:1 relaxed to 1:many via project)
OWNERSHIP:          conversations.operator_id (FK to operators)
TAKEOVER:           takeover_sessions (conversation-scoped)
AI SCOPE:           traces per conversation
LEARNING:           document_embeddings per project

WHAT IS CORRECT:
  - messages belong to conversations ✓
  - identities → profiles (channel → customer abstraction) ✓
  - webhook_events for idempotency ✓
  - SLA on tickets ✓

WHAT IS KNOWINGLY IMPERFECT (accept the debt):
  - tickets.conversation_id (not nullable)
  - takeover scoped to conversation, not issue
  - no ticket_id on messages
  - no issue-scoped AI memory
```

**Schema snapshot:**
```
companies → projects → conversations → messages
                    ↓
                  tickets (SLA, status, assignment)
                    ↓
             ticket_events (audit trail)
```

---

### Phase 2 — Milestone 3–5 (Loosen Coupling, ~6 months post Day 1)

**Goal:** Allow one conversation to contain multiple independent issues,
without changing the core conversation model.

**New tables:**
```sql
-- Junction: explicitly models conversation ↔ ticket relationships
conversation_ticket_links (conversation_id, ticket_id, link_type)

-- Participants: now that group conversations ship
conversation_participants (conversation_id, participant_type, identity_id, operator_id, session_role)

-- Internal notes: operator annotations
internal_notes (conversation_id, ticket_id, operator_id, content)
```

**Column additions:**
```sql
-- Scope messages to issues
ALTER TABLE messages ADD COLUMN ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

-- Scope takeover to issue, not just conversation
ALTER TABLE takeover_sessions ADD COLUMN ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
ALTER TABLE conversation_handoffs ADD COLUMN ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

-- Make ticket's conversation link non-mandatory
ALTER TABLE tickets ALTER COLUMN conversation_id DROP NOT NULL;

-- Issue-scoped memory
ALTER TABLE ai_memory ADD COLUMN source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

-- Ticket hierarchy
ALTER TABLE tickets ADD COLUMN parent_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
```

**Schema snapshot:**
```
Conversation ──── conversation_ticket_links ──── Ticket
     │                                              │
  messages (ticket_id optional)              ticket_events
  participants                               SLA columns
  handoffs (ticket_id optional)             takeover_sessions (ticket_id optional)
```

---

### Phase 3 — Milestone 6–8 (Issue-centric views, ~12 months)

**Goal:** Ticket becomes the de facto aggregate root for AI operations.
Conversations are channels. Issues are the work.

**Key changes:**

```sql
-- Issue scoping becomes first-class
-- Rename conceptually: "ticket" = "issue" in the application layer
-- No table rename needed — too expensive. Accept name as legacy.

-- AI inference logs are issue-scoped
CREATE TABLE ai_inference_logs (
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  -- ... rest of columns
);

-- Learning samples are issue-scoped
CREATE TABLE learning_samples (
  source_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  source_conv_id   INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  -- ...
);

-- Multi-conversation issue: one issue spans multiple conversations (cross-channel)
-- e.g., same printer problem discussed in LINE and followed up via email
-- Already supported via conversation_ticket_links from Phase 2
```

**Schema snapshot:**
```
Ticket (Issue) ← PRIMARY AGGREGATE
  ├── linked conversations (via junction)
  │     └── messages (scoped: ticket_id is set for relevant messages)
  ├── participants (operators and customers working on this issue)
  ├── ticket_events (full audit trail)
  ├── takeover_sessions (issue-scoped)
  ├── conversation_handoffs (issue-scoped)
  ├── ai_inference_logs
  └── learning_samples (for AI training)
```

---

### Phase 4 — Milestone 9–10 (Enterprise Platform, ~24 months)

**Goal:** Full enterprise architecture — cross-channel issues, organizational hierarchy,
multi-workspace, AI that truly understands issue patterns across customers.

**New tables:**
```sql
-- Issue templates (standard responses for issue types)
CREATE TABLE issue_templates (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  issue_type VARCHAR(100) NOT NULL,  -- 'hardware_failure','login_issue','billing'
  template_name VARCHAR(255) NOT NULL,
  suggested_sla_hours INTEGER,
  default_priority VARCHAR(20),
  routing_rule_id INTEGER REFERENCES project_routing_rules(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Organization hierarchy (Company → Division → Team → Project)
CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name VARCHAR(255) NOT NULL,
  parent_team_id INTEGER REFERENCES teams(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Cross-company issue clusters (enterprise: one issue affects multiple companies)
CREATE TABLE issue_clusters (
  id INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  cluster_type VARCHAR(50),  -- 'outage','security','bug'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tickets ADD COLUMN cluster_id INTEGER REFERENCES issue_clusters(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN template_id INTEGER REFERENCES issue_templates(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;

-- AI long-term learning by issue pattern
CREATE TABLE issue_pattern_memory (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  issue_type VARCHAR(100) NOT NULL,
  pattern_embedding VECTOR(1536),
  resolution_strategy TEXT,
  success_rate NUMERIC(4,3),
  sample_count INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Final schema:**
```
Organization (Company → Team → Project)
    │
    ├── Operators (RBAC per team and project)
    │
    └── Channels (project_channels per project)
          │
          ├── Conversations (channel threads)
          │     └── Messages (content)
          │
          └── Issues/Tickets (work units) ← PRIMARY AGGREGATE
                ├── SLA + Priority + Assignment
                ├── Participants (operators + customers)
                ├── AI inference history
                ├── Human takeover history
                ├── Related knowledge documents
                └── Learning samples (for AI training)
```

---

## QUESTION 5: Every Hidden Coupling in the Current Schema

---

### Coupling 1: Conversation ↔ Issue (MOST CRITICAL)

**The problem:** `tickets.conversation_id` means a ticket cannot exist without a conversation,
and implicitly means one ticket per conversation origin.

**What the business actually needs:** A ticket (issue) can:
- Be created from a conversation ✓
- Be created from an email with no LINE conversation
- Be created by an operator manually (no conversation at all)
- Span multiple conversations (same problem, different channels)

**The coupling hides this:** Every ticket in the current schema has `conversation_id` (planned NOT NULL).
This means all future channels must create a conversation record just to satisfy this FK,
even if the channel has no concept of "conversation" (e.g., a batch-imported issue from Jira).

**Fix:** Make nullable + add junction table.

---

### Coupling 2: Identity ↔ Customer (DEEP PHILOSOPHICAL PROBLEM)

**The problem:** The current model assumes:
```
1 real person = 1 profile = multiple identities (LINE ID, email, phone)
```

**What reality looks like:**
- A company LINE account shared by 3 employees → 1 LINE identity, 3 real people
- A customer changes phone numbers → 2 WA identities, 1 real person
- A corporate email used by rotating staff → 1 email identity, N real people

The current schema cannot represent "identity belongs to an organization, not a person."
It cannot represent "two identities were merged (and that merge should be reversible)."
It cannot represent "this identity is suspicious — possibly same person as identity X."

**Future cost:** If the platform adds "Identity Merge" or "Corporate Account" features,
the current `profiles ← identities` model will require a complete redesign of the
customer identity layer.

**Fix now:** Add `is_shared_account BOOLEAN` to identities. Add `merged_into_profile_id` to profiles.

---

### Coupling 3: Ticket ↔ Issue (NAMING PROBLEM WITH STRUCTURAL CONSEQUENCE)

**The problem:** "Ticket" in helpdesk tradition = the work item sent to a support team.
"Issue" in project management = any problem that needs to be tracked.

In this system, "ticket" is used to mean "issue" — a problem that the AI identifies and tracks.
But Plane.io sync (`plane_issue_id` column) uses "issue" terminology.
The AI tool is called `create_ticket` but what it creates is conceptually an issue.

**The coupling:** If a customer has a billing question (Issue type A) and a technical problem
(Issue type B), the system currently creates two tickets. But if these are both "issues"
on the same "account," they should be related. The ticket model doesn't have
`issue_type` classification that would enable pattern learning.

**Fix:** Add `issue_category VARCHAR(100)` to tickets. This enables issue pattern analytics
without a schema change.

---

### Coupling 4: Project ↔ Workspace

**The problem:** `projects` is a 2-level hierarchy: Company → Project.

Enterprise reality:
```
Organization
  └── Division (Sales, Engineering, Support)
        └── Team (Tier 1 Support, Tier 2 Support)
              └── Project (LINE Bot, WebChat Widget, Email)
```

The current schema has no "division" or "team" level. When an enterprise customer
wants Tier 1 and Tier 2 support as separate entities with separate SLAs and operator
pools, the only option is to create two "projects" — which works, but loses the
organizational hierarchy.

**Future cost:** Adding a "team" or "division" level after production requires:
- New table
- Backfill of existing data (what team does each project belong to?)
- Update of all project-level queries to be team-aware
- API changes

**Fix now:** Add `team_id INTEGER REFERENCES teams(id)` as nullable to projects.
Add an empty `teams` table with `(id, company_id, name, parent_team_id)`.
This costs 1 table and 1 nullable column. Unlocks organizational hierarchy forever.

---

### Coupling 5: Participants ↔ Conversation (NOT ↔ Issue)

**The problem:** `conversation_participants` (planned for M3) will track who is
in a conversation. But when a human operator is assigned to a ticket, they become
a participant in the issue — not just the conversation.

An operator might participate in the issue without being in the conversation thread.
For example, a Tier 2 engineer is assigned to investigate a printer problem, but
all customer communication still happens in the Tier 1 conversation.

**The coupling:** If participants are scoped to conversations, there is no way to
model "who is working on this issue" independently of "who is in the chat."

**Fix:** When `conversation_participants` ships in M3, include both `conversation_id`
(nullable) and `ticket_id` (nullable) — so a participant can belong to either or both.

---

### Coupling 6: messages.role mixes sender and context

**The problem:**
```sql
role CHECK (role IN ('customer','ai','human_operator','system','bot','internal'))
```

`role` mixes:
- **Sender type:** who physically sent this (customer, operator, ai, system)
- **Message context:** what kind of message this is (reply, internal note, system event)

An operator sending an internal note and an operator sending a customer reply
have the same `role = 'human_operator'` but completely different semantics.

**The future cost:** AI training on message history will have to infer message
context from `is_visible_to_customer` flag rather than explicit type.
Analytics ("how many operator replies vs internal notes?") require a flag join.

**Fix now:** Add `message_purpose VARCHAR(50) CHECK (IN ('reply','internal_note','system_event','escalation_note','ai_reasoning'))` to messages.

---

### Coupling 7: SLA ↔ Ticket (Orphaned if Issue Changes)

**The problem:** SLA columns live on `tickets`:
- `sla_response_due_at`
- `sla_resolve_due_at`
- `sla_breached`

If the ticket is closed and a NEW ticket is created for the same issue (e.g., "printer
broken" is marked resolved but reopens 1 hour later), the SLA clock resets.
There is no way to track "cumulative SLA exposure" across ticket reopen cycles.

**Fix:** Add `total_sla_exposure_minutes INTEGER` to tickets — accumulated time
across all open/reopen cycles.

---

### Coupling 8: Webhook ↔ Project (Missing company scope)

**The problem:** `webhook_events.project_id` is nullable. If a webhook arrives
before the project is identified (e.g., invalid channel config), the webhook has
no project scope. In a multi-tenant system, unscoped webhooks are a security risk.

**Fix:** Add `company_id` to `webhook_events` and make one of the two NOT NULL.

---

## QUESTION 6: What to Change Before First Production Deployment

These are the decisions that become exponentially expensive after real data exists.
Ordered by impact:

### CHANGE 1: Make `tickets.conversation_id` nullable
**Cost now:** 10 seconds.
**Cost in 6 months with 50,000 tickets:** Table lock risk + full application audit.
**Action:**
```sql
ALTER TABLE tickets ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE tickets ALTER COLUMN conversation_id SET DEFAULT NULL;
```

### CHANGE 2: Add `ticket_id` (nullable) to `messages`
**Cost now:** 30 seconds + index build (fast on empty table).
**Cost in 6 months with 10M messages:** Hours of index build time.
**Action:**
```sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
CREATE INDEX idx_messages_ticket ON messages(ticket_id) WHERE ticket_id IS NOT NULL;
```

### CHANGE 3: Add `message_purpose` to `messages`
**Cost now:** 30 seconds.
**Cost after 10M messages:** Cannot retroactively classify without AI.
**Action:**
```sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_purpose VARCHAR(50) NOT NULL DEFAULT 'reply'
  CHECK (message_purpose IN (
    'reply',          -- standard reply visible to customer
    'internal_note',  -- not visible to customer
    'system_event',   -- automated system notification
    'ai_reasoning',   -- AI thinking/working message
    'escalation_note' -- note during escalation
  ));
```

### CHANGE 4: Add `conversation_ticket_links` table
**Cost now:** 1 table creation.
**Cost later:** Requires data backfill from `tickets.conversation_id` + application changes.
**Action:**
```sql
CREATE TABLE conversation_ticket_links (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  link_type       VARCHAR(50) NOT NULL DEFAULT 'primary'
                  CHECK (link_type IN ('primary','related','escalated_from','merged_from')),
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by       VARCHAR(50) NOT NULL DEFAULT 'system',
  PRIMARY KEY (conversation_id, ticket_id)
);
-- Seed from existing tickets
INSERT INTO conversation_ticket_links (conversation_id, ticket_id, link_type)
SELECT conversation_id, id, 'primary'
FROM tickets
WHERE conversation_id IS NOT NULL
ON CONFLICT DO NOTHING;
```

### CHANGE 5: Add `ticket_id` (nullable) to `takeover_sessions` and `conversation_handoffs`
**Cost now:** 2 nullable columns.
**Cost later:** Historical handoff data has no issue scope — analytics fail.
```sql
ALTER TABLE takeover_sessions
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

ALTER TABLE conversation_handoffs
  ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
```

### CHANGE 6: Add `teams` table (empty) and nullable `team_id` to projects
**Cost now:** 1 empty table + 1 nullable column.
**Cost later:** Full organizational hierarchy migration.
```sql
CREATE TABLE IF NOT EXISTS teams (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  parent_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  status         VARCHAR(50) NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS primary_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;
```

### CHANGE 7: Add `issue_category` to tickets
**Cost now:** 1 nullable column.
**Cost later:** Cannot retroactively categorize 500,000 tickets without ML.
```sql
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS issue_category VARCHAR(100),   -- 'hardware','software','billing','access'
  ADD COLUMN IF NOT EXISTS parent_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS total_sla_exposure_minutes INTEGER NOT NULL DEFAULT 0;
```

### CHANGE 8: Add `is_shared_account` to identities + `merged_into_profile_id` to profiles
**Cost now:** 2 nullable/boolean columns.
**Cost later:** Identity merge feature requires retroactive data decisions.
```sql
ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS is_shared_account BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS account_type VARCHAR(50) NOT NULL DEFAULT 'individual'
    CHECK (account_type IN ('individual','corporate','bot','internal'));

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS merged_into_profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
```

### CHANGE 9: Establish the canonical FK direction in documentation

Write the following as an architecture decision record (ADR) before any new code:

```
ADR-001: Aggregate Ownership
  - Ticket/Issue is the PRIMARY aggregate root for work items
  - Conversation is a communication channel that LINKS to tickets
  - The FK direction is: conversation_ticket_links (junction)
  - No new table should have conversation_id as its primary business FK
    without also having ticket_id
  - Exception: messages (messages belong to a conversation thread by definition)

ADR-002: Message Purpose
  - All operator messages MUST set message_purpose
  - Default is 'reply' (visible to customer)
  - Internal notes MUST use message_purpose='internal_note' AND is_visible_to_customer=FALSE
  - system_event messages are written by automation only

ADR-003: Ticket Independence
  - A ticket MUST be able to exist without a conversation
  - A ticket CAN link to multiple conversations
  - conversation_ticket_links is the canonical join table
```

---

## FINAL RECOMMENDATION: Revised Day 1 Frozen Schema

Add these to the Day 1 schema (post-triage):

```
ALREADY IN SCHEMA (27 tables from SCHEMA_TRIAGE.md + customer_enrollments):
  [no changes]

ADD BEFORE FIRST WEBHOOK:
  + conversation_ticket_links   (1 table — enables issue-centric evolution)
  + teams                       (1 empty table — enables org hierarchy)

COLUMN ADDITIONS (not tables):
  + messages.ticket_id          (nullable)
  + messages.message_purpose    (not null, default 'reply')
  + tickets.parent_ticket_id    (nullable, self-referential)
  + tickets.issue_category      (nullable)
  + tickets.total_sla_exposure  (not null, default 0)
  + tickets.conversation_id → DROP NOT NULL
  + takeover_sessions.ticket_id (nullable)
  + conversation_handoffs.ticket_id (nullable)
  + identities.is_shared_account (not null, default false)
  + identities.account_type     (not null, default 'individual')
  + profiles.merged_into_profile_id (nullable)
  + projects.team_id            (nullable)
  + operators.primary_team_id   (nullable)

FINAL DAY 1 TABLE COUNT: 29 tables
```

---

## MIGRATION RISK MATRIX

| Decision | Cost If Done Today | Cost If Done at 1M Rows | Cost If Done at 10M Rows |
|----------|-------------------|------------------------|-------------------------|
| tickets.conversation_id nullable | 1 ALTER | Table lock risk | Hours + downtime risk |
| messages.ticket_id | 1 ALTER + index | Hours (index) | Days + careful migration |
| messages.message_purpose | 1 ALTER | Cannot backfill accurately | Cannot backfill at all |
| conversation_ticket_links | 1 CREATE | 1 CREATE + backfill script | 1 CREATE + migration job |
| teams table + projects.team_id | 2 operations | Backfill required | Complex backfill + org decision |
| identities.account_type | 1 ALTER | Hard to backfill accurately | Impossible without ML |
| Profile merge columns | 2 ALTER | Easy | Hard (must audit merged identities) |

---

## CLOSING STATEMENT

This platform will either be Conversation-centric forever, or it will undergo
a painful architectural migration in Milestone 6 when the multi-issue-per-conversation
requirement becomes real.

The decisions listed in Question 6 cost a combined total of approximately
3–4 hours of engineering time today.

After production data exists, the same decisions will cost 2–4 weeks of careful
migration engineering, with downtime risk, and the permanent loss of historical
data accuracy for any column that requires retroactive backfill.

The database is the part of the system that cannot be refactored with a pull request.

Every column added today is $10.
Every column added at 1M rows is $10,000.
Every column never added because "we'll do it later" is an architectural debt
that compounds interest indefinitely.

---

*Architecture review completed: 2026-07-21*
*Horizon: 10 years*
*Final Day 1 table count: 29 tables*
*Critical pre-production changes: 9*
*Schema freeze status: READY after applying recommendations*
