# Bounded Contexts & Aggregate Roots Redesign
## TicketX / PromptX Platform — Multi-Context Domain Architecture

```
Classification : DOMAIN-DRIVEN DESIGN ARCHITECTURE SPECIFICATION
Date           : 2026-07-21
Framework      : Domain-Driven Design (DDD) by Eric Evans & Vaughn Vernon
Core Concept   : Elimination of "Global Canonical Model" anti-pattern
                 Establishment of Independent Bounded Contexts & Context Mapping
```

---

## 1. DDD THEORETICAL VALIDATION

### Does DDD allow different Aggregate Roots across different Bounded Contexts?

**YES. In fact, Domain-Driven Design MANDATES it.**

Attempting to force a single, global "Canonical Data Model" or a single "Global Aggregate Root" (whether `Conversation` or `Ticket`) across an entire enterprise system is one of the most well-documented anti-patterns in enterprise software engineering (known as the *Enterprise Data Model Trap*).

In Domain-Driven Design:

1. **A Bounded Context defines an explicit boundary** within which a domain model applies.
2. **Inside a Bounded Context, words have exact, unambiguous meanings**, and there is **exactly one primary Aggregate Root** per domain module.
3. **An entity can be an Aggregate Root in Bounded Context A, while being a simple Value Object or scalar Reference (ID only) in Bounded Context B.**

### The Problem With Forcing One Global Aggregate Root

```
WRONG (Global Enterprise Model Anti-Pattern):
                  ┌──────────────────────┐
                  │ Global Aggregate Root│
                  │  (Conversation OR    │
                  │       Ticket)        │
                  └──────────┬───────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       ▼                     ▼                     ▼
  Messaging             Support Operations      AI Agent Runtime
(Wants Conversation)   (Wants Ticket/Case)   (Wants IssueSession)
```

If you force **Conversation** to be the global aggregate root:
- Support operations (SLA, Escalation, Re-open, Billing) become bloated children of a messaging thread.
- AI reasoning (CoT, Tool Calls, Planning) is forced to treat chat history as its primary state machine.

If you force **Ticket** to be the global aggregate root:
- Simple LINE webhooks cannot process incoming messages without first instantiating a support ticket.
- Chat history, media attachments, and channel webhooks become downstream artifacts of a support ticket.

---

## 2. REDESIGNED BOUNDED CONTEXTS FOR TICKETX / PROMPTX

Instead of forcing a single aggregate root, **TicketX consists of 6 distinct Bounded Contexts**, each with its own Aggregate Root, language, and persistence model.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BOUNDED CONTEXT MAP                             │
├────────────────────────┬───────────────────────┬───────────────────────┤
│ BOUNDED CONTEXT        │ AGGREGATE ROOT        │ PERSISTENCE SCOPE     │
├────────────────────────┼───────────────────────┼───────────────────────┤
│ 1. Messaging Context   │ Conversation          │ conversations         │
│                        │                       │ messages, attachments │
├────────────────────────┼───────────────────────┼───────────────────────┤
│ 2. Support Context     │ Ticket (SupportCase)  │ tickets               │
│                        │                       │ ticket_events         │
├────────────────────────┼───────────────────────┼───────────────────────┤
│ 3. Agent AI Context    │ IssueSession (Memory) │ traces, ai_traces     │
│                        │                       │ ai_memory             │
├────────────────────────┼───────────────────────┼───────────────────────┤
│ 4. Identity & Tenant   │ Profile / Company     │ companies, projects   │
│                        │                       │ profiles, identities  │
├────────────────────────┼───────────────────────┼───────────────────────┤
│ 5. Knowledge RAG       │ KnowledgeDocument     │ knowledge_documents   │
│                        │                       │ knowledge_embeddings  │
├────────────────────────┼───────────────────────┼───────────────────────┤
│ 6. Ingestion & Outbox  │ WebhookEvent / Outbox │ webhook_events        │
│                        │                       │ outbox_events         │
└────────────────────────┴───────────────────────┴───────────────────────┘
```

---

### BOUNDED CONTEXT 1: Messaging & Channel Communication Context

* **Ubiquitous Language:** Channel, Thread, Message, Attachment, Recipient, Recall, Delivery Status.
* **Aggregate Root:** `Conversation`
* **Boundary Responsibilities:**
  * Ingesting messages from LINE, WebChat, WhatsApp, Email.
  * Maintaining chronological conversation thread ordering.
  * Preserving channel raw payloads, attachments, and recall status.
* **Aggregate Structure:**

```
[Aggregate Root] Conversation (id, project_id, identity_id, channel, status)
   ├── [Entity] Message (id, role, content, message_type, purpose)
   │     └── [Entity] MessageAttachment (id, storage_key, mime_type)
   └── [Value Object] ChannelMetadata (external_id, push_token)
