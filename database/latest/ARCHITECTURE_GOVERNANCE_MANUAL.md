# Enterprise Architecture Governance Manual
## TicketX / PromptX Platform — 10-Year Architecture Governance & Standards

```
Classification : ENTERPRISE ARCHITECTURE GOVERNANCE MANUAL
Date           : 2026-07-21
Status         : APPROVED & IMMUTABLE GOVERNANCE MANUAL
Target         : Core Backend, Microservices, CI/CD Pipeline, Engineering Team
```

---

# ADR-007: Context Communication Rules

## Status
FROZEN & IMMUTABLE

## Context
As the TicketX platform grows, engineering teams may be tempted to shortcut context boundaries by directly importing repositories, classes, or database models from other modules. Allowing unconstrained cross-context communication leads to spaghetti coupling, invalidates aggregate invariants, and breaks multi-tenant security boundaries.

## Decision

### 1. Allowed Communication Paths
Communication across Bounded Context boundaries is permitted **ONLY** through the following three mechanisms:

1. **Asynchronous Event-Driven State Changes (Upstream → Downstream):** State mutations that trigger side-effects in other contexts MUST occur via Domain Events published through `outbox_events`.
2. **Synchronous Read-Only Context Mapping (ACL):** Synchronous cross-context data reads are allowed ONLY via the `ContextMappingLayer` resolvers (`ConversationResolver`, `TicketResolver`, `ProfileResolver`, `KnowledgeResolver`).
3. **Internal Application APIs (Facade Services):** Public Application Service interfaces exposed explicitly in a context's public API contract.

### 2. Forbidden Communication Paths (STRICTLY PROHIBITED)

| Action | Allowed? | Approved Alternative |
| :--- | :--- | :--- |
| Support Module calls `MessagingRepository` directly | ❌ FORBIDDEN | Call `ConversationResolver` in Context Mapping Layer |
| Messaging Module updates `profiles` table directly | ❌ FORBIDDEN | Publish `messaging.unknown_sender_detected.v1` or call `IdentityService` |
| AI Module writes directly to `tickets` table | ❌ FORBIDDEN | AI Agent invokes `create_ticket` tool; `SupportService` handles execution |
| Controller imports another context's Repository | ❌ FORBIDDEN | Controllers can ONLY import their own module's Application Service |
| Worker directly mutates another context's DB state | ❌ FORBIDDEN | Worker publishes a Domain Event or calls an explicit Public API |
| Direct SQL queries spanning tables of two contexts | ❌ FORBIDDEN | Query via owner contexts or use dedicated Read-Only Database Views |

---

# ADR-008: Domain Event Contract Versioning & Event Governance

## Status
FROZEN & IMMUTABLE

## Context
Domain Events form the backbone of asynchronous communication across contexts. Without strict event contract governance, changing an event structure in one service can break downstream consumers across the platform.

## Event Governance Standards

### 1. Event Naming Taxonomy
All domain events MUST adhere to the rigid taxonomy:
`{context}.{entity}.{action}.v{version}`

*Examples:*
* `ingestion.webhook.received.v1`
* `messaging.conversation.message_received.v1`
* `support.ticket.created.v1`
* `support.ticket.sla_breached.v1`
* `ai.inference.completed.v1`
* `identity.profile.merged.v1`

### 2. Event Envelope Structure
Every published event MUST be wrapped in the standardized `DomainEventEnvelope`:

```typescript
export interface DomainEventEnvelope<T = unknown> {
  eventId: string;           // UUID v7 (time-ordered)
  eventType: string;         // e.g. "support.ticket.created.v1"
  schemaVersion: string;     // e.g. "1.0.0"
  aggregateType: string;     // e.g. "Ticket"
  aggregateId: string;       // e.g. "1042"
  projectId: number;         // Multi-tenant isolation scope
  companyId: number;
  correlationId: string;     // Trace ID across entire request flow
  causationId?: string;      // ID of event/message that triggered this event
  timestamp: string;         // ISO-8601 UTC
  actor: {
    type: 'customer' | 'operator' | 'ai' | 'system' | 'webhook';
    id: string;
  };
  payload: T;                // Event data payload
}
```

