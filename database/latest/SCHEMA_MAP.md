# Schema Map — Complete Table Inventory
## TicketX / PromptX Platform — Production Frozen Schema
**Date:** 2026-07-21 | **Version:** Post-Migration 015

---

## Complete ERD Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  TENANT LAYER                                                        │
│                                                                      │
│   companies ──────────────── projects ─────────────── operators     │
│       │                          │                        │          │
│       │                    project_channels          op_proj_access  │
│       │                    project_prompts                           │
│       │                    project_sla_policies                     │
│       │                    project_ai_settings                      │
│       │                    project_routing_rules                    │
│       │                    project_mcp_permissions                  │
│       │                    project_feature_flags                    │
│       │                    project_business_hours ──── holiday_cal  │
│       │                    project_holidays                         │
│       │                                                             │
│   company_holiday_calendars                                          │
│   company_holidays                                                   │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  CUSTOMER LAYER                                                      │
│                                                                      │
│   profiles ──────── identities ─────── conversations               │
│                         │                    │                       │
│                    webchat_sessions   conv_participants              │
│                                       conv_handoffs                  │
│                                       takeover_sessions             │
│                                       internal_notes                │
│                                       messages ──── attachments     │
│                                                 └── media_analysis  │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  TICKET LAYER                                                        │
│                                                                      │
│   tickets ──── ticket_events                                         │
│         └───── ticket_embeddings                                     │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  KNOWLEDGE LAYER                                                     │
│                                                                      │
│   knowledge_documents ──── knowledge_embeddings                     │
│   (replaces document_embeddings)                                     │
│                                                                      │
│   ai_memory (long-term agent memory per profile/project)            │
│   learning_samples (AI training pipeline)                           │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  AI/AGENT LAYER                                                      │
│                                                                      │
│   traces ─────────────── ai_thinking_traces                         │
│   ai_inference_logs (cost, tokens, latency per call)                │
│   message_media_analysis (OCR, Vision, Transcription)               │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  OPERATIONS LAYER                                                    │
│                                                                      │
│   webhook_events (idempotency + replay)                             │
│   domain_events (append-only event store)                           │
│   outbox_events (transactional side effects)                        │
│   conversation_events (conversation state events)                   │
│   admin_audit_logs                                                   │
│   retention_policies                                                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Table Status Matrix

| # | Table | Migration | Status | Critical Notes |
|---|-------|-----------|--------|---------------|
| 1 | `companies` | 001 + 015 | ✅ Production ready | slug, status, plan_tier added |
| 2 | `projects` | 001 + 015 | ✅ Production ready | slug, status, not-null company_id |
| 3 | `profiles` | 001 + 015 | ✅ Production ready | GDPR columns added |
| 4 | `identities` | 001 + 015 | ⚠️ Type conflict pending | **MUST resolve id type = UUID before first INSERT** |
| 5 | `profile_projects` | nocodb | ✅ OK | junction table |
| 6 | `operators` | 014 | ✅ Production ready | |
| 7 | `operator_project_access` | 014 | ✅ Production ready | |
| 8 | `project_channels` | 004 + 015 | ⚠️ Encryption pending | Must encrypt credentials before go-live |
| 9 | `project_prompts` | 004 + 015 | ✅ Production ready | versioning added |
| 10 | `project_sla_policies` | 004 + 005 | ✅ OK | |
| 11 | `project_ai_settings` | 004 | ✅ OK | |
| 12 | `project_routing_rules` | 004 | ✅ OK | |
| 13 | `project_business_hours` | 004 + 014 | ✅ OK | holiday_calendar_id added |
| 14 | `project_holidays` | 004 | ✅ OK | |
| 15 | `project_mcp_permissions` | 004 | ✅ OK | |
| 16 | `project_feature_flags` | 004 | ✅ OK | |
| 17 | `company_holiday_calendars` | 014 | ✅ Production ready | |
| 18 | `company_holidays` | 014 | ✅ Production ready | |
| 19 | `conversations` | 001 + 014 | ✅ Production ready | needs updated_at trigger |
| 20 | `conversation_participants` | 014 + 015 | ✅ Production ready | group columns added |
| 21 | `conversation_handoffs` | 015 | ✅ Production ready | NEW |
| 22 | `takeover_sessions` | 014 | ✅ Production ready | |
| 23 | `messages` | 001 + 014 + 015 | ⚠️ Data corruption | Must fix existing content before RAG |
| 24 | `message_attachments` | 007 + 014 + 015 | ✅ Production ready | storage_key, cdn_url added |
| 25 | `message_media_analysis` | 015 | ✅ Production ready | NEW — OCR/Vision/Transcription |
| 26 | `internal_notes` | 014 | ✅ Production ready | |
| 27 | `webchat_sessions` | 007 | ⚠️ FK type pending | identity_id type must match identities.id |
| 28 | `tickets` | 001 + 004 + 006 + 010 + 011 + 014 + 015 | ✅ Production ready | SLA columns added |
| 29 | `ticket_events` | 010 | ✅ OK | |
| 30 | `ticket_embeddings` | 010 | ✅ OK | |
| 31 | `traces` | 001 + 014 | ✅ OK | project_id added |
| 32 | `ai_thinking_traces` | 014 | ✅ Production ready | |
| 33 | `ai_inference_logs` | 015 | ✅ Production ready | NEW — full cost/latency |
| 34 | `ai_memory` | 014 + 015 | ✅ Production ready | embedding_model added |
| 35 | `knowledge_documents` | 015 | ✅ Production ready | NEW (replaces doc_embeddings) |
| 36 | `knowledge_embeddings` | 015 | ✅ Production ready | NEW (split from doc_embeddings) |
| 37 | `document_embeddings` | 003 | ⚠️ Deprecated | Migrate data to knowledge_documents |
| 38 | `learning_samples` | 015 | ✅ Production ready | NEW — AI training pipeline |
| 39 | `webhook_events` | 015 | ✅ Production ready | NEW — idempotency + replay |
| 40 | `domain_events` | 015 | ✅ Production ready | NEW — append-only event store |
| 41 | `outbox_events` | 008 + 014 | ✅ Production ready | aggregate columns added |
| 42 | `conversation_events` | 008 | ✅ OK | |
| 43 | `admin_audit_logs` | 012 + 014 | ✅ OK | operator_id added |
| 44 | `retention_policies` | 015 | ✅ Production ready | NEW |

