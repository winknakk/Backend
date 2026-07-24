# Production Operations Manual
## TicketX / PromptX Platform — Runtime Architecture & Operational Standards

```
Classification : PRODUCTION OPERATIONS MANUAL
Date           : 2026-07-21
Status         : APPROVED & IMMUTABLE RUNTIME OPERATIONAL MANUAL
Target         : SRE, DevOps, Platform Engineering, On-Call Engineers
```

---

# OUTPUT 1: TRANSACTION BOUNDARIES & CONSISTENCY SPECIFICATION

## Atomicity Principles
1. **Single-Context Database Atomicity:** All state changes within a single Bounded Context MUST execute within a single PostgreSQL ACID transaction (`BEGIN ... COMMIT`).
2. **Transactional Outbox Requirement:** Every state change that triggers external side-effects or cross-context events MUST write the event to `outbox_events` inside the SAME database transaction.
3. **Cross-Context Eventual Consistency:** State changes spanning multiple Bounded Contexts MUST NOT use distributed 2PC (Two-Phase Commit) database locks. They MUST use Eventual Consistency via Domain Events or Saga Patterns.

## Use Case Transaction Matrix

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   USE CASE TRANSACTION MATRIX                                    │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Use Case | Transaction Scope | Mandatory Atomic Operations (Same TX) | Eventual Consistency (Async Outbox) |
| :--- | :--- | :--- | :--- |
| **1. Webhook Ingestion** | Ingestion Context TX | `INSERT INTO webhook_events`<br>`INSERT INTO outbox_events (webhook.received)` | Worker consumes outbox event to route message |
| **2. Message Creation** | Messaging Context TX | `INSERT INTO messages`<br>`UPDATE conversations (last_message_at)`<br>`INSERT INTO outbox_events (message.received)` | Agent AI Context consumes message event to trigger turn |
| **3. Ticket Creation** | Support Context TX | `INSERT INTO tickets`<br>`INSERT INTO ticket_events`<br>`INSERT INTO conversation_ticket_links`<br>`INSERT INTO outbox_events (ticket.created)` | Plane.io sync worker pushes issue to external tracker |
| **4. Human Takeover** | Support Context TX | `INSERT INTO takeover_sessions`<br>`UPDATE conversations (takeover_state='active')`<br>`INSERT INTO conversation_handoffs`<br>`INSERT INTO outbox_events (takeover.acquired)` | Agent AI halts auto-responses; Push notification to agent |
| **5. AI Inference & Trace** | AI Context TX | `INSERT INTO traces`<br>`INSERT INTO ai_thinking_traces`<br>`INSERT INTO outbox_events (ai.inference_completed)` | Cost analytics worker aggregates token usage |
| **6. Knowledge Indexing** | Knowledge Context TX | `INSERT INTO knowledge_documents`<br>`INSERT INTO knowledge_embeddings`<br>`INSERT INTO outbox_events (knowledge.indexed)` | Vector index re-balancing (ivfflat build) |
| **7. Profile Merge** | Identity Context TX | `UPDATE profiles (is_merged=TRUE)`<br>`UPDATE identities (profile_id=target_id)`<br>`INSERT INTO outbox_events (profile.merged)` | Re-index past vector memories to new profile ID |

---

# OUTPUT 2: SAGA PATTERNS & COMPENSATION STRATEGIES

When a business workflow spans multiple contexts, an Orchestrated Saga coordinates state transitions. If a downstream context fails, compensating actions are executed in reverse order.

## Saga 1: Create Support Ticket & External Sync Saga

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                          CREATE TICKET & EXTERNAL SYNC SAGA                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘

Step 1: Agent AI executes tool `create_ticket`
   │
   ▼
Step 2: Support Context creates Ticket & Link  ────(Fails?)───► Compensation: Emit ticket.cancelled
   │
   ▼
Step 3: PlaneSyncWorker pushes to Plane.io      ────(Fails?)───► Compensation: Retry 5x → DLQ →
   │                                                             Mark ticket.external_sync_failed
   ▼
