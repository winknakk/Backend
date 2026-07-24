# Architecture Validation, Fitness Functions & Production Checklist
## TicketX / PromptX Platform — Automated Governance & CI/CD Release Gates

```
Classification : ARCHITECTURE VALIDATION & FITNESS SPECIFICATION
Date           : 2026-07-21
Status         : APPROVED & AUTOMATED IN CI/CD PIPELINE
Target         : GitHub Actions / GitLab CI, ESLint, Dependency-Cruiser, Production Release Gate
```

---

# OUTPUT 7: ARCHITECTURE VALIDATION RULES (CI AUTOMATION)

The rules below are executed automatically during CI/CD build steps (`npm run test:arch`). Any violation fails the build immediately.

## 1. ESLint & Dependency-Cruiser Configuration Rules

### Rule ARCH-001: No Cross-Module Repository Imports
```javascript
// .dependency-cruiser.js configuration rule
{
  name: 'no-cross-module-repo-import',
  severity: 'error',
  comment: 'Modules MUST NOT import repository classes from another module.',
  from: { path: '^src/modules/([^/]+)' },
  to: {
    path: '^src/modules/((?!\x1).)*(/repositories/.*)',
    pathNot: '^src/modules/context-mapping'
  }
}
```

### Rule ARCH-002: No Direct Database Access Outside Repositories
```javascript
{
  name: 'no-db-access-outside-repositories',
  severity: 'error',
  comment: 'Database clients (Pool, Client, Knex, Kysely) can ONLY be imported inside repository files.',
  from: {
    path: '^src/modules',
    pathNot: '^src/modules/[^/]+/repositories/.*'
  },
  to: { path: '.*(database|knex|kysely|pg|typeorm).*' }
}
```

### Rule ARCH-003: No Domain Logic Inside Controllers
```javascript
{
  name: 'no-domain-logic-in-controllers',
  severity: 'error',
  comment: 'Controllers must ONLY call application services. No SQL, repository, or policy calls permitted.',
  from: { path: '^src/modules/[^/]+/controllers' },
  to: { path: '.*(repository|policy|calculator|knex|kysely).*' }
}
```

### Rule ARCH-004: No Circular Module Dependencies
```javascript
{
  name: 'no-circular-module-deps',
  severity: 'error',
  comment: 'Circular dependencies across top-level src/modules are forbidden.',
  from: { path: '^src/modules/([^/]+)' },
  to: { path: '^src/modules/(?!\\1)[^/]+', circular: true }
}
```

### Rule ARCH-005: AI Runtime Must NOT Access Database Directly
```javascript
{
  name: 'no-direct-db-in-ai-runtime',
  severity: 'error',
  comment: 'Agent Runtime and PromptX client must consume IssueSession DTOs, not DB Repositories.',
  from: { path: '^src/modules/ai/(services/agent.runtime|services/promptx.client)' },
  to: { path: '.*(repository|database|knex|kysely).*' }
}
```

---

# OUTPUT 8: ARCHITECTURE FITNESS FUNCTIONS

Architecture Fitness Functions are continuous automated checks executed in CI/CD and nightly builds to verify structural integrity.

```
┌────────────────────────────────────────────────────────────────────────┐
│                     AUTOMATED FITNESS FUNCTION MATRIX                  │
├───────────────────┬────────────────────────────┬───────────────────────┤
│ FITNESS FUNCTION  │ CHECK MECHANISM            │ FREQUENCY / TIMING    │
├───────────────────┼────────────────────────────┼───────────────────────┤
│ 1. Boundary Check │ Dependency-Cruiser CLI     │ Every Pull Request    │
├───────────────────┼────────────────────────────┼───────────────────────┤
│ 2. Schema Check   │ PostgreSQL Migration Linter│ Every Migration PR    │
├───────────────────┼────────────────────────────┼───────────────────────┤
│ 3. Event Check    │ Zod Schema Validation Test │ Every Build           │
├───────────────────┼────────────────────────────┼───────────────────────┤
│ 4. Service Cap    │ AST Line Count Auditor     │ Every Pull Request    │
├───────────────────┼────────────────────────────┼───────────────────────┤
│ 5. Tenant RLS     │ Automated Integration Test │ Nightly Build         │
└───────────────────┴────────────────────────────┴───────────────────────┘
```

