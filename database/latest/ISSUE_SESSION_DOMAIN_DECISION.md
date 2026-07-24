# IssueSession — Domain Clarification
## Runtime Context vs Database Entity

```
Classification : DOMAIN MODELING DECISION
Date           : 2026-07-21
Context        : Response to user challenge on IssueSession architecture
Outcome        : Revises conversation_participants verdict + clarifies domain model
```

---

## The Honest Answer

The user is correct on all three counts.

1. **IssueSession should be a Runtime Context, not a database entity.**
2. **conversation_participants was defended with the wrong reasoning.**
3. **The existing Conversation → Ticket model already covers "multiple issues per conversation."**

This document explains where the previous reasoning went wrong and what the
correct domain model is.

---

## Where the Previous Reasoning Was Wrong

The argument in `SCHEMA_PHILOSOPHY_DEBATE.md` was:

> "conversation_participants is the aggregate collection of the IssueSession aggregate.
> It belongs on Day 1 because aggregate collections define domain boundaries."

This argument committed a foundational error:

It assumed IssueSession was a **database aggregate root** — a persistent entity
around which participant membership is tracked.

If IssueSession is actually a **runtime context object** (built fresh from the
database on each message and discarded after the agent responds), then the entire
"aggregate collection" argument collapses.

There is no aggregate root to be a collection of.

---

## Answering the User's Three Questions

### Q1: Is IssueSession = Ticket?

**No. But the difference is runtime vs. persistence — not conceptual.**

| Dimension | IssueSession | Ticket |
|-----------|-------------|--------|
| Lifetime | Milliseconds — one agent turn | Days or weeks |
| Storage | In-memory object | PostgreSQL row |
| Purpose | Working context for AgentX | Work record with SLA, status, history |
| Created by | ConversationResolver on each message | AgentX MCP tool (create_ticket) |
| Contents | Conversation + profile + messages + ticket + memories + settings | Subject + status + priority + assignment |

**IssueSession is the runtime hydration of the problem context.**
**Ticket is the persistent record of the problem.**

They are complementary, not duplicates.

The correct model is:

```
LINE Message received
    │
    ▼
ConversationResolver.resolve()
    │
    ├── Load Conversation (from DB)
    ├── Load Profile + Identities (from DB)
    ├── Load Active Ticket (from DB — may be null)
    ├── Load Recent Messages N (from DB)
    ├── Load AIMemory for this profile (from DB)
    ├── Load ProjectAISettings (from DB)
    ├── Load ProjectPrompt (from DB)
    │
    ▼
IssueSession {        ← runtime object, NOT stored
  conversation,
  profile,
  participants,        ← derived from conversation + takeover state
  activeTicket,        ← loaded from tickets WHERE status='Open'
  recentMessages,
  memories,
  agentSettings,
  projectPrompt
}
    │
    ▼
AgentX.handle(session)
    │
    ▼
PromptX.infer(context)
    │
    ▼
Response written to messages (persisted)
IssueSession discarded from memory
```

This is clean, correct, and does not require a `issue_sessions` table.

---

### Q2: Should IssueSession be a database entity?

**Only if the system needs to answer questions that cross agent turns.**

Questions that require a persistent IssueSession:
- "Show me the history of all sessions for this ticket."
- "This session started 3 days ago — what has changed since then?"
- "Resume session from where the previous operator left off."

The current system can already answer all of these through:
- `tickets` — the problem record
- `messages` — the full conversation history
- `conversation_handoffs` — who owned the problem at each point
- `traces` — what the AI did on each turn

**There is no query that requires a `issue_sessions` table that cannot be
answered with the existing schema.**

Therefore: IssueSession does not need a database table.

---

### Q3: Which of the three was the real intention?

Looking at the schema decisions made so far:

- `conversation_handoffs` — tracks AI ↔ Human transitions
- `takeover_sessions` — tracks human takeover periods
- `tickets` — tracks the work item / problem

The architecture already implements **Option 3** (temporal segmentation via handoffs)
**and Option 2** (multiple tickets per conversation) simultaneously.