```

* **What it references from other contexts:**
  * References `project_id` (scalar ID from Identity Context).
  * References `identity_id` (scalar ID from Identity Context).
  * *Does NOT own or reference Tickets or AI Traces directly inside its domain invariants.*

---

### BOUNDED CONTEXT 2: Support Operations & SLA Context

* **Ubiquitous Language:** Ticket, Case, Issue, Priority, Severity, SLA Breach, Escalation, Resolution, Assignment, Team.
* **Aggregate Root:** `Ticket` (SupportCase)
* **Boundary Responsibilities:**
  * SLA calculation (Business Hours, Response Time, Resolution Time).
  * Ticket lifecycle (Open, In Progress, Resolved, Closed, Reopened).
  * Operator assignment, team ownership, and escalation management.
* **Aggregate Structure:**

```
[Aggregate Root] Ticket (id, project_id, subject, status, priority, due_date)
   ├── [Entity] TicketEvent (id, event_type, payload, timestamp)
   ├── [Value Object] SLAPolicy (response_sla_hours, resolution_sla_hours, breached)
   └── [Entity] TicketAssignment (operator_id, team_id)
```

* **What it references from other contexts:**
  * References `conversation_id` (scalar ID from Messaging Context — optional reference).
  * References `operator_id` (scalar ID from Identity Context).
  * *Does NOT own messages or chat threads. It only knows that a case originated from or relates to conversation IDs.*

---

### BOUNDED CONTEXT 3: Agentic AI Reasoning Context

* **Ubiquitous Language:** IssueSession, CoT (Chain of Thought), Tool Call, Guardrail, RAG Context, Memory, Confidence.
* **Aggregate Root:** `IssueSession` (Runtime Aggregate) / `Trace` (Persistent Audit Aggregate)
* **Boundary Responsibilities:**
  * Assembling the in-memory working context for AgentX / PromptX.
  * Executing MCP tool calls and evaluating safety guardrails.
  * Tracking token usage, latency, model cost, and AI decision quality.
* **Aggregate Structure:**

```
[Runtime Aggregate Root] IssueSession (in-memory object during agent turn)
   ├── [Value Object] ContextSnapshot (hydrated conversation + profile + active ticket)
   ├── [Entity] CoTThoughtStep (thought, action, tool_name)
   ├── [Entity] ToolExecution (tool_id, input_args, output_result)
   └── [Value Object] ModelUsage (input_tokens, output_tokens, cost_usd)

[Persistent Audit Aggregate Root] AITrace (id, trace_id, project_id, latency_ms)
   ├── [Entity] ThinkingTrace (CoT steps, tool calls)
   └── [Entity] AIMemory (key, value, memory_type, confidence)
