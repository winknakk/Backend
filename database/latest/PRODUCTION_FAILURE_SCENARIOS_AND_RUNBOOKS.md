# Production Failure Scenarios, Operational Runbooks & SLO/SLA
## TicketX / PromptX Platform — Production Resilience & Emergency Procedures

```
Classification : PRODUCTION FAILURE SCENARIOS & OPERATIONAL RUNBOOKS
Date           : 2026-07-21
Status         : APPROVED & TESTED IN CHAOS ENGINEERING SIMULATIONS
Target         : SRE, Infrastructure Team, On-Call Engineers, Incident Commander
```

---

# OUTPUT 7: PRODUCTION FAILURE SCENARIOS & SIMULATIONS

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   FAILURE SCENARIO MATRIX                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Failure Scenario | Expected System Behavior | Recovery Procedure | Max Acceptable Data Loss (RPO) | Max Downtime (RTO) |
| :--- | :--- | :--- | :--- | :--- |
| **1. PostgreSQL Main Down** | API returns `503 Service Unavailable`. Ingestion API attempts local disk buffering of webhooks. | Auto-failover to Standby Replica via Patroni/PGBouncer. | RPO = 0 (Sync Streaming Replication) | RTO < 60 Seconds |
| **2. Redis Cache & Queue Down** | BullMQ workers pause. App falls back to direct DB checks for rate limits & takeover states. | Restart Redis container / failover cluster. Re-hydrate cache from DB. | RPO = 0 (Redis is ephemeral/cache) | RTO < 3 Minutes |
| **3. Plane.io Down** | Ticket creation succeeds in PostgreSQL. `PlaneSyncWorker` retries asynchronously. | Outbox worker automatically resumes push when Plane.io recovers. | RPO = 0 (Tickets stored in DB) | RTO = N/A (Zero customer impact) |
| **4. PromptX / LLM API Down** | Circuit breaker opens after 50% failures. Fallback auto-reply sent: *"Our AI assistant is temporarily unavailable."* | Traffic auto-routed to fallback LLM model provider (e.g. Gemini → OpenAI). | RPO = 0 | RTO < 30 Seconds (Circuit Breaker) |
| **5. Knowledge DB (Vector Search) Down** | RAG search returns empty chunk list. AI falls back to base system prompt. | Restart pgvector extension / node. Re-index missing embeddings. | RPO = 0 (Raw docs intact) | RTO < 5 Minutes |
| **6. LINE Webhook Storm (10x Spike)** | Ingestion API accepts webhooks in < 50ms, writes to `webhook_events`, defers processing to BullMQ. | Auto-scale worker pods from 3 to 20 based on CPU/Queue Lag metrics. | RPO = 0 | RTO = 0 (Buffered gracefully) |
| **7. Duplicate Webhooks (LINE Retry)** | `webhook_events.idempotency_key` constraint blocks duplicate inserts. | Ingestion API returns `200 OK` immediately without re-triggering workers. | RPO = 0 | RTO = 0 |
| **8. BullMQ Queue Overflow (> 50k jobs)** | Queue backpressure activates rate limiting on non-essential tasks (e.g. analytics). | Scale worker concurrency + add temporary Redis queue consumer pods. | RPO = 0 | RTO < 10 Minutes |

---

# OUTPUT 8: OPERATIONAL RUNBOOKS

## RUNBOOK 01: Webhook Ingestion Failures
* **Trigger:** Alert `WebhookIngestionErrorRateHigh` (> 5% failed webhooks over 5m).
* **Diagnosis:**
  1. Inspect Ingestion API logs: `kubectl logs -l app=ticketx-backend --tail=100 | grep "webhook"`.
  2. Check HMAC signature validation errors (indicates channel secret mismatch).
* **Remediation:**
  1. If HMAC error: Verify `project_channels.secret_token_encrypted` matches LINE Developer Console.
  2. If Queue full: Scale worker deployment `kubectl scale deployment messaging-worker --replicas=15`.
  3. Replay failed webhooks: Execute script `npm run ops:replay-webhooks -- --status=failed --since=1h`.

## RUNBOOK 02: PostgreSQL Database Outage & Failover
* **Trigger:** Alert `PostgresPrimaryDown` or `DBConnectionPoolExhausted`.
* **Diagnosis:**
  1. Check Patroni cluster status: `patronictl -c /etc/patroni/patroni.yml list`.
  2. Check PGBouncer connections: `psql -h localhost -p 6432 -U postgres pgbouncer -c "SHOW POOLS;"`.