**Total tables after 015:** 44 tables

---

## Remaining Manual Actions (Cannot be automated in SQL)

```
MANUAL-1: identities.id type
  Action: Decide on UUID. Run 3-phase type migration:
    Phase 1: Add id_new UUID column, populate with gen_random_uuid()
    Phase 2: Update all FK columns (conversations.identity_id, etc.)
    Phase 3: Swap primary keys, drop old column

MANUAL-2: Encrypt project_channels credentials
  Action: Application code reads plaintext credentials,
          encrypts with AES-256-GCM, writes encrypted bytes,
          nulls out plaintext columns

MANUAL-3: Clean existing messages content
  Action: Write a one-time script to:
          - Parse JSON from messages.content where content starts with '{'
          - Extract the actual message text
          - Update messages.content to clean text only
          - Move raw JSON to messages.content_json

MANUAL-4: Migrate document_embeddings → knowledge_documents
  Action: Insert existing rows into knowledge_documents,
          copy embeddings to knowledge_embeddings,
          mark document_embeddings as deprecated
```

---

## AI Learning Architecture

```
DATA FLOW: Conversation → AI Learning

Customer sends message
    │
    ▼
webhook_events (raw payload stored with idempotency_key)
    │
    ▼
messages (clean content, message_type, sender)
    │
    ├── If media: message_attachments
    │                │
    │                ▼
    │           [async] message_media_analysis
    │           (OCR / Vision / Transcription result)
    │
    ▼
[conversation resolves or ticket closes]
    │
    ▼
learning_samples (curated training data)
    │
    ├── human_approved = TRUE
    │
    ▼
[AI fine-tuning pipeline / RAG ingestion]
    │
    ▼
knowledge_documents → knowledge_embeddings
(if resolution becomes knowledge base entry)
    │
    ▼
ai_memory (per-profile long-term facts)
```

---

## Event Taxonomy Reference

```
Domain Events (domain_events.event_type):

Conversation:
  conversation.created.v1
  conversation.message.received.v1
  conversation.message.sent.v1
  conversation.takeover.requested.v1
  conversation.takeover.acquired.v1
  conversation.takeover.released.v1
  conversation.takeover.expired.v1
  conversation.resolved.v1
  conversation.closed.v1

Ticket:
  ticket.created.v1
  ticket.status.changed.v1
  ticket.sla.breached.v1
  ticket.assigned.v1
  ticket.merged.v1
  ticket.closed.v1

Webhook:
  webhook.received.v1
  webhook.processed.v1
  webhook.failed.v1
  webhook.replayed.v1

AI:
  ai.inference.completed.v1
  ai.escalation.triggered.v1
  ai.tool.called.v1
  ai.guardrail.blocked.v1
  ai.knowledge.searched.v1

Knowledge:
  knowledge.document.created.v1
  knowledge.document.indexed.v1
  knowledge.document.updated.v1

Learning:
  learning.sample.created.v1
  learning.sample.approved.v1
  learning.training.completed.v1

System:
  system.webhook.retry.v1
  system.sla.check.v1
  system.cache.invalidated.v1
```

---

*Schema Map Version: Post-Migration 015*
*Last Updated: 2026-07-21*
*Status: FINAL — Architecture Frozen*
