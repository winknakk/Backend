# Schema Philosophy Debate
## Three Disputed Tables — Principal Architect Challenge

```
Classification : ARCHITECTURE DEBATE — Principal Architect Challenge
Date           : 2026-07-21
Format         : Challenge every assumption. Do NOT optimize for agreement.
Basis          : Day 1 schema triage (SCHEMA_TRIAGE.md)
```

---

## The Core Tension

Before addressing each table, the design philosophy question must be answered first —
because the answer dictates all three verdicts.

---

## DESIGN PHILOSOPHY: Which is correct for an Enterprise AI Platform?

```
Option A: Database follows Runtime
  Create tables only when code needs them.

Option B: Database follows Domain
  Core domain entities exist before runtime uses them.
```

**The question is wrong. Both options, stated this way, are incorrect.**

The correct principle for a 5-year enterprise AI platform is:

> **Database follows Domain Aggregate Boundaries.
> Supporting tables follow Runtime.**

This is the DDD (Domain-Driven Design) distinction between:

- **Aggregate roots and their immediate collections** — these define domain boundaries.
  They should exist before runtime uses them, because adding them later requires
  reconceptualizing the domain, not just adding a table.

- **Supporting bounded contexts** — these are tables that serve a specific
  operational context. They can be deferred without changing the domain model.

Concretely:

| Type | Example | Strategy |
|------|---------|---------|
| Aggregate root | `conversations` | Always Day 1 |
| Aggregate collection | `conversation_participants` | Day 1 if it defines the boundary |
| Supporting table | `message_media_analysis` | Defer until the bounded context exists |
| Derived projection | `profile_projects` | Depends on whether it IS the model or derives from it |

With this framework, each table must be evaluated differently.

---

## TABLE 1: `conversation_participants`

### The Recommendation to Defer Was Wrong.

**The original reasoning was:**
> No GROUP conversation on Day 1 → defer.

**This reasoning commits a category error.**

`conversation_participants` was framed as a "GROUP conversation feature table."
This is incorrect. It is the **Conversation aggregate's participant collection**.

Every conversation already has participants. A direct LINE conversation between one
customer and one AI has exactly one customer participant and one AI participant.
The concept exists on Day 1 — what changes in Milestone 3 is the *cardinality*, not
the concept.

Deferring `conversation_participants` is equivalent to deferring `order_items` from
an e-commerce schema because "bundles are not Day 1." The fact that orders today
have one item does not mean the concept of order items is a Milestone 3 feature.

---

### Runtime Justification

**Against the user's position:**

On Day 1, no service writes to `conversation_participants`. The current runtime
resolves participants implicitly from `conversations.identity_id`. No API endpoint
calls `getConversationParticipants()`. No UI renders a participant list.

If runtime ownership is the test, the table fails it on Day 1.

**For the user's position:**

However, this test is the wrong test for a table that defines an aggregate boundary.

The moment TakeoverManager claims a conversation, it creates an operator participant.
The moment a conversation is created from a webhook, it creates a customer participant.
These are participant events — they currently write to `conversations.identity_id`
and `conversations.operator_id` because the correct table does not exist.

The data is being stored in the wrong place today because the correct table does not exist.

---

### Domain Justification

The `conversation` entity in this system is not a bilateral exchange between one
customer and one AI. It is designed as:

```
AutomationX → ConversationResolver → IssueSessionManager → AgentRuntime → PromptX
```

The IssueSession is not a future feature. It is the core architectural pattern.
The conversation is the container; the session is the context; the participants
are the actors.

If IssueSession is a core domain concept on Day 1, then `conversation_participants`
is a core domain table on Day 1 — even if the IssueSession has only one participant.

**The question is not "are there multiple participants on Day 1?"
The question is "is participant a first-class concept in this domain?"**

The answer is yes. The architecture diagram proves it.

---

### Challenge to the User's Position

The user argues that IssueSession is core domain and therefore
`conversation_participants` should be Day 1. This argument is correct but
the conclusion may be underspecified.

**If IssueSession is core domain, then `conversation_participants` as a
simple junction table is wrong.**

The current design:
```sql
conversation_participants (
  conversation_id, identity_id, operator_id, participant_type,
  role, joined_at, left_at, is_active
)
```