```

* **What it references from other contexts:**
  * Reads snapshot data from Messaging, Support, Identity, and Knowledge contexts via anti-corruption layer.
  * Emits tool execution side-effects (e.g., `create_ticket`, `escalate_to_human`).

---

### BOUNDED CONTEXT 4: Identity, Organization & Access Context

* **Ubiquitous Language:** Company, Project, Team, Operator, Profile, Identity, Enrollment, Channel Secret.
* **Aggregate Root:** `Company` (Tenant Root) & `Profile` (Customer Root)
* **Boundary Responsibilities:**
  * Multi-tenant data boundary & project configuration.
  * Channel credential encryption & security keys.
  * Operator access control (RBAC) and customer profile resolution.
* **Aggregate Structure:**

```
[Tenant Aggregate Root] Company (id, slug, status, plan_tier)
   ├── [Entity] Project (id, slug, status, timezone)
   │     ├── [Entity] ProjectChannel (channel_type, encrypted_credentials)
   │     ├── [Entity] ProjectPrompt (prompt_text, version)
   │     └── [Entity] ProjectSLAPolicy (response_hours, resolve_hours)
   └── [Entity] Team (id, name, parent_team_id)

[Customer Aggregate Root] Profile (id, name, email, phone, gdpr_consent)
   ├── [Entity] Identity (channel, channel_ref, push_token)
   └── [Entity] CustomerEnrollment (project_id, enrollment_type)
```

---

### BOUNDED CONTEXT 5: Knowledge & Vector RAG Context

* **Ubiquitous Language:** Document, Chunk, Embedding, Similarity Score, Index Status, Knowledge Base.
* **Aggregate Root:** `KnowledgeDocument`
* **Boundary Responsibilities:**
  * Ingesting FAQs, manuals, policies, and SOPs.
  * Chunking text and generating vector embeddings.
  * Executing similarity searches (ivfflat / cosine distance).
* **Aggregate Structure:**

```
[Aggregate Root] KnowledgeDocument (id, project_id, title, raw_content, is_active)
   └── [Entity] KnowledgeEmbedding (document_id, model_name, embedding_vector)
```

---

### BOUNDED CONTEXT 6: Webhook Ingestion & Event Outbox Context

* **Ubiquitous Language:** WebhookEvent, Idempotency Key, OutboxEvent, Retry, Sequence, DomainEvent.
* **Aggregate Root:** `WebhookEvent` / `OutboxEvent`
* **Boundary Responsibilities:**
  * Ingesting raw HTTP payloads with zero processing latency.
  * Guaranteeing idempotency via `idempotency_key`.
  * Transactional Outbox pattern for publishing async events to BullMQ / Event Bus.
* **Aggregate Structure:**

```
[Aggregate Root] WebhookEvent (id, platform, idempotency_key, raw_payload, status)
[Aggregate Root] OutboxEvent (id, aggregate_type, aggregate_id, event_type, payload, status)
```

---

## 3. CONTEXT MAPPING & INTEGRATION PATTERNS

How do these 6 Bounded Contexts communicate without coupling their database schemas?

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CONTEXT INTEGRATION MAP                         │
└────────────────────────────────────────────────────────────────────────┘

  [Webhook Ingestion Context]
               │ (Emits: WebhookReceivedEvent)
               ▼
   [Messaging Context]  ◄──── (Anti-Corruption Layer) ────► [Identity Context]
     (Conversation)                                           (Profile / Identity)
               │
               │ (Emits: MessageReceivedEvent)
               ▼
   [Agent AI Context]   ◄──── (Reads Context) ────────────► [Knowledge Context]
     (IssueSession)                                          (KnowledgeDocument)
               │
               │ (Executes Tool: create_ticket / escalate)
               ▼
    [Support Context]   ◄──── (Cross-Context Link) ────────► [Conversation Link]
        (Ticket)
```

### Integration Rules:

1. **NO Cross-Context Foreign Keys with CASCADE Delete:**
   * Tables in Context A MUST NOT have `ON DELETE CASCADE` foreign keys pointing to tables in Context B.
   * Cross-context references MUST be **scalar IDs** (e.g. `messages.ticket_id` is a plain integer/UUID reference to Support Context, not a strict cluster-locking CASCADE anchor).

2. **Event-Driven Integration (Published Language):**
   * Contexts communicate primary state changes using **Domain Events** via `outbox_events`:
     * Messaging emits: `conversation.message_received`
     * Support emits: `ticket.created`, `ticket.status_changed`, `ticket.sla_breached`
     * AI Context emits: `ai.inference_completed`, `ai.escalation_triggered`