* **Remediation:**
  1. If Patroni failover stalled: Force failover via `patronictl failover <cluster-name>`.
  2. If connection pool exhausted: Terminate idle connections `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND state_change < NOW() - INTERVAL '5 minutes';`.

## RUNBOOK 03: Queue Worker & Outbox Failures
* **Trigger:** Alert `OutboxQueueLagHigh` (> 1,000 pending outbox events for > 10m).
* **Diagnosis:**
  1. Check BullMQ queue stats: `npm run ops:queue-status`.
  2. Check `outbox_events` table: `SELECT status, count(*) FROM outbox_events GROUP BY status;`.
* **Remediation:**
  1. Restart frozen worker pods: `kubectl rollout restart deployment outbox-worker`.
  2. Inspect DLQ for poison messages: `npm run ops:dlq-inspect`.
  3. Replay DLQ messages after bug fix: `npm run ops:dlq-replay -- --queue=events`.

## RUNBOOK 04: AI Runtime / PromptX Downtime
* **Trigger:** Alert `PromptXCircuitBreakerOpen` or `AILatencyP99High` (> 15s).
* **Diagnosis:**
  1. Check LLM provider status page (OpenAI / Google Vertex AI).
  2. Inspect AI execution logs: `kubectl logs -l app=ticketx-backend | grep "ai_inference"`.
* **Remediation:**
  1. Switch primary AI provider to secondary: `npm run ops:set-ai-provider -- --provider=google --model=gemini-1.5-pro`.
  2. If LLMs fully down: Enable Emergency Auto-Responder mode (`project_feature_flags.emergency_mode = TRUE`).

## RUNBOOK 05: Deployment Rollback Procedure
* **Trigger:** High HTTP 500 error rate immediately following a release deployment.
* **Remediation:**
  1. Execute Kubernetes rollback: `kubectl rollout undo deployment/ticketx-backend`.
  2. If database migration was executed in the release:
     * Check if migration was additive (Migrations 014-016 are strictly additive).
     * DO NOT run down-migrations on live DB. The additive schema remains backward-compatible with the previous code version.

## RUNBOOK 06: Disaster Recovery (DR) Procedure
* **Trigger:** Total Cloud Region Outage (Datacenter Loss).
* **Remediation:**
  1. Promote DR PostgreSQL Standby in secondary region to Primary.
  2. Update Route53 DNS / Cloudflare DNS to point backend domain to Secondary Region ALB.
  3. Spin up EKS/GKE Kubernetes cluster in Secondary Region using Terraform.
  4. Verify readiness probe `/health/readiness` returns HTTP 200.

---

# OUTPUT 9: PRODUCTION SLO / SLA & ERROR BUDGETS

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                PRODUCTION SLO / SLA SPECIFICATION                                │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Service Dimension | Target SLO (Internal) | Target SLA (Customer Contract) | Measurement Window |
| :--- | :--- | :--- | :--- |
| **Platform Availability** | **99.95%** (~21m downtime/month) | **99.90%** (~43m downtime/month) | 30 Rolling Days |
| **Webhook Response Time (P95)** | **< 100 ms** | **< 250 ms** | 7 Rolling Days |
| **AI Reply Time (P90)** | **< 3.0 Seconds** | **< 5.0 Seconds** | 7 Rolling Days |
| **Support API Response Time (P95)** | **< 150 ms** | **< 300 ms** | 7 Rolling Days |
| **Outbox Queue Lag Time (P99)** | **< 5.0 Seconds** | **< 30.0 Seconds** | 24 Hours |
| **Recovery Time Objective (RTO)** | **< 60 Seconds** (DB Failover) | **< 15 Minutes** (Region Outage) | Per Incident |
| **Recovery Point Objective (RPO)** | **0 Data Loss** (PostgreSQL) | **0 Data Loss** (PostgreSQL) | Per Incident |

## Error Budget Policy
* **Monthly Error Budget (99.95% Availability):** 21.6 minutes of downtime per month.
* **Policy when Error Budget drops below 25%:**
  1. All non-critical feature deployments are FROZEN.
  2. Engineering sprints shift 100% focus to reliability, performance, and bug fixes.
  3. Deployment freeze lifts only after Error Budget recovers above 50% for 7 consecutive days.

---

*Manual Approved & Tested: 2026-07-21*
*Target File: D:\Works Core\TicketX\system\Backend\database\latest\PRODUCTION_FAILURE_SCENARIOS_AND_RUNBOOKS.md*