This table answers: "who is in this conversation?"

But IssueSession needs to answer:
- "Who is the issue owner?"
- "Who is the customer reporter?"
- "Who are the collaborators?"
- "What is this participant's contribution type?"
- "When did this participant's active involvement begin and end?"

A simple junction table does not capture this. If the table ships as a simple
junction on Day 1, it will be redesigned when IssueSession ships.

**The cost of adding it later as a simple table is low.
The cost of redesigning it after data exists is high.**

Therefore: keep `conversation_participants`, but design it correctly now
for IssueSession, not just for group conversations.

---

### Future Migration Cost

| Scenario | Cost |
|----------|------|
| Add as simple table on Day 1, redesign for IssueSession later | HIGH — data migration required, FKs must be rebuilt |
| Add correctly designed for IssueSession on Day 1 | ZERO — already correct |
| Defer to M3, add correctly designed then | LOW — purely additive, no existing data depends on it |

---

### Risk of Adding Later

**Low-to-Medium.**

The table is purely additive. No existing data depends on it.
However, every conversation created before M3 will not have participant records,
meaning IssueSession queries like "show me all conversations where this customer
participated" will return incomplete results for historical data.

This is an acceptable tradeoff IF you are willing to backfill participant records
for existing conversations during the M3 migration. This is feasible but
requires a one-time script.

---

### Risk of Adding Now

**Very low — IF designed correctly.**

If the table is added as a simple junction, it will be wrong.
If designed for IssueSession from Day 1, the risk is only
that IssueSession domain model changes slightly before M3.

---

### VERDICT: **KEEP — but redesign for IssueSession domain**

```sql
CREATE TABLE conversation_participants (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Who is this participant?
  participant_type VARCHAR(50) NOT NULL DEFAULT 'customer'
                   CHECK (participant_type IN (
                     'customer',          -- end customer
                     'operator',          -- human agent / PM
                     'ai',                -- AI agent
                     'observer',          -- read-only watcher
                     'collaborator'       -- invited internal stakeholder
                   )),
  identity_id      INTEGER REFERENCES identities(id) ON DELETE SET NULL,   -- for customer
  operator_id      INTEGER REFERENCES operators(id) ON DELETE SET NULL,    -- for operator

  -- IssueSession role
  session_role     VARCHAR(50) NOT NULL DEFAULT 'member'
                   CHECK (session_role IN (
                     'reporter',          -- customer who opened the issue
                     'owner',             -- operator responsible for resolution
                     'collaborator',      -- additional contributor
                     'observer',          -- read-only
                     'ai_handler'         -- AI currently handling
                   )),

  -- Participation timeline
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at          TIMESTAMPTZ,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,

  -- How did this participant enter?
  join_source      VARCHAR(50) DEFAULT 'direct'
                   CHECK (join_source IN (
                     'direct',            -- opened the conversation
                     'invited',           -- added by operator
                     'webhook',           -- joined from channel event
                     'escalation',        -- added during escalation
                     'system'             -- added by system/AI
                   )),

  -- Constraint: a participant is either an identity or an operator, not both
  CONSTRAINT participant_has_one_owner
    CHECK (
      (identity_id IS NOT NULL AND operator_id IS NULL) OR
      (operator_id IS NOT NULL AND identity_id IS NULL) OR
      (participant_type = 'ai')   -- AI has no FK
    ),

  UNIQUE (conversation_id, identity_id),
  UNIQUE (conversation_id, operator_id)
);

CREATE INDEX idx_participants_conv
  ON conversation_participants(conversation_id, is_active);

CREATE INDEX idx_participants_operator
  ON conversation_participants(operator_id)
  WHERE operator_id IS NOT NULL;
```

**Backfill note:** When 015 runs, seed one participant per existing conversation
from `conversations.identity_id` with `session_role='reporter'`.

---

## TABLE 2: `message_media_analysis`

### The Recommendation to Defer Was Correct.

**The user's argument:**

> "Would it be architecturally cleaner to create `message_media_analysis` from Day 1,
> even if no worker writes to it yet? Stable domain boundaries over current runtime."

**This argument conflates two different things:**