### 3. Versioning & Backward Compatibility Policy
1. **Minor / Additive Changes (`v1.1.0`):** Adding optional fields to `payload` does NOT require a new event version. Downstream consumers MUST ignore unknown fields.
2. **Major / Breaking Changes (`v2.0.0`):** Renaming fields, deleting fields, or changing data types REQUIRES creating a new event version (e.g., `support.ticket.created.v2`).
3. **Dual-Publishing Window:** When a major version is released, the publishing context MUST dual-publish both `v1` and `v2` for a deprecation window of at least 30 days until all consumers migrate.

### 4. Idempotency, DLQ & Replay Procedures
* **Consumer Idempotency:** Consumers MUST store processed `eventId`s or use unique operational keys. Processing the same `eventId` twice MUST be a no-op.
* **Retry Strategy:** Exponential backoff with jitter (Retries at 1s, 5s, 25s, 2m, 10m).
* **Dead Letter Queue (DLQ):** Messages failing after 5 attempts are automatically routed to `dlq_events` for manual inspection and replay.

---

# ADR-009: Read Model Policy (CQRS-Lite)

## Status
FROZEN & IMMUTABLE

## Context
Executing complex joins across Messaging, Support, Identity, and AI contexts for dashboard reporting or inbox views causes cross-context coupling and degrades transactional performance.

## Decision

### 1. CQRS-Lite Principle
* **Write Path (Commands):** Strictly enforced through Bounded Context Aggregate Roots via single-table transactions.
* **Read Path (Queries):** Complex multi-context reads MUST use either:
  1. **Anti-Corruption Layer Resolvers** (for real-time runtime context assembly).
  2. **Database Read-Only Views (`/database/views`)** (for admin reporting and dashboard listing).
  3. **Redis Read Caching** (for immutable configuration and prompt read paths).

### 2. Cross-Context Read Models & Caching Rules
* **Database Views:** Read-only database views (e.g., `v_active_inbox`, `v_ticket_sla_status`) may join across context tables for reporting purposes ONLY. Domain services MUST NOT issue `UPDATE` or `DELETE` statements against tables based on view results.
* **Cache Invalidation Policy:** Redis caches MUST be invalidated via Domain Events. For example, when `project.config_updated.v1` is consumed, the Redis cache key `cache:project:config:{id}` is evicted immediately.

---

# ADR-010: Repository Rules & Strict Ownership

## Status
FROZEN & IMMUTABLE

## Context
Repositories encapsulate database access logic. Allowing services to bypass repositories or execute raw SQL outside designated repository classes destroys data integrity, violates encapsulation, and prevents RLS tenant isolation.

## Strict Ownership Matrix

| Repository Interface | Owner Context | Authorized Callers | Absolute Prohibited Callers |
| :--- | :--- | :--- | :--- |
| `ConversationRepository` | Messaging Context | `MessagingService` | Controllers, Workers, Support, AI, Identity, Knowledge |
| `MessageRepository` | Messaging Context | `MessagingService` | Controllers, Workers, Support, AI, Identity, Knowledge |
| `TicketRepository` | Support Context | `SupportService` | Controllers, Workers, Messaging, AI, Identity, Knowledge |
| `TakeoverRepository` | Support Context | `TakeoverManager`, `SupportService` | Controllers, Workers, Messaging, AI, Identity |
| `TraceRepository` | AI Context | `AgentRuntime`, `AIService` | Controllers, Workers, Messaging, Support, Identity |
| `AIMemoryRepository` | AI Context | `AgentRuntime`, `AIService` | Controllers, Workers, Messaging, Support, Identity |
| `CompanyRepository` | Identity Context | `IdentityService`, `AdminService` | Controllers, Workers, Messaging, Support, AI |
| `ProfileRepository` | Identity Context | `IdentityService` | Controllers, Workers, Messaging, Support, AI |
| `KnowledgeRepository` | Knowledge Context | `KnowledgeService` | Controllers, Workers, Messaging, Support, AI |
| `WebhookEventRepository` | Ingestion Context | `WebhookIngestionService` | Controllers, Workers, Messaging, Support, AI |
| `OutboxRepository` | Automation Context | `AutomationService`, `OutboxWorker` | Controllers, Messaging, Support, AI, Identity |

