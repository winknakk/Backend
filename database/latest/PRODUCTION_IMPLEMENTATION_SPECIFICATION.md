# Production Implementation Specification
## TicketX / PromptX Platform — Enterprise DDD Architecture

```
Classification : PRODUCTION IMPLEMENTATION SPECIFICATION
Date           : 2026-07-21
Status         : FROZEN ARCHITECTURE SPECIFICATION
Target         : Production PostgreSQL & Backend Core System
```

---

## OUTPUT 1: BOUNDED CONTEXT DEPENDENCY DIAGRAM

The diagram below defines upstream and downstream relationships between the 7 Bounded Contexts and the Context Mapping Layer.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               BOUNDED CONTEXT DEPENDENCY GRAPH                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

                                    [ 1. INGESTION CONTEXT ]
                                        (Upstream Source)
                                                │
                                                │ (Publishes: WebhookReceivedEvent)
                                                ▼
                                    [ 2. MESSAGING CONTEXT ]
                                        (Upstream Source)
                                                │
                                                │ (Publishes: MessageReceivedEvent)
                                                ▼
 ┌────────────────────────┐         [ CONTEXT MAPPING LAYER ]         ┌────────────────────────┐
 │  4. IDENTITY CONTEXT   │ ◄─────── (Context Resolvers &  ─────────► │  5. KNOWLEDGE CONTEXT  │
 │  (Profiles, Projects)  │            Session Builder)               │  (KnowledgeDocuments)  │
 └────────────────────────┘                 │                         └────────────────────────┘
                                            │ (Hydrates IssueSession)
                                            ▼
                                   [ 3. AGENT AI CONTEXT ]
                                   (Runtime: IssueSession)
                                                │
                                                │ (Invokes Tools / Emits Events)
                                                ▼
┌─────────────────────────┐        ┌───────────────────────┐        ┌──────────────────────────┐
│   6. SUPPORT CONTEXT    │ ◄───── │ CONTEXT MAPPER JUNCTIONS │ ─────► │  7. AUTOMATION CONTEXT   │
│   (Tickets, SLA, Handoff)│        │(conv_ticket_links)    │        │ (WorkflowExecutions)     │
└─────────────────────────┘        └───────────────────────┘        └──────────────────────────┘

FLOW RULES & DEPENDENCY DIRECTION:
  - Ingestion Context is UPSTREAM to Messaging Context.
  - Messaging Context is UPSTREAM to Agent AI Context.
  - Identity & Knowledge Contexts are UPSTREAM READ PROVIDERS to Context Mapping Layer.
  - Context Mapping Layer is DOWNSTREAM to Messaging/Identity/Knowledge, UPSTREAM to Agent AI Context.
  - Agent AI Context is UPSTREAM to Support Context (triggers ticket creation/escalation).
  - Automation Context is DOWNSTREAM subscriber to all Domain Events via Transactional Outbox.