1. Domain boundary stability — does the domain concept exist on Day 1?
2. Table existence — must the table exist to define the boundary?

**The domain concept exists on Day 1. The table does not need to.**

---

### The Domain Boundary Argument Does Not Apply Here

`message_media_analysis` is not an aggregate root. It is not a collection of a
core aggregate. It is a **result projection** from a specialized processing
pipeline that does not exist yet.

Contrast this with `conversation_participants`:

| Table | Type | Domain boundary? |
|-------|------|-----------------|
| `conversation_participants` | Aggregate collection of Conversation | YES |
| `message_media_analysis` | Result projection of MediaAnalysis pipeline | NO |

The MediaAnalysis bounded context — the pipeline that performs OCR, Vision,
transcription, and classification — does not exist on Day 1. The concept of
"a message attachment has been analyzed" cannot occur without the analyzer.

**Creating an empty analysis results table before an analyzer exists is not
defining a domain boundary. It is pre-allocating infrastructure for a feature
that is not in scope.**

---

### The Specific Risk of Adding Now

An empty `message_media_analysis` table on Day 1 creates a **contract without
an implementation.**

Every future engineer who joins the team will see this table and ask:
- "Why is this empty?"
- "Should my code be writing to it?"
- "Is something broken?"

An empty table in a production database is not a domain statement. It is
technical debt that manifests as confusion.

**Worse: the schema may be wrong.**

You do not know today what analysis types will be required for Milestone 4.
You do not know whether the result will be stored as text, JSONB, or vector.
You do not know whether the table should be per-attachment or per-message.
You do not know whether Vision and OCR results should be in the same table
or separated by analysis type.

Creating the table today locks in a design for a feature you have not designed.

---

### Risk of Adding Later

**Extremely low.** This is a purely additive table. No existing FK references it.
No existing data must be migrated into it. Adding it in migration 016 or 018 is
a 20-line SQL file.

The only non-zero risk: **backfilling.** Existing attachments from Day 1 through M4
will not have analysis results. This is acceptable because:
1. Analysis can be triggered retroactively by the worker when it ships
2. `message_attachments.storage_key` preserves the file — analysis can happen
   at any future time as long as the file is stored

---

### The User's Position Has One Valid Point

The user is correct that `message_attachments` should NOT absorb OCR/Vision columns.
Adding `ocr_text`, `vision_description`, `transcript` columns to `message_attachments`
would be the wrong design and would be expensive to undo.

**The correct response to this concern is NOT to create `message_media_analysis` now.**

The correct response is to add a constraint:

> **Policy:** Never add OCR, Vision, or analysis columns to `message_attachments`.
> When the MediaAnalysis pipeline ships, it MUST write to `message_media_analysis`.

This policy can be documented in the migration comments and the architecture decision record.
The table boundary is preserved without creating an empty ghost table.

---

### VERDICT: **DEFER — Document the policy, do not create the table**

```
Defer to migration 018.
Document: "message_attachments MUST NOT receive analysis columns."
Preserve: message_attachments.storage_key ensures files are available for future analysis.
Backfill: MediaAnalysis worker triggers analysis for all attachments on first run.
```

---

## TABLE 3: `profile_projects`

### The Recommendation Was Incomplete — Not Wrong.

**The user's argument:**

> "One LINE account talks to Project A and Project B.
> Without profile_projects, the profile-project relationship is derived
> from conversations, not explicitly modeled."

**This argument is correct. But it leads to the wrong conclusion.**

---

### The Current `profile_projects` Table Is Architecturally Incorrect

The `profile_projects` table was inherited from the NoCoDB import. It is a
raw junction table with no semantic meaning:

```sql
-- What exists today (from nocodb migration):
profile_projects (profile_id, project_id, ...)
```

This table answers: "has this profile ever appeared in this project?"

But it does not answer:
- "Was the customer formally enrolled in this project?"
- "Did they opt in to communications from this project?"
- "What is their relationship to this project — customer, tester, internal?"
- "When did the relationship begin and was it from a conversation or an explicit enrollment?"

**A junction table without semantic meaning is not a domain model.
It is a query convenience.**

The user's intuition is correct: the relationship should be explicit.
The implementation is wrong: a raw junction table is not the right way to model it.