## Fitness Function Implementations

### Fitness Function 1: AST Line Count Auditor (`scripts/audit-service-caps.ts`)
```typescript
import * as fs from 'fs';
import * as glob from 'glob';

const MAX_SERVICE_LINES = 300;
const serviceFiles = glob.sync('src/modules/**/*.service.ts');

let violations = 0;
for (const file of serviceFiles) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n').length;
  if (lines > MAX_SERVICE_LINES) {
    console.error(`❌ FITNESS VIOLATION: ${file} has ${lines} lines (Max: ${MAX_SERVICE_LINES}). Refactor into UseCases.`);
    violations++;
  }
}
if (violations > 0) process.exit(1);
```

### Fitness Function 2: Database Schema Ownership Auditor (`scripts/audit-schema-ownership.ts`)
```typescript
// Asserts every migration file only touches tables assigned to its context
import { TABLE_OWNERSHIP_MATRIX } from './matrix';

// Fails CI if a migration modifies a table belonging to another context without ADR approval
```

---

# OUTPUT 9: PRODUCTION RELEASE CHECKLIST

Every production release MUST satisfy 100% of the items below. The Release Engineer and Lead Architect must sign off prior to deployment.

```
┌────────────────────────────────────────────────────────────────────────┐
│                     PRODUCTION RELEASE GATE CHECKLIST                  │
└────────────────────────────────────────────────────────────────────────┘

[ ] 1. DATABASE & MIGRATIONS
    [ ] Migrations 001 through 016 have been executed cleanly on staging DB.
    [ ] `tickets.conversation_id` is verified NULLABLE.
    [ ] `conversation_ticket_links` table exists and contains backfilled links.
    [ ] AES-256-GCM encryption verified on `project_channels.secret_token_encrypted`.
    [ ] All multi-tenant queries include `WHERE project_id = $1`.

[ ] 2. BOUNDED CONTEXTS & MODULES
    [ ] Zero cross-module repository imports (ARCH-001 passed in CI).
    [ ] Zero circular dependencies (ARCH-004 passed in CI).
    [ ] `ContextMappingLayer` correctly resolves snapshots for `IssueSessionBuilder`.

[ ] 3. DOMAIN EVENTS & OUTBOX
    [ ] Transactional outbox triggers active on `outbox_events`.
    [ ] Event schema versioning (`.v1`) verified against Zod contracts.
    [ ] Dead Letter Queue (`dlq_events`) consumer tested and operational.

[ ] 4. AGENT AI & ISSUESESSION RUNTIME
    [ ] Verified NO `issue_sessions` table exists in PostgreSQL.
    [ ] `IssueSession` object is verified ephemeral (garbage-collected after turn).
    [ ] AI tool calls (`create_ticket`) execute via `SupportService` API.

[ ] 5. SECURITY & COMPLIANCE
    [ ] No plaintext credentials exist in `project_channels`.
    [ ] PII columns (`gdpr_erased_at`, `is_pii_erased`) verified on `profiles`.
    [ ] RBAC roles enforced on all public controller endpoints.

[ ] 6. PERFORMANCE & INDEXING
    [ ] `idx_conv_project_status_last` verified active for inbox queries.
    [ ] `idx_know_embed_ivfflat` vector search index active on `knowledge_embeddings`.
    [ ] DB connection pool limits configured (Max: 50 per replica).

[ ] 7. OBSERVABILITY & AUDIT
    [ ] `admin_audit_logs` capturing all administrative setting mutations.
    [ ] Correlation ID (`correlationId`) propagated across all HTTP headers and events.
    [ ] Application logs exported to centralized log engine.

[ ] 8. AUTOMATION & WORKFLOW
    [ ] `OutboxWorker` processing pending events with backoff retries.
    [ ] Webhook idempotency key verification tested against duplicate LINE webhooks.

RELEASE APPROVAL:
Lead Enterprise Architect: ______________________  Date: ______________
Lead Backend Engineer:    ______________________  Date: ______________
```

---

*Specification Approved & Automated: 2026-07-21*
*Target File: D:\Works Core\TicketX\system\Backend\database\latest\ARCHITECTURE_VALIDATION_AND_FITNESS.md*