```

---

## OUTPUT 2: CONTEXT OWNERSHIP MATRIX

Every database table is assigned strictly to exactly one Bounded Context, Aggregate Root, Service Owner, and Reader/Writer permissions.

| Table Name | Bounded Context | Aggregate Root | Owner Service | Authorized Writers | Authorized Readers |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `webhook_events` | Ingestion Context | WebhookEvent | `WebhookIngestionService` | `WebhookIngestionService` | `WebhookIngestionService`, `MessagingWorker` |
| `conversations` | Messaging Context | Conversation | `MessagingService` | `MessagingService` | `MessagingService`, `ContextMappingLayer`, `SupportService` |
| `messages` | Messaging Context | Conversation | `MessagingService` | `MessagingService` | `MessagingService`, `ContextMappingLayer`, `AIService` |
| `message_attachments` | Messaging Context | Conversation | `MessagingService` | `MessagingService` | `MessagingService`, `ContextMappingLayer`, `AIService` |
| `tickets` | Support Context | Ticket | `SupportService` | `SupportService` | `SupportService`, `ContextMappingLayer`, `AIService`, `SyncWorker` |
| `ticket_events` | Support Context | Ticket | `SupportService` | `SupportService` | `SupportService`, `AutomationService` |
| `takeover_sessions` | Support Context | Ticket | `SupportService` | `TakeoverManager` | `SupportService`, `ContextMappingLayer`, `AIService` |
| `conversation_handoffs` | Support Context | Ticket | `SupportService` | `TakeoverManager`, `AIService` | `SupportService`, `ContextMappingLayer`, `AIService` |
| `traces` | AI Context | AITrace | `AIService` | `AgentRuntime` | `AIService`, `AdminDashboard` |
| `ai_thinking_traces` | AI Context | AITrace | `AIService` | `AgentRuntime` | `AIService`, `AdminDashboard` |
| `ai_memory` | AI Context | AITrace | `AIService` | `AgentRuntime`, `MemoryWorker` | `ContextMappingLayer`, `AIService` |
| `companies` | Identity Context | Company | `IdentityService` | `AdminService` | All Services |
| `projects` | Identity Context | Company | `IdentityService` | `AdminService` | All Services |
| `teams` | Identity Context | Company | `IdentityService` | `AdminService` | `IdentityService`, `SupportService` |
| `operators` | Identity Context | Company | `IdentityService` | `AdminService` | `IdentityService`, `SupportService`, `AIService` |
| `profiles` | Identity Context | Profile | `IdentityService` | `IdentityService` | All Services |
| `identities` | Identity Context | Profile | `IdentityService` | `IdentityService` | `MessagingService`, `IdentityService` |
| `customer_enrollments` | Identity Context | Profile | `IdentityService` | `IdentityService`, `MessagingService` | `IdentityService`, `SupportService` |
| `project_channels` | Identity Context | Company | `IdentityService` | `AdminService` | `MessagingService`, `IdentityService` |
| `project_prompts` | Identity Context | Company | `IdentityService` | `AdminService` | `ContextMappingLayer`, `AIService` |
| `project_sla_policies` | Identity Context | Company | `IdentityService` | `AdminService` | `SupportService` |
| `project_ai_settings` | Identity Context | Company | `IdentityService` | `AdminService` | `ContextMappingLayer`, `AIService` |
| `project_business_hours` | Identity Context | Company | `IdentityService` | `AdminService` | `SupportService` |
| `project_holidays` | Identity Context | Company | `IdentityService` | `AdminService` | `SupportService` |
| `project_feature_flags` | Identity Context | Company | `IdentityService` | `AdminService` | All Services |
| `knowledge_documents` | Knowledge Context | KnowledgeDocument | `KnowledgeService` | `KnowledgeService` | `KnowledgeService`, `ContextMappingLayer` |
| `knowledge_embeddings` | Knowledge Context | KnowledgeDocument | `KnowledgeService` | `KnowledgeWorker` | `KnowledgeService` |
| `outbox_events` | Automation Context | WorkflowExecution | `AutomationService` | All Services (via Outbox Writer) | `AutomationWorker` |
| `admin_audit_logs` | Operations / Admin | AuditLog | `AdminService` | `AdminService`, `SecurityInterceptor` | `AdminService` |
| `conversation_ticket_links` | **Context Mapping Layer** | **Integration Link** | `ContextMappingLayer` | `ContextMappingLayer` | `MessagingService`, `SupportService`, `AIService` |

---

## OUTPUT 3: DATABASE FOLDER STRUCTURE

Database assets must be modularized by migration sequence, schema definitions, views, and functions.

```
/database
├── /migrations
│   ├── 001_initial_schema.sql
│   ├── 002_nocodb_import.sql
│   ├── 003_pgvector_embeddings.sql
│   ├── 004_v3_platform_schema.sql
│   ├── 005_sla_engine.sql
│   ├── 006_ticket_enrichment.sql
│   ├── 007_webchat_support.sql
│   ├── 008_event_store_and_outbox.sql
│   ├── 009_mcp_routing_and_policy.sql
│   ├── 010_ticket_intelligence_v2.sql
│   ├── 011_searchable_text_vector.sql
│   ├── 012_admin_audit_logs.sql
│   ├── 013_message_uniqueness.sql
│   ├── 014_production_readiness.sql
│   ├── 015_day1_minimum_viable.sql
│   ├── 015b_domain_tables.sql
│   └── 016_architectural_corrections.sql
├── /schema
│   ├── ingestion.sql
│   ├── messaging.sql
│   ├── support.sql
│   ├── identity.sql
│   ├── ai.sql
│   ├── knowledge.sql
│   ├── automation.sql
│   └── context_mapping.sql
├── /seeds
│   ├── dev_seeds.sql
│   ├── production_baseline.sql
│   └── default_prompts.sql
├── /views
│   ├── v_active_inbox.sql
│   ├── v_ticket_sla_status.sql
│   └── v_ai_cost_analytics.sql
├── /functions
│   ├── fn_uuid_generate_v7.sql
│   ├── fn_set_updated_at.sql
│   └── fn_vector_search_knowledge.sql
├── /triggers
│   ├── trg_updated_at.sql
│   └── trg_outbox_publish.sql
├── /policies
│   └── rls_project_isolation.sql
└── /docs
    ├── ERD.md
    └── DATA_DICTIONARY.md