## Repository Implementation Rules
1. **Interface Isolation:** All repositories MUST implement a clean TypeScript interface defined in `/src/modules/{context}/repositories/{entity}.repository.interface.ts`.
2. **No Direct SQL Outside Repositories:** Raw SQL queries outside repository classes are strictly blocked by static analysis.
3. **Tenant Scoping:** Every repository method retrieving multi-tenant data MUST accept `projectId: number` as a required parameter and include `WHERE project_id = $1` in all SQL queries.

---

# ADR-011: Application Layer Rules & Anti-God Service Policies

## Status
FROZEN & IMMUTABLE

## Context
Application Services often accumulate responsibilities over time, becoming bloated "God Services" that contain business logic, data mapping, orchestration, and infrastructure calls.

## Layer Responsibilities

```
┌────────────────────────────────────────────────────────────────────────┐
│                      APPLICATION LAYER ARCHITECTURE                    │
├───────────────────┬────────────────────────────────────────────────────┤
│ LAYER COMPONENT   │ SINGLE RESPONSIBILITY POLICY                       │
├───────────────────┼────────────────────────────────────────────────────┤
│ 1. Controllers    │ Accept HTTP/Webhook request, validate DTO,         │
│                   │ invoke Application Service, return HTTP response.  │
│                   │ ZERO business logic permitted.                     │
├───────────────────┼────────────────────────────────────────────────────┤
│ 2. App Services   │ Orchestrate Use Cases, manage DB transactions,     │
│                   │ publish Outbox events. Max 300 lines of code.      │
├───────────────────┼────────────────────────────────────────────────────┤
│ 3. Use Cases      │ Single-purpose class implementing one business run │
│                   │ (e.g. `CreateTicketUseCase.execute()`).            │
├───────────────────┼────────────────────────────────────────────────────┤
│ 4. Domain Models  │ Enforce invariants, state transitions, and rules.  │
├───────────────────┼────────────────────────────────────────────────────┤
│ 5. Resolvers      │ ACL classes fetching cross-context read snapshots. │
├───────────────────┼────────────────────────────────────────────────────┤
│ 6. Builders       │ Construct complex runtime objects (e.g.            │
│                   │ `IssueSessionBuilder`).                            │
└───────────────────┴────────────────────────────────────────────────────┘
```

## Anti-God Service Caps
* **File Length Cap:** No Application Service file may exceed **300 lines of code**. If a service exceeds 300 lines, it MUST be refactored into single-purpose Use Case classes (`/use-cases`).
* **Dependency Cap:** No Application Service constructor may accept more than **5 injected dependencies**. Exceeding 5 dependencies indicates improper separation of concerns.

---

# ADR-012: Shared Kernel Rules & Boundaries

## Status
FROZEN & IMMUTABLE

## Context
The `/src/shared` directory can easily become a dumping ground for generic utilities, cross-module logic, and leaking domain models if not strictly governed.

## Allowed vs. Forbidden in Shared Kernel

### Allowed in `/src/shared`
* `/shared/domain`: Base classes (`Entity`, `AggregateRoot`, `ValueObject`, `DomainEventBase`).
* `/shared/contracts`: Standard event envelopes (`DomainEventEnvelope`), pagination DTOs, response wrappers.
* `/shared/crypto`: AES-256-GCM encryption utilities, HMAC verification functions.
* `/shared/errors`: Standard platform exceptions (`DomainException`, `NotFoundException`, `UnauthorizedException`).
* `/shared/types`: Generic utility types (`Nullable<T>`, `DeepReadonly<T>`).

### Strictly FORBIDDEN in `/src/shared`
* ❌ Context-specific Domain Entities (`Ticket`, `Conversation`, `Profile`).
* ❌ Database Repository interfaces or TypeORM/Prisma/Kysely instances.
* ❌ Business logic or policy calculations (SLA logic, AI prompt formatting).
* ❌ Controllers, API routes, or HTTP handlers.

---

*Manual Approved & Frozen: 2026-07-21*
*Target File: D:\Works Core\TicketX\system\Backend\database\latest\ARCHITECTURE_GOVERNANCE_MANUAL.md*