---

### What the Domain Actually Requires

In a multi-project platform where one customer (same LINE account) can
interact with Project A (tech support) and Project B (billing), the domain
needs to answer:

1. "Show me all conversations for this profile across all projects." → answered by joining `conversations`
2. "Is this profile enrolled in Project B?" → requires an explicit enrollment record
3. "When did this profile first contact Project B?" → can be derived from first conversation

Question 1 and 3 are derivable from `conversations`. They do not require `profile_projects`.

Question 2 — "Is this profile enrolled?" — requires explicit modeling **only if enrollment
is a formal domain event.** In the current architecture, there is no enrollment concept.
A profile "belongs" to a project the moment they send their first message.

**If enrollment is not a domain event, `profile_projects` is a derived materialized view,
not a domain table.**

---

### The Risk of the Current Implicit Model

The user's concern is valid: **if profiles are bound to projects through conversations,
there is no way to model:**

- A customer who is known to the platform (via import) but has not yet messaged
- A customer who should receive proactive messages from Project B but hasn't initiated contact
- Cross-project customer identity resolution ("are these two profiles the same person?")

These are real future requirements. The current implicit model cannot support them.

**However,** a raw `profile_projects` junction does not solve these requirements either.
What is needed is a `customer_enrollments` or `profile_project_memberships` table
with explicit enrollment semantics.

---

### Runtime Justification

**Against keeping profile_projects:**

No service reads from `profile_projects` today. No API returns "projects for this profile."
No AgentRuntime uses it for context. It is an artifact of the NoCoDB import.

**For keeping a redesigned version:**

When Admin UI ships cross-project inbox features, when PromptX needs cross-project
customer context ("this customer also reported an issue in Project B"), when proactive
messaging is implemented — all of these require an explicit profile-project relationship.

The question is not IF this table will be needed. It is WHEN.

---

### Future Migration Cost

| Scenario | Cost |
|----------|------|
| Keep raw `profile_projects` junction as-is | LOW cost today, HIGH cost when semantics are added |
| Remove and add `customer_enrollments` later | LOW cost — additive migration, conversations fill gap |
| Add `customer_enrollments` now, designed correctly | ZERO future migration cost |

---

### VERDICT: **KEEP — but redesign as `customer_enrollments`, not a raw junction**

The concept is correct. The implementation must change.

```sql
CREATE TABLE customer_enrollments (
  id              SERIAL PRIMARY KEY,
  profile_id      INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- How did this enrollment happen?
  enrollment_source VARCHAR(50) NOT NULL DEFAULT 'first_contact'
                    CHECK (enrollment_source IN (
                      'first_contact',      -- first message from this profile
                      'imported',           -- bulk import
                      'invited',            -- operator invitation
                      'proactive',          -- platform-initiated
                      'api'                 -- external API enrollment
                    )),

  -- What is the relationship type?
  enrollment_type VARCHAR(50) NOT NULL DEFAULT 'customer'
                  CHECK (enrollment_type IN (
                    'customer',    -- standard customer
                    'vip',         -- flagged for priority handling
                    'internal',    -- employee / internal tester
                    'blocked'      -- blocked from this project
                  )),

  -- When
  first_contact_at  TIMESTAMPTZ,      -- first message timestamp (backfilled from conversations)
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enrolled_by       INTEGER REFERENCES operators(id) ON DELETE SET NULL,

  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  notes             TEXT,

  UNIQUE (profile_id, project_id)
);

CREATE INDEX idx_enrollments_profile ON customer_enrollments(profile_id);
CREATE INDEX idx_enrollments_project ON customer_enrollments(project_id, enrollment_type);
```

**Backfill on migration run:**
```sql
-- Seed enrollment from existing conversations (automatic Day 1 data)
INSERT INTO customer_enrollments (profile_id, project_id, company_id, enrollment_source, first_contact_at)
SELECT DISTINCT
  pr.id,
  c.project_id,
  p.company_id,
  'first_contact',
  MIN(c.created_at)
FROM conversations c
JOIN identities i ON i.id = c.identity_id
JOIN profiles pr ON pr.id = i.profile_id
JOIN projects p ON p.id = c.project_id
GROUP BY pr.id, c.project_id, p.company_id
ON CONFLICT (profile_id, project_id) DO NOTHING;
```