```

---

## OUTPUT 4: REPOSITORY MODULE STRUCTURE

The backend NestJS / Fastify repository must isolate modules strictly per Bounded Context.

```
/src/modules
├── /ingestion
│   ├── ingestion.module.ts
│   ├── /controllers
│   │   └── webhook.controller.ts
│   ├── /services
│   │   └── webhook-ingestion.service.ts
│   └── /repositories
│       └── webhook-event.repository.ts
├── /messaging
│   ├── messaging.module.ts
│   ├── /controllers
│   │   └── conversation.controller.ts
│   ├── /services
│   │   └── messaging.service.ts
│   └── /repositories
│       ├── conversation.repository.ts
│       └── message.repository.ts
├── /support
│   ├── support.module.ts
│   ├── /controllers
│   │   ├── ticket.controller.ts
│   │   └── takeover.controller.ts
│   ├── /services
│   │   ├── support.service.ts
│   │   ├── takeover.manager.ts
│   │   └── sla.calculator.ts
│   └── /repositories
│       ├── ticket.repository.ts
│       └── takeover.repository.ts
├── /identity
│   ├── identity.module.ts
│   ├── /controllers
│   │   ├── tenant.controller.ts
│   │   └── profile.controller.ts
│   ├── /services
│   │   ├── identity.service.ts
│   │   └── credential-crypto.service.ts
│   └── /repositories
│       ├── company.repository.ts
│       ├── profile.repository.ts
│       └── identity.repository.ts
├── /knowledge
│   ├── knowledge.module.ts
│   ├── /controllers
│   │   └── knowledge.controller.ts
│   ├── /services
│   │   ├── knowledge.service.ts
│   │   └── vector-search.service.ts
│   └── /repositories
│       └── knowledge.repository.ts
├── /ai
│   ├── ai.module.ts
│   ├── /controllers
│   │   └── agent.controller.ts
│   ├── /services
│   │   ├── agent.runtime.ts
│   │   └── promptx.client.ts
│   └── /repositories
│       ├── trace.repository.ts
│       └── ai-memory.repository.ts
├── /automation
│   ├── automation.module.ts
│   ├── /workers
│   │   ├── outbox.worker.ts
│   │   └── workflow.worker.ts
│   ├── /services
│   │   └── automation.service.ts
│   └── /repositories
│       └── outbox.repository.ts
├── /context-mapping
│   ├── context-mapping.module.ts
│   ├── /mappers
│   │   └── conversation-ticket.mapper.ts
│   ├── /resolvers
│   │   ├── conversation.resolver.ts
│   │   ├── ticket.resolver.ts
│   │   ├── profile.resolver.ts
│   │   └── knowledge.resolver.ts
│   ├── /builders
│   │   └── issue-session.builder.ts
│   └── /repositories
│       └── conversation-ticket-link.repository.ts
└── /shared
    ├── /domain
    │   └── domain-event.base.ts
    ├── /crypto
    │   └── aes-gcm.util.ts
    └── /infrastructure
        └── database.provider.ts
