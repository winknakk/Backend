# Architecture Decision Records (ADR)
## TicketX / PromptX Platform — Production Database & DDD Specification

```
Classification : ARCHITECTURE DECISION RECORDS (ADR-001 to ADR-006)
Date           : 2026-07-21
Status         : APPROVED & FROZEN
Scope          : TicketX Backend Core, Database Schema & Module Architecture
```

---

## ADR-001: Explicit Bounded Context Isolation

### Context
The platform consists of multiple distinct functional domains including Webhook Ingestion, Messaging, Support Operations, Agentic AI Runtime, Identity & Access, Knowledge Search, and Workflow Automation. Attempting to manage these domains within a monolithic, unified model creates tight coupling, prevents independent scaling, and introduces domain pollution.

### Decision
We formally adopt Domain-Driven Design (DDD) Bounded Contexts. The platform is strictly segregated into 7 independent Bounded Contexts:
1. `Ingestion Context`
2. `Messaging Context`
3. `Support Context`
4. `Identity Context`
5. `Knowledge Context`
6. `Agent AI Context`
7. `Automation Context`

Each Bounded Context maintains its own ubiquitous language, domain models, and service owners.

### Consequences
* Positive: High cohesion within contexts, zero database-level coupling across context boundaries.
* Negative: Requires an explicit Context Mapping Layer to bridge data across context boundaries.

---

## ADR-002: Independent Aggregate Roots per Bounded Context

### Context
Previous schema iterations attempted to declare either `Conversation` or `Ticket` as the single global aggregate root for the entire database. This created an architectural bottleneck: messaging workflows were forced to care about SLA tickets, and ticket management workflows were forced to care about chat threads.

### Decision
We reject the Canonical Enterprise Model anti-pattern. There is **NO global aggregate root**. Each Bounded Context defines its own independent Aggregate Root:
* Messaging Context → `Conversation`
* Support Context → `Ticket`
* Identity Context → `Company` (Tenant) & `Profile` (Customer)
* Knowledge Context → `KnowledgeDocument`
* Ingestion Context → `WebhookEvent`
* Agent AI Context → `AITrace` (Persistence) / `IssueSession` (Runtime)
* Automation Context → `WorkflowExecution`

### Consequences
* Positive: Domain models can evolve independently without breaking other contexts.
* Negative: Cross-context data operations must use scalar references (IDs) rather than direct PostgreSQL `ON DELETE CASCADE` foreign key constraints across context boundaries.

---

## ADR-003: Context Mapping Layer & Integration Model

### Context
With independent Bounded Contexts, the system requires a structured mechanism to associate conversations with tickets and resolve domain data across contexts without introducing direct compile-time or schema-level dependencies.

### Decision
We establish a dedicated **Context Mapping Layer** located at `/src/modules/context-mapping`. 
1. The table `conversation_ticket_links` is designated strictly as an **Integration Link Model** owned by the Context Mapping Layer. It is NOT owned by Messaging Context or Support Context.
2. Context Resolvers (`ConversationResolver`, `TicketResolver`, `ProfileResolver`, `KnowledgeResolver`) act as Anti-Corruption Layers (ACL) to fetch read-only snapshots from upstream contexts.

### Consequences
* Positive: Completely eliminates cross-domain schema pollution.
* Negative: Requires dedicated mapper classes and junction repository maintenance.

---

## ADR-004: Ephemeral In-Memory IssueSession

### Context
AgentX and PromptX require a rich, unified operational context containing chat history, customer profile, active support tickets, knowledge chunks, and memories during an agent reasoning turn. Storing this aggregated object as a persistent database entity (`issue_sessions` table) would create redundant state, synchronization bugs, and heavy I/O overhead.

### Decision
`IssueSession` is explicitly declared as an **ephemeral runtime object**. 
* **NO `issue_sessions` table shall ever be created in the database.**
* `IssueSessionBuilder` constructs the `IssueSession` DTO in RAM immediately prior to executing an AI turn.
* Once the AI turn completes and messages/traces are written, the `IssueSession` object is garbage-collected from RAM.

### Consequences
* Positive: Zero database bloat, zero stale session state bugs, maximum execution speed.
* Negative: Debugging an AI turn requires reading `traces` and `ai_thinking_traces` rather than inspecting a persistent session table.

---

## ADR-005: Dedicated Automation Bounded Context

### Context
Workflow execution, transactional outbox processing, BullMQ job queues, background retries, and external sync workers (e.g., Plane.io sync) were previously mixed inside the AI or Support contexts.

### Decision
We establish a dedicated **Automation Context** (`/src/modules/automation`).
* Aggregate Root: `WorkflowExecution` / `OutboxEvent`.
* Responsibilities: Asynchronous message queuing, transactional outbox reading from `outbox_events`, workflow state management, and external service retry policies.
* The AI Context and Support Context publish side-effects to `outbox_events`, which the Automation Context consumes asynchronously.

### Consequences
* Positive: Isolates background processing and queue failures from real-time API responses.
* Negative: Eventual consistency delay for asynchronous background tasks.

---

## ADR-006: Asynchronous Event-Driven Cross-Context Communication

### Context
Direct synchronous service-to-service calls across Bounded Contexts during incoming webhook processing introduce latency bottlenecks and risk cascading failures.

### Decision
All state transitions that affect downstream contexts MUST be communicated asynchronously via **Domain Events**:
1. Incoming webhooks write to `webhook_events` and emit `webhook.received.v1`.
2. Messaging Context consumes the webhook, writes to `conversations`/`messages`, and emits `conversation.message_received.v1`.
3. Agent AI Context consumes the message event, builds the ephemeral `IssueSession`, executes reasoning, writes to `traces`, and emits `ai.inference_completed.v1`.
4. Support Context consumes inference events or tool calls to update `tickets`.

All events are written atomically to `outbox_events` using the Transactional Outbox pattern before being dispatched to the event bus.

### Consequences
* Positive: Maximum resilience, zero cascading failures, full replay capability.
* Negative: System design requires handling eventual consistency and out-of-order event delivery.

---

*Architecture Decision Records Approved & Frozen: 2026-07-21*
*Target File: D:\Works Core\TicketX\system\Backend\database\latest\ARCHITECTURE_DECISION_RECORDS.md*