**Option 1** (participants knowing who is working together) is satisfied at runtime
by loading `conversations.identity_id`, `conversations.operator_id`, and
`conversation_handoffs` into the IssueSession object — without needing a separate
participants table.

The previous argument for `conversation_participants` was solving a problem that
does not exist yet (LINE Group conversations) with a design that was over-specified
for Day 1.

---

## Revised Verdict: `conversation_participants`

**DEFER back to Milestone 3.**

The reasoning:

| Test | Result |
|------|--------|
| Does AgentX need it to build IssueSession on Day 1? | NO — identity and operator are on conversations row |
| Does any Day 1 API return participant lists? | NO |
| Does TakeoverManager need it on Day 1? | NO — it writes to takeover_sessions |
| Is it needed for LINE Group conversations? | YES — but Line Group is M3 |
| Is it needed for collaborative IssueSession? | Only if IssueSession is DB entity — which it is not |

**The table will be needed in M3 when LINE Group ships.**
**Adding it then is a clean, additive, zero-risk migration.**
**Adding it now creates an empty table with no writer and incorrect design assumptions.**

---

## Correct Domain Model — Final

```
CHANNEL LAYER
  identities (channel-specific IDs)
    └── profiles (customer-level identity across channels)
        └── customer_enrollments (profile ↔ project membership)

CONVERSATION LAYER
  conversations (the communication thread — one per channel session)
    ├── messages (all messages in the thread)
    │     └── message_attachments (files, images, audio)
    ├── conversation_events (state transitions)
    ├── conversation_handoffs (AI ↔ Human transitions)
    └── takeover_sessions (human ownership periods)

WORK LAYER
  tickets (the problem / work item)
    └── ticket_events (ticket state history)

RUNTIME LAYER (NOT stored — built from above tables)
  IssueSession {
    conversation: Conversation
    profile: Profile
    participants: [...] ← from conversation.identity_id + operator_id
    activeTicket: Ticket | null
    recentMessages: Message[N]
    memories: AIMemory[]
    agentSettings: ProjectAISettings
    projectPrompt: ProjectPrompt
    slaPolicy: ProjectSLAPolicy
  }
```

The runtime layer is what AgentX receives. It is assembled by ConversationResolver
from the persistence layer. It exists in memory for the duration of one agent turn.

**This is architecturally sound and requires no additional tables.**

---

## Impact on Day 1 Table Count

```
Previous triage count:  26 tables
+ customer_enrollments:  +1 table (reinstated — valid concept, own justification)
- conversation_participants: deferred back to M3

Final Day 1 schema: 27 tables
```

`conversation_participants` is deferred. `customer_enrollments` remains because
the profile-to-project relationship is a valid domain concept independent of IssueSession.

---

## The Deeper Lesson

The error was pattern-matching the term "IssueSession" to DDD aggregate terminology
without asking first: **is this thing stateful across agent turns?**

If an entity's lifecycle is shorter than one HTTP request, it is not a database aggregate.
It is an application object.

The correct question to ask for any proposed table is:

> "What query would fail if this table did not exist?"

For `issue_sessions` (as a table): no query would fail.
For `conversation_participants` before M3: no query would fail.
For `customer_enrollments`: "show me all projects this customer has contacted" would fail
  (or would require a JOIN through conversations that excludes customers with no messages).

`customer_enrollments` passes the test. The other two do not, for Day 1.

---

## Summary of All Schema Decisions After This Debate

| Table | Decision | Reason |
|-------|----------|--------|
| `conversation_participants` | DEFER M3 | IssueSession is runtime; group conv is M3 |
| `message_media_analysis` | DEFER M4 | No worker, no pipeline, wrong to pre-create |
| `customer_enrollments` | KEEP | Explicit profile-project membership, passes query test |
| `issue_sessions` (new) | DO NOT CREATE | Runtime object, not a DB entity |
| `operator_project_access` | DEFER M2 | RBAC middleware not shipped Day 1 |

**Day 1 Frozen Schema: 27 tables**

---

*Decision recorded: 2026-07-21*
*IssueSession = Runtime Context. Confirmed.*
*Database follows domain aggregate boundaries, not runtime objects.*