```

---

## OUTPUT 5: CONTEXT APIS & EVENTS SPECIFICATION

### 1. Ingestion Context
* **Public APIs:** `POST /api/v1/webhooks/:platform/:channelId`
* **Private APIs:** `GET /api/v1/internal/webhooks/:id/status`
* **Events Published:** `webhook.received.v1`, `webhook.duplicate_detected.v1`
* **Events Consumed:** None

### 2. Messaging Context
* **Public APIs:** `GET /api/v1/conversations`, `GET /api/v1/conversations/:id/messages`, `POST /api/v1/conversations/:id/messages`
* **Private APIs:** `GET /api/v1/internal/conversations/:id/snapshot`, `PATCH /api/v1/internal/conversations/:id/status`
* **Events Published:** `conversation.created.v1`, `conversation.message_received.v1`, `conversation.message_sent.v1`
* **Events Consumed:** `webhook.received.v1`

### 3. Support Context
* **Public APIs:** `GET /api/v1/tickets`, `POST /api/v1/tickets`, `POST /api/v1/tickets/:id/takeover`, `POST /api/v1/tickets/:id/release`
* **Private APIs:** `GET /api/v1/internal/tickets/active-by-profile/:profileId`, `POST /api/v1/internal/tickets/auto-create`
* **Events Published:** `ticket.created.v1`, `ticket.status_changed.v1`, `ticket.sla_breached.v1`, `takeover.acquired.v1`, `takeover.released.v1`
* **Events Consumed:** `conversation.message_received.v1`, `ai.escalation_triggered.v1`

### 4. Identity Context
* **Public APIs:** `GET /api/v1/companies/me`, `GET /api/v1/profiles/:id`, `PUT /api/v1/profiles/:id`
* **Private APIs:** `GET /api/v1/internal/identities/resolve`, `GET /api/v1/internal/projects/:id/config`
* **Events Published:** `profile.created.v1`, `profile.merged.v1`, `project.config_updated.v1`
* **Events Consumed:** `messaging.unknown_sender_detected.v1`

### 5. Knowledge Context
* **Public APIs:** `GET /api/v1/knowledge/documents`, `POST /api/v1/knowledge/documents`
* **Private APIs:** `POST /api/v1/internal/knowledge/vector-search`
* **Events Published:** `knowledge.document_indexed.v1`
* **Events Consumed:** None

### 6. Agent AI Context
* **Public APIs:** `POST /api/v1/ai/chat`, `GET /api/v1/ai/traces/:traceId`
* **Private APIs:** `POST /api/v1/internal/ai/execute-turn`
* **Events Published:** `ai.inference_completed.v1`, `ai.escalation_triggered.v1`, `ai.tool_executed.v1`
* **Events Consumed:** `conversation.message_received.v1`

### 7. Automation Context
* **Public APIs:** `GET /api/v1/automation/workflows`
* **Private APIs:** `POST /api/v1/internal/outbox/publish`
* **Events Published:** `workflow.started.v1`, `workflow.completed.v1`, `workflow.failed.v1`
* **Events Consumed:** All Domain Events (via Outbox Reader)

---

## OUTPUT 6: CONTEXT MAPPING LAYER SPECIFICATION

The Context Mapping Layer decouples domain modules and builds ephemeral runtime representations.

### 1. `ConversationTicketMapper`
* **Owner:** Context Mapping Layer (`/src/modules/context-mapping`)
* **Responsibility:** Manages the `conversation_ticket_links` junction table. Maps relationships between Messaging and Support contexts without direct domain coupling.
* **Callers:** `SupportService`, `MessagingService`, `TakeoverManager`.

### 2. `ConversationResolver`
* **Owner:** Context Mapping Layer
* **Responsibility:** Fetches a clean snapshot of conversation thread messages and attachments from `MessagingContext`.
* **Callers:** `IssueSessionBuilder`.

### 3. `TicketResolver`
* **Owner:** Context Mapping Layer
* **Responsibility:** Queries `SupportContext` for the currently active open ticket for a given `profileId` or `conversationId`.
* **Callers:** `IssueSessionBuilder`.

### 4. `ProfileResolver`
* **Owner:** Context Mapping Layer
* **Responsibility:** Queries `IdentityContext` to resolve a channel sender (`channel_ref`) to a `Profile` and `CustomerEnrollment`.
* **Callers:** `MessagingService`, `IssueSessionBuilder`.

### 5. `KnowledgeResolver`
* **Owner:** Context Mapping Layer
* **Responsibility:** Calls `KnowledgeContext` vector search to retrieve top-k document chunks for the incoming customer message.
* **Callers:** `IssueSessionBuilder`.

### 6. `IssueSessionBuilder` (CRITICAL)
* **Owner:** Context Mapping Layer (`/src/modules/context-mapping/builders`)
* **Responsibility:** Assembles the ephemeral, in-memory `IssueSession` DTO consumed by `AgentRuntime`.
* **Behavior:**
  1. Invokes `ProfileResolver` → gets Profile & Enrollments.
  2. Invokes `ConversationResolver` → gets Recent Messages & Attachments.
  3. Invokes `TicketResolver` → gets Active Ticket & SLA status (if exists).
  4. Invokes `KnowledgeResolver` → gets Relevant Vector Chunks.
  5. Invokes `AIMemoryRepository` → gets Profile Memories.
  6. Constructs `IssueSession` object in RAM and passes to `AgentRuntime`.
  7. **Destroys `IssueSession` from memory immediately after turn completion.**

---

## OUTPUT 7: PRODUCTION IMPLEMENTATION ROADMAP

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   PRODUCTION ROADMAP (5 SPRINTS)                                 │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

SPRINT 1: Database Baseline & Core Domain Isolation
  - Run Migrations 001 through 016 on PostgreSQL target server.
  - Implement `/src/modules/identity` and `/src/modules/messaging`.
  - Validate AES-256-GCM credential encryption on `project_channels`.
  - Deploy `webhook_events` idempotency ingestion pipeline.

SPRINT 2: Support Operations & Context Mapping Layer
  - Implement `/src/modules/support` (Tickets, SLA Calculator, TakeoverManager).
  - Implement `/src/modules/context-mapping` (`ConversationTicketMapper`, `IssueSessionBuilder`).
  - Verify `tickets.conversation_id` is nullable and `conversation_ticket_links` functions correctly.

SPRINT 3: Agent AI Runtime & Knowledge Integration
  - Implement `/src/modules/ai` and `/src/modules/knowledge`.
  - Wire `IssueSessionBuilder` to assemble runtime DTOs for `AgentRuntime`.
  - Integrate pgvector search on `knowledge_documents` + `knowledge_embeddings`.
  - Validate tool execution logging in `traces` and `ai_thinking_traces`.

SPRINT 4: Transactional Outbox & Automation Engine
  - Implement `/src/modules/automation` (`OutboxWorker`, `WorkflowService`).
  - Wire transactional outbox triggers on `outbox_events`.
  - Connect Plane.io sync worker via async Outbox consumer.

SPRINT 5: Enterprise Hardening & Self-Audit
  - Apply Row-Level Security (RLS) policies for tenant isolation.
  - Execute end-to-end simulation: LINE Webhook → Ingestion → Agent AI → Ticket Creation → Takeover.
  - Freeze production release tag.
```

---

*Specification Completed: 2026-07-21*
*Target File: D:\Works Core\TicketX\system\Backend\database\latest\PRODUCTION_IMPLEMENTATION_SPECIFICATION.md*