Step 4: Emit `ticket.created.v1` to messaging
```

* **Compensation Action:** If Plane.io push fails permanently after 5 retries, the ticket status is updated to `Sync_Failed` and an audit event `ticket.sync_failed` is emitted. The ticket record remains intact in PostgreSQL (never hard deleted).

## Saga 2: Human Takeover Acquisition Saga

* **Step 1:** Operator clicks "Claim Conversation" in Admin UI (`POST /api/v1/tickets/:id/takeover`).
* **Step 2:** `SupportService` acquires DB Advisory Lock on `conversation_id`.
* **Step 3:** `takeover_sessions` record inserted; `conversations.takeover_state` updated to `active`.
* **Step 4:** Transaction commits; `takeover.acquired.v1` published to Outbox.
* **Step 5 (Async):** `AgentRuntime` consumes `takeover.acquired.v1` and sets Redis flag `takeover:active:{convId}` to block AI auto-replies.
* **Compensation / Failure Recovery:** If Redis write fails, `AgentRuntime` falls back to checking PostgreSQL `conversations.takeover_state` on every turn before generating responses.

## Saga 3: Customer Profile Merge Saga

* **Step 1:** Admin triggers profile merge (`POST /api/v1/profiles/merge`).
* **Step 2:** `IdentityService` locks both profile rows (`SELECT ... FOR UPDATE`).
* **Step 3:** Source profile flagged `is_merged=TRUE`, identities re-linked to target `profile_id`.
* **Step 4:** Event `profile.merged.v1` published to Outbox.
* **Step 5 (Async Workers):**
  * `MessagingWorker` re-attributes customer enrollments.
  * `AIWorker` updates `ai_memory.profile_id` to target profile ID.
* **Compensation Action:** If any async worker fails, the event is replayed from `dlq_events`. Because operations use `UPDATE WHERE profile_id = source_id`, all step actions are strictly idempotent.

---

# OUTPUT 4: IDEMPOTENCY POLICY

Idempotency guarantees that executing the same request or event multiple times produces the exact same system state.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    IDEMPOTENCY SPECIFICATION                                     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Idempotency Key Format | Storage / Mechanism | Retention | Action on Duplicate |
| :--- | :--- | :--- | :--- | :--- |
| **1. Webhooks** | `hash(platform + channel_id + platform_event_id)` | PostgreSQL `webhook_events.idempotency_key` (UNIQUE index) | 90 Days | Return `HTTP 200 OK` immediately without processing |
| **2. HTTP API** | `Idempotency-Key` Header (UUID) | Redis `idempotency:{key}` with cached Response DTO | 24 Hours | Return cached HTTP Response DTO |
| **3. Message Ingestion** | `UNIQUE(conversation_id, external_id)` | PostgreSQL `messages` UNIQUE constraint | Indefinite | DB ignores insert (`ON CONFLICT DO NOTHING`) |
| **4. Event Workers** | `DomainEventEnvelope.eventId` | Consumer Redis Set `event:processed:{eventId}` | 7 Days | Worker acknowledges job and skips execution |
| **5. AI Tool Calls** | `hash(conversation_id + tool_name + args_hash)` | Ephemeral `IssueSession` Tool Execution Set | Turn Duration | Return cached tool result from current turn |

---

# OUTPUT 5: RETRY POLICY & RESILIENCE SPECIFICATION

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   RETRY & RESILIENCE MATRIX                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 1. Retry Strategies by Component

* **Webhook Processing Worker:** Exponential backoff with jitter (`1s`, `5s`, `25s`, `2m`, `10m`). Max 5 retries.
* **PromptX AI API Calls:** Circuit breaker with exponential backoff (`500ms`, `1s`, `2s`). Max 3 retries. Timeout: 15 seconds.
* **Plane.io Integration Worker:** Linear backoff (`10s`, `30s`, `60s`, `300s`). Max 5 retries before DLQ routing.
* **Database Pool Reconnect:** Exponential backoff (`100ms`, `500ms`, `1s`, `2s`). Max 10 attempts.

## 2. Circuit Breaker Thresholds (Opossum / Resilience4j)

```typescript
export const PromptXCircuitBreakerConfig = {
  timeout: 15000,              // 15 seconds max execution
  errorThresholdPercentage: 50, // Open circuit if 50% requests fail
  resetTimeout: 30000,          // Half-open circuit after 30 seconds
  rollingCountTimeout: 10000,   // Stat window of 10 seconds
  rollingCountBuckets: 10
};
```

## 3. Dead Letter Queue (DLQ) & Poison Message Policy
1. Messages failing all retry attempts are moved to BullMQ `dlq_events` queue.
2. Alert `DLQMessageEnqueued` is fired to Slack/PagerDuty immediately.
3. Poison messages (malformed JSON, invalid schema) are isolated to `poison_events` table for manual developer inspection.

---

# OUTPUT 6: OBSERVABILITY STANDARDS

## 1. Standardized Structured JSON Logging
All application logs MUST be emitted to `stdout` in JSON format containing standard fields:

```json
{
  "timestamp": "2026-07-21T11:15:30.123Z",
  "level": "INFO",
  "service": "ticketx-backend",
  "module": "messaging",
  "correlationId": "c7a8f9d0-1234-7890-abcd-ef1234567890",
  "projectId": 12,
  "companyId": 1,
  "action": "message.created",
  "message": "Message successfully ingested from LINE channel",
  "context": {
    "conversationId": 402,
    "messageId": "msg-8821"
  }
}
```

## 2. OpenTelemetry Tracing & Propagation
* **Header Propagation:** `traceparent` (W3C Trace Context) MUST be propagated across HTTP requests, BullMQ jobs, and Domain Events.
* **Span Names:** Standardized as `{context}.{component}.{method}` (e.g. `messaging.service.createMessage`).

## 3. Core Prometheus Metrics

| Metric Name | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | HTTP API latency distribution |
| `webhook_ingestion_total` | Counter | `platform`, `status` | Total webhooks received by status |
| `ai_inference_latency_ms` | Histogram | `model_name`, `operation_type` | Latency of AI model inference |
| `ai_token_usage_total` | Counter | `model_name`, `type` (input/output) | Total AI tokens consumed |
| `outbox_queue_lag` | Gauge | `event_type` | Pending outbox events delay |
| `circuit_breaker_state` | Gauge | `name` (0=Closed, 1=Open) | Circuit breaker status |

## 4. Kubernetes Health Probes

```yaml
# Liveness Probe (Checks if Node.js process is responsive)
livenessProbe:
  httpGet:
    path: /health/liveness
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10

# Readiness Probe (Checks DB, Redis, and Queue connectivity)
readinessProbe:
  httpGet:
    path: /health/readiness
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 5
```

---

*Manual Approved & Frozen: 2026-07-21*
*Target File: D:\Works Core\TicketX\system\Backend\database\latest\PRODUCTION_OPERATIONS_MANUAL.md*