3. **Anti-Corruption Layer (ACL):**
   * When AgentX builds `IssueSession`, it uses an ACL service (`ConversationResolver`) that fetches snapshots from Messaging, Identity, Support, and Knowledge contexts into an ephemeral in-memory DTO.

---

## 4. DATABASE SCHEMA MAPPING BY BOUNDED CONTEXT

Below is the complete 29-table production schema assigned strictly to its Bounded Context:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BOUNDED CONTEXT SCHEMA MAP                      │
└────────────────────────────────────────────────────────────────────────┘

1. IDENTITY & TENANT CONTEXT (9 tables)
   ├── companies                    (Tenant Aggregate Root)
   ├── projects                     (Project Aggregate Root)
   ├── operators                    (Operator Aggregate Root)
   ├── teams                        (Team Organizational Hierarchy)
   ├── profiles                     (Customer Profile Aggregate Root)
   ├── identities                   (Channel Identity Entity)
   ├── customer_enrollments         (Profile-Project Membership)
   ├── project_channels             (Channel Credentials & Config)
   └── project_prompts              (AI System Prompts & Versioning)

2. MESSAGING CONTEXT (3 tables)
   ├── conversations                (Conversation Aggregate Root)
   ├── messages                     (Message Entity)
   └── message_attachments          (Attachment Entity)

3. SUPPORT OPERATIONS CONTEXT (5 tables)
   ├── tickets                      (Ticket Aggregate Root)
   ├── ticket_events                (Ticket Audit History)
   ├── conversation_ticket_links    (Cross-Context Junction)
   ├── takeover_sessions            (Human Takeover Session)
   └── conversation_handoffs        (AI ↔ Human Handoff History)

4. PROJECT POLICY CONTEXT (4 tables)
   ├── project_sla_policies         (SLA Policy Rules)
   ├── project_ai_settings          (AI Confidence Thresholds)
   ├── project_business_hours       (Business Hours Schedule)
   └── project_holidays             (Holiday Schedule)

5. AGENT AI & OBSERVABILITY CONTEXT (3 tables)
   ├── traces                       (Agent Tool Execution Log)
   ├── ai_thinking_traces           (Chain-of-Thought Trace)
   └── ai_memory                    (Long-Term Profile Memory)

6. KNOWLEDGE & RAG CONTEXT (2 tables)
   ├── knowledge_documents          (Document Aggregate Root)
   └── knowledge_embeddings         (Vector Embedding Entity)

7. INGESTION & OPERATIONS CONTEXT (3 tables)
   ├── webhook_events               (Webhook Ingestion & Idempotency)
   ├── outbox_events                (Transactional Event Outbox)
   └── admin_audit_logs             (System Audit Log)

TOTAL: 29 Tables across 7 Bounded Contexts
```

---

## 5. SUMMARY OF ARCHITECTURAL DECISIONS

1. **No Global Aggregate Root:** We reject the premise that TicketX must be *either* 100% Conversation-centric *or* 100% Ticket-centric.
2. **Context Independence:**
   * In **Messaging Context**, `Conversation` is the aggregate root.
   * In **Support Context**, `Ticket` is the aggregate root.
   * In **Agent AI Context**, `IssueSession` is the runtime aggregate root.
3. **Decoupled Persistence:**
   * Cross-context references are maintained using `conversation_ticket_links` and scalar ID columns (`messages.ticket_id`, `takeover_sessions.ticket_id`).
   * Schema supports 1 Conversation : N Tickets AND 1 Ticket : N Conversations naturally.
4. **Longevity & 10-Year Evolution:**
   * Adding new channels, new AI models, or new support workflows requires zero changes to the underlying aggregate boundaries.

---

*Specification completed: 2026-07-21*
*Architecture Model: Multi-Context DDD with Independent Aggregate Roots*
*Target File: D:\Works Core\TicketX\system\Backend\database\latest\BOUNDED_CONTEXTS_AND_AGGREGATE_ROOTS.md*