---

## FINAL SCORECARD

| Table | Original Verdict | Challenge Verdict | Reason |
|-------|-----------------|------------------|--------|
| `conversation_participants` | DEFER M3 | **KEEP — redesign for IssueSession** | Core aggregate collection, not a feature table |
| `message_media_analysis` | DEFER M4 | **DEFER M4 — same conclusion, different reasoning** | Not a domain boundary; risk of wrong design; additive later |
| `profile_projects` | AUDIT/DEFER | **KEEP — redesign as `customer_enrollments`** | Right concept, wrong implementation |

---

## FINAL TABLE COUNT

```
Original Day 1 schema:  26 tables
+ conversation_participants (redesigned):  +1
+ customer_enrollments (replacing profile_projects):  +1
─────────────────────────────────────────────────────
Day 1 Frozen Schema:  28 tables
```

`message_media_analysis` remains deferred.
`profile_projects` is replaced by `customer_enrollments`.

---

## ON THE DESIGN PHILOSOPHY

Neither Option A nor Option B is universally correct.

The correct principle is:

> **Core aggregate boundaries and their immediate collections must be established
> before the first domain event occurs.**
>
> **Supporting operational tables must be established before the first operational
> event occurs that writes to them.**
>
> **Everything else should be deferred.**

Applied to this schema:

| Category | Rule | Examples |
|----------|------|---------|
| Core aggregate | Day 1, always | `conversations`, `messages`, `tickets` |
| Aggregate collection | Day 1 if concept exists | `conversation_participants`, `customer_enrollments` |
| Operational infrastructure | Day 1 if runtime writes to it | `webhook_events`, `traces`, `outbox_events` |
| Supporting context | When the context ships | `message_media_analysis`, `ai_memory`, `domain_events` |
| Derived projections | When the consumer ships | `ai_inference_logs`, `ticket_embeddings` |

The difference between this platform and a simple chatbot is that this platform
is designed around **Issue Sessions as the core domain concept**, not messages.

If that is true — and the architecture diagram confirms it — then the schema
must reflect the Issue Session domain from Day 1, not from Milestone 3.

`conversation_participants` is not a GROUP chat feature.
It is the participant model of the Issue Session aggregate.

That is why it belongs in the Day 1 schema.

---

## WHAT THIS MEANS FOR MIGRATION 015

Migration 015 (revised) should include:

```
ADDITIONS vs previous SCHEMA_TRIAGE.md:
  + conversation_participants (redesigned for IssueSession)
  + customer_enrollments (replacing profile_projects)

UNCHANGED DEFERRALS:
  - message_media_analysis remains DEFER M4
  - domain_events remains DEFER M2
  - ai_thinking_traces remains DEFER M2
  - ai_inference_logs remains DEFER M2/M5
  - learning_samples remains DEFER M6+

FINAL DAY 1 TABLE COUNT: 28 tables
```

---

## THE ONE AREA WHERE THE TRIAGE WAS TOO AGGRESSIVE

In addition to the three disputed tables, there is one other deferral that
deserves reconsideration.

`operator_project_access` was deferred because "RBAC enforcement code doesn't exist."

But: if `customer_enrollments` exists to model "which customers belong to which project,"
then `operator_project_access` must also exist to model "which operators can access which project."

These are symmetric concepts in the same domain: **Project Membership**.

If one is Day 1, both should be Day 1.

This adds one more table, bringing the final count to **29 tables** —
but only if the engineering team commits to implementing project-scoped
API middleware before go-live. If middleware is not shipped,
`operator_project_access` remains an empty governance table with no enforcer,
which is the same problem as `message_media_analysis`.

**Recommendation:** Include `operator_project_access` in Day 1 only if the JWT
middleware that reads from it will be deployed on the same day.
Otherwise defer it and accept the security gap until M2.

---

*Architecture debate completed: 2026-07-21*
*Final Day 1 schema: 28 tables (29 with operator_project_access if RBAC ships Day 1)*
*Frozen schema version: v3 — Post-Triage-Debate*
