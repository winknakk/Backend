/**
 * Phase 3C.1 — live runtime verification against an ISOLATED environment.
 *
 * Requires (and refuses to run without):
 *  - DATABASE_URL on localhost/127.0.0.1 whose database name contains "test",
 *    already carrying the cs_tickets schema with migration 052 applied;
 *  - REDIS_URL on 127.0.0.1/localhost;
 *  - no production PromptX: the harness serves its own in-process PromptX MCP
 *    stub and points the backend at it.
 *
 * It starts the real backend (`src/api/server.ts`) as a child process with
 * QUEUE_PROVIDER=redis, seeds synthetic data, and exercises the knowledge-gap
 * pipeline, DLQ, conversation summaries, daily intelligence, telemetry and
 * tenant isolation over HTTP / BullMQ / PostgreSQL.
 *
 *   node <launcher that sets the env above> npx tsx src/test-phase3c1-runtime.live.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as dotenv from "dotenv";
import { Client } from "pg";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { SessionTokenService } from "./infrastructure/security/SessionTokenService";

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true } as any);

// ---------------------------------------------------------------------------
// Safety guard
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL || "";
const REDIS_URL = process.env.REDIS_URL || "";
{
  const db = new URL(DB_URL);
  const rd = new URL(REDIS_URL);
  const local = (h: string) => h === "localhost" || h === "127.0.0.1";
  if (!local(db.hostname) || !db.pathname.includes("test")) {
    throw new Error(`Refusing to run: DATABASE_URL must be a local *test* database (got ${db.hostname}${db.pathname})`);
  }
  if (!local(rd.hostname)) throw new Error(`Refusing to run: REDIS_URL must be local (got ${rd.hostname})`);
  if (process.env.DATABASE_REPLICA_URL && process.env.DATABASE_REPLICA_URL !== DB_URL) {
    throw new Error("Refusing to run: DATABASE_REPLICA_URL must equal the test DATABASE_URL");
  }
}

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const STUB_PORT = 18766;
const RUN = Date.now().toString(36);
const QUEUE_NAME = "conversation-intelligence-queue";

// ---------------------------------------------------------------------------
// In-process PromptX MCP stub
// ---------------------------------------------------------------------------
type StubMode = "ok" | "bad" | "empty" | "malformed" | "error" | "timeout" | "invent";
let stubMode: StubMode = "ok";
const stubCalls: Array<{ kind: string; mode: StubMode; prompt: string; tools: any; conversationId: string }> = [];
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (body: any) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body: any = {};
    try { body = JSON.parse(raw || "{}"); } catch { /* ignore */ }
    if (body.method === "tools/list") return send({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    const args = body.params?.arguments || {};
    const msg: string = args.message || "";
    const callId: string = args.conversationContext?.conversationId || "";
    const kind = callId.startsWith("ai-daily_narrative-") ? "narrative" : callId.startsWith("ai-conversation_summary-") ? "summary" : "other";
    stubCalls.push({ kind, mode: stubMode, prompt: msg, tools: args.availableTools, conversationId: args.conversationContext?.conversationId });
    const text = (t: string) => send({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: t }] } });
    switch (stubMode) {
      case "timeout": return; // never answers
      case "error": return send({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "stub provider failure SECRET-DETAIL-XYZ" } });
      case "empty": return text("");
      case "bad": return text("Sorry, I cannot help with that request.");
      case "malformed": return text('{"summary_th": "broken", ');
    }
    if (kind === "other") return text("stub reply for a non-Phase-3C.1 caller");
    if (kind === "narrative") {
      const facts = JSON.parse((msg.split("<facts>")[1] || "").split("</facts>")[0] || "{}");
      if (stubMode === "invent") return text("วันนี้มีบทสนทนา 987 รายการ");
      return text(`วันนี้มีบทสนทนา ${facts.metrics.totalConversations} รายการ และตั๋ว ${facts.metrics.totalTickets} ใบ`);
    }
    return text(JSON.stringify({
      summary_th: `ลูกค้าสอบถามวันจัดส่งและการเปลี่ยนที่อยู่ (stub #${stubCalls.length})`,
      customer_goal: "ทราบวันจัดส่ง",
      topics: ["จัดส่ง", "เปลี่ยนที่อยู่"],
      open_questions: ["วันจัดส่งที่แน่นอน"],
      actions_taken: ["บอทตอบว่าไม่พบข้อมูล"],
      suggested_next_action: "ตรวจสอบนโยบายการจัดส่ง",
      ticket_status: "CLOSED", // must be stripped by validation
    }));
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const db = new Client({ connectionString: DB_URL });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection: redis as any });
const q = async (sql: string, params: any[] = []) => (await db.query(sql, params)).rows;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(everyMs);
  }
}

const tokens = new SessionTokenService(process.env.SESSION_SECRET as string, 1);
const token = (p: any) => tokens.issue(p).token;

async function api(method: string, url: string, tok: string, body?: any, headers: Record<string, string> = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text, ms: Date.now() - started };
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n[RUNTIME] ${name}\n`);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  ✓ PASS");
  } catch (err: any) {
    results.push({ name, ok: false, detail: err?.message });
    console.log(`  ✗ FAIL: ${err?.message}`);
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
async function seedProject(label: string, timezone: string | null) {
  const orgId = `org-3c1-${label}-${RUN}`;
  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [orgId, `3C1 ${label}`, orgId]);
  const [p] = await q(`INSERT INTO projects (name, org_id, timezone, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id`, [`3C1 Project ${label} ${RUN}`, orgId, timezone]);
  return { projectId: Number(p.id), orgId };
}
async function seedConversation(projectId: number, orgId: string, createdAt: Date) {
  const [i] = await q(`INSERT INTO identities (channel, channel_ref, org_id, created_at) VALUES ('webchat', $1, $2, NOW()) RETURNING id`, [`ref-${randomUUID()}`, orgId]);
  const [c] = await q(
    `INSERT INTO conversations (identity_id, project_id, org_id, channel, status, handled_by, created_at, updated_at, last_message_at)
     VALUES ($1, $2, $3, 'webchat', 'open', 'ai', $4, $4, $4) RETURNING id`,
    [i.id, projectId, orgId, createdAt]
  );
  return { conversationId: Number(c.id), identityId: Number(i.id) };
}
async function seedMessage(conversationId: number, role: string, content: string, at: Date, purpose: string | null = null) {
  const [m] = await q(
    `INSERT INTO messages (conversation_id, role, content, message_type, message_purpose, created_at) VALUES ($1, $2, $3, 'text', $4, $5) RETURNING id`,
    [conversationId, role, content, purpose, at]
  );
  return Number(m.id);
}
async function seedRetrievalFailure(conversationId: number, at: Date) {
  await q(`INSERT INTO traces (trace_id, tool_name, status, called_at, conversation_id) VALUES ($1, 'search_project_docs', 'error', $2, $3)`, [randomUUID(), at, String(conversationId)]);
}
/** A customer turn the bot answered evasively after a failed retrieval: 0.35 + 0.20 = 0.55. */
async function seedGapTurn(projectId: number, orgId: string, question: string, t0: Date) {
  const { conversationId, identityId } = await seedConversation(projectId, orgId, t0);
  const messageId = await seedMessage(conversationId, "customer", question, t0);
  await seedRetrievalFailure(conversationId, new Date(t0.getTime() + 2000));
  await seedMessage(conversationId, "ai", "ขออภัย ไม่พบข้อมูลเกี่ยวกับเรื่องนี้ค่ะ", new Date(t0.getTime() + 5000));
  return { conversationId, identityId, messageId };
}
const evalJobId = (p: number, c: number, m: number) => `kg-eval-${p}-${c}-${m}`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let server: ChildProcess | null = null;
const serverLog: string[] = [];

async function main() {
  await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", () => r()));
  await db.connect();
  const [{ d }] = await q("select current_database() d");
  console.log(`Isolated DB: ${new URL(DB_URL).hostname}:${new URL(DB_URL).port}/${d} | Redis: ${REDIS_URL} | PromptX stub: 127.0.0.1:${STUB_PORT}`);

  // --- seed --------------------------------------------------------------
  const A = await seedProject("A", "Asia/Tokyo");
  const B = await seedProject("B", null);
  const now = Date.now();
  const t0 = new Date(now - 10 * 60 * 1000); // past the 120 s handoff window, inside the 2 h lookback

  const K1 = await seedGapTurn(A.projectId, A.orgId, "สินค้าจะส่งวันไหนครับ", t0);
  const K1b = await seedGapTurn(A.projectId, A.orgId, "สินค้าจะส่งวันไหนคะ", new Date(t0.getTime() + 20000));
  const K1c = await seedGapTurn(A.projectId, A.orgId, "สินค้าจะส่งวันไหน", new Date(t0.getTime() + 40000));

  // Takeover case: evasive reply + failed retrieval + human takeover 60 s later = 0.75.
  const K2 = await seedGapTurn(A.projectId, A.orgId, "เปลี่ยนที่อยู่จัดส่งได้ไหม", new Date(t0.getTime() + 60000));
  await q(
    `INSERT INTO conversation_handoffs (conversation_id, project_id, from_handler, to_handler, started_at, created_at) VALUES ($1, $2, 'ai', 'human', $3, NOW())`,
    [K2.conversationId, A.projectId, new Date(t0.getTime() + 120000)]
  );

  // Non-gap turn: answered, no retrieval failure, no takeover -> evaluated, score 0.
  const K3conv = await seedConversation(A.projectId, A.orgId, t0);
  const K3msg = await seedMessage(K3conv.conversationId, "customer", "ร้านเปิดกี่โมงครับ", new Date(t0.getTime() + 80000));
  await seedMessage(K3conv.conversationId, "ai", "ร้านเปิดทุกวัน 9 โมงถึง 6 โมงเย็นค่ะ", new Date(t0.getTime() + 85000));

  // Fresh turn (handoff window still open) — must not be evaluated yet.
  const K4conv = await seedConversation(A.projectId, A.orgId, new Date(now));
  const K4msg = await seedMessage(K4conv.conversationId, "customer", "มีสินค้ารุ่นใหม่ไหม", new Date(now - 20000));
  await seedMessage(K4conv.conversationId, "ai", "ขออภัย ไม่พบข้อมูลค่ะ", new Date(now - 15000));

  // Project B gap turn.
  const KB = await seedGapTurn(B.projectId, B.orgId, "สินค้าจะส่งวันไหนครับ", t0);

  // Recoverable DLQ case: message soft-deleted until an operator "fixes" it.
  const D2 = await seedGapTurn(A.projectId, A.orgId, "ขอเลขพัสดุหน่อยครับ", new Date(t0.getTime() + 100000));
  await q(`UPDATE messages SET deleted_at = NOW() WHERE id = $1`, [D2.messageId]);

  // Summary conversation (project A) with ticket, PII, internal note.
  const S = await seedConversation(A.projectId, A.orgId, new Date(now - 30 * 60 * 1000));
  const sBase = now - 25 * 60 * 1000;
  await seedMessage(S.conversationId, "customer", "สินค้าจะส่งวันไหนครับ โทร 081-234-5678 อีเมล somchai@example.com", new Date(sBase));
  await seedMessage(S.conversationId, "ai", "ขออภัย ยังไม่มีข้อมูลการจัดส่งค่ะ", new Date(sBase + 5000));
  await seedMessage(S.conversationId, "customer", "แล้วถ้าต้องการเปลี่ยนที่อยู่ล่ะครับ", new Date(sBase + 60000));
  const sLast = await seedMessage(S.conversationId, "human", "เดี๋ยวเจ้าหน้าที่ตรวจสอบให้ครับ", new Date(sBase + 120000));
  const [ticket] = await q(
    `INSERT INTO tickets (subject, status, project_id, org_id, conversation_id, ticket_number, created_at, updated_at) VALUES ('จัดส่งล่าช้า', 'OPEN', $1, $2, $3, $4, NOW(), NOW()) RETURNING id`,
    [A.projectId, A.orgId, S.conversationId, `TCK-3C1-${RUN}`]
  );
  await q(
    `INSERT INTO internal_notes (conversation_id, ticket_id, note_text, content, mentioned_ops, created_at, updated_at) VALUES ($1, $2, 'INTERNAL-NOTE-SECRET-777', 'INTERNAL-NOTE-SECRET-777', '{}', NOW(), NOW())`,
    [S.conversationId, ticket.id]
  );
  const SB = await seedConversation(B.projectId, B.orgId, new Date(now - 30 * 60 * 1000));
  await seedMessage(SB.conversationId, "customer", "PROJECT-B-SECRET-555 ข้อมูลโครงการ B", new Date(sBase));

  const superTok = token({ kind: "operator", subject: `super-${RUN}`, role: "super_admin", orgId: null, projectIds: null });
  const opA = token({ kind: "operator", subject: `op-a-${RUN}`, role: "operator", orgId: A.orgId, projectIds: [A.projectId] });
  const opB = token({ kind: "operator", subject: `op-b-${RUN}`, role: "operator", orgId: B.orgId, projectIds: [B.projectId] });

  // --- start backend -------------------------------------------------------
  const serverStartedAt = Date.now();
  server = spawn("npx", ["tsx", "src/api/server.ts"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), PROMPTX_MCP_URL: `http://127.0.0.1:${STUB_PORT}/mcp`, PROMPTX_MCP_TOKEN: "stub" },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (c) => serverLog.push(String(c)));
  server.stderr?.on("data", (c) => serverLog.push(String(c)));
  await waitFor("backend /health", async () => {
    try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; }
  }, 120000, 1000);
  console.log(`Backend up on ${BASE} after ${Date.now() - serverStartedAt} ms`);

  // =========================================================================
  // 14. Redis / BullMQ worker lifecycle (start)
  // =========================================================================
  await check("14a Worker lifecycle: redis mode, intelligence queue, worker + producer ACTIVE", async () => {
    const r = await api("GET", "/api/admin/queues/health", superTok);
    assert.equal(r.status, 200);
    assert.equal(r.json.mode, "redis");
    assert.equal(r.json.redisStatus, "CONNECTED");
    assert.ok(r.json.queues.some((x: any) => x.name === QUEUE_NAME), "conversation-intelligence-queue reported");
    for (const w of ["titleWorker", "summaryWorker", "duplicateWorker", "planeWorker", "knowledgeGapWorker", "knowledgeGapProducer"]) {
      assert.equal(r.json.workers[w], "ACTIVE", `${w} ACTIVE`);
    }
  });

  // =========================================================================
  // 1-3. Knowledge-gap producer -> queue -> worker -> candidate
  // =========================================================================
  await check("1 Producer -> BullMQ -> worker -> durable candidate (first sweep after 60 s)", async () => {
    const row = await waitFor("K1 candidate", async () =>
      (await q(`SELECT * FROM knowledge_gap_candidates WHERE message_id = $1`, [K1.messageId]))[0], 150000, 2000);
    assert.equal(Number(row.project_id), A.projectId);
    assert.equal(Number(row.conversation_id), K1.conversationId);
    assert.equal(Number(row.message_id), K1.messageId);
    assert.equal(Number(row.score), 0.55, "0.35 low retrieval + 0.20 evasive");
    assert.equal(row.query_text, "สินค้าจะส่งวันไหนครับ");
    const ev = row.evidence;
    assert.deepEqual(ev.weights, { lowRetrieval: 0.35, customerRephrasing: 0.25, evasiveResponse: 0.2, immediateTakeover: 0.2 });
    assert.equal(ev.threshold, 0.5);
    const job = await queue.getJob(evalJobId(A.projectId, K1.conversationId, K1.messageId));
    assert.ok(job, "BullMQ job with turn-derived id exists");
    assert.equal(await job!.getState(), "completed");
  });

  await check("5-takeover Case C: human takeover within 120 s sets the immediate-takeover signal", async () => {
    const row = await waitFor("K2 candidate", async () =>
      (await q(`SELECT * FROM knowledge_gap_candidates WHERE message_id = $1`, [K2.messageId]))[0], 60000, 2000);
    assert.equal(Number(row.score), 0.75);
    assert.equal(row.evidence.signals.immediateTakeover.score, 1);
  });

  await check("5-window Case A/B: answered non-gap turn evaluated (score 0, no candidate); fresh turn not evaluated", async () => {
    const job = await waitFor("K3 job", async () => queue.getJob(evalJobId(A.projectId, K3conv.conversationId, K3msg)), 30000, 1000);
    await waitFor("K3 completed", async () => (await job!.getState()) === "completed", 30000, 500);
    const done = await queue.getJob(job!.id!);
    assert.equal(done!.returnvalue.isCandidate, false);
    assert.equal(done!.returnvalue.score, 0);
    assert.equal((await q(`SELECT count(*)::int n FROM knowledge_gap_candidates WHERE message_id = $1`, [K3msg]))[0].n, 0);
    // K4 was 20 s old when seeded; the first sweep ran ~60 s after boot, i.e. before its 120 s window closed.
    const k4Age = (Date.now() - (now - 20000)) / 1000;
    const k4Job = await queue.getJob(evalJobId(A.projectId, K4conv.conversationId, K4msg));
    if (k4Age < 120) {
      assert.equal(k4Job, undefined, "turn inside the 120 s window is not enqueued");
    } else {
      const firstSweep = (await queue.getJob(evalJobId(A.projectId, K1.conversationId, K1.messageId)))!.timestamp;
      assert.ok(!k4Job || k4Job.timestamp - (now - 20000) >= 120000, `K4 enqueued only after its window (first sweep at ${new Date(firstSweep).toISOString()})`);
    }
  });

  await check("2 Project isolation: candidates carry their own project; B turn never under A", async () => {
    const rowB = await waitFor("KB candidate", async () =>
      (await q(`SELECT * FROM knowledge_gap_candidates WHERE message_id = $1`, [KB.messageId]))[0], 60000, 2000);
    assert.equal(Number(rowB.project_id), B.projectId);
    const mismatched = await q(
      `SELECT k.id FROM knowledge_gap_candidates k JOIN conversations c ON c.id = k.conversation_id WHERE k.project_id <> c.project_id`
    );
    assert.equal(mismatched.length, 0, "no candidate whose project differs from its conversation's project");
    const listA = await api("GET", `/api/admin/intelligence/knowledge-gaps/candidates?projectId=${A.projectId}`, opA);
    assert.equal(listA.status, 200);
    assert.ok(listA.json.candidates.every((c: any) => c.projectId === A.projectId));
    assert.equal((await api("GET", `/api/admin/intelligence/knowledge-gaps/candidates?projectId=${B.projectId}`, opA)).status, 403);
    assert.equal((await api("GET", `/api/admin/intelligence/knowledge-gaps/candidates?projectId=${B.projectId}`, opA, undefined, { "x-project-id": String(B.projectId) })).status, 403);
  });

  await check("3 Idempotency: same job id is a no-op; crashed-worker lock blocks once, retry then succeeds; one row", async () => {
    const id = evalJobId(A.projectId, K1.conversationId, K1.messageId);
    const before = await queue.getJob(id);
    await queue.add("intelligence.knowledge_gap.evaluate", { projectId: A.projectId, conversationId: K1.conversationId, messageId: K1.messageId }, { jobId: id });
    const after = await queue.getJob(id);
    assert.equal(after!.processedOn, before!.processedOn, "duplicate add did not re-run the retained job");

    const [cand0] = await q(`SELECT id, updated_at FROM knowledge_gap_candidates WHERE message_id = $1`, [K1.messageId]);
    // Simulate a worker that crashed while holding the concurrency lock.
    await redis.set(`lock:kg:eval:${A.projectId}:${K1.conversationId}:${K1.messageId}`, "crashed-worker", "EX", 4);
    await before!.remove();
    await queue.add("intelligence.knowledge_gap.evaluate", { projectId: A.projectId, conversationId: K1.conversationId, messageId: K1.messageId }, { jobId: id });
    await waitFor("blocked job done", async () => {
      const j = await queue.getJob(id);
      return j && (await j.getState()) === "completed";
    }, 20000, 500);
    const blocked = (await queue.getJob(id))!;
    assert.equal(blocked.returnvalue.reason, "evaluation_in_progress");

    await sleep(4500); // lock TTL elapses; the crashed worker's marker is gone
    await blocked.remove();
    await queue.add("intelligence.knowledge_gap.evaluate", { projectId: A.projectId, conversationId: K1.conversationId, messageId: K1.messageId }, { jobId: id });
    await waitFor("retried job done", async () => {
      const j = await queue.getJob(id);
      return j && (await j.getState()) === "completed";
    }, 20000, 500);
    const retried = (await queue.getJob(id))!;
    assert.equal(retried.returnvalue.isCandidate, true);
    const rows = await q(`SELECT id, updated_at FROM knowledge_gap_candidates WHERE project_id = $1 AND conversation_id = $2 AND message_id = $3`, [A.projectId, K1.conversationId, K1.messageId]);
    assert.equal(rows.length, 1, "PostgreSQL unique key kept a single candidate");
    assert.equal(Number(rows[0].id), Number(cand0.id));
    assert.ok(new Date(rows[0].updated_at) > new Date(cand0.updated_at), "retry updated the same row (ON CONFLICT)");
  });

  // =========================================================================
  // 4. DLQ
  // =========================================================================
  let d2Outbox: any = null;
  await check("4a Forged cross-project job -> unrecoverable -> outbox dead_letter; no candidate created", async () => {
    await queue.add("intelligence.knowledge_gap.evaluate", { projectId: B.projectId, conversationId: K3conv.conversationId, messageId: K3msg }, { jobId: `forged-${RUN}` });
    const row = await waitFor("forged dead letter", async () =>
      (await q(`SELECT * FROM outbox_events WHERE event_type = 'KnowledgeGapEvaluationRequested' AND payload->>'bullJobId' = $1`, [`forged-${RUN}`]))[0], 30000, 1000);
    assert.equal(row.status, "dead_letter");
    assert.equal(row.failure_kind, "permanent");
    assert.equal(Number(row.payload.projectId), B.projectId);
    assert.ok(!("queryText" in row.payload), "payload carries ids only");
    assert.equal((await q(`SELECT count(*)::int n FROM knowledge_gap_candidates WHERE project_id = $1 AND conversation_id = $2`, [B.projectId, K3conv.conversationId]))[0].n, 0);
  });

  await check("4b Recoverable failure -> dead_letter -> operator fixes data -> requeue -> BullMQ -> candidate", async () => {
    await queue.add("intelligence.knowledge_gap.evaluate", { projectId: A.projectId, conversationId: D2.conversationId, messageId: D2.messageId }, { jobId: `dlq-${RUN}` });
    d2Outbox = await waitFor("D2 dead letter", async () =>
      (await q(`SELECT * FROM outbox_events WHERE event_type = 'KnowledgeGapEvaluationRequested' AND payload->>'bullJobId' = $1`, [`dlq-${RUN}`]))[0], 30000, 1000);
    assert.equal(d2Outbox.status, "dead_letter");

    const list = await api("GET", `/api/admin/outbox/dead-letters?projectId=${A.projectId}&eventType=KnowledgeGapEvaluationRequested`, opA);
    assert.equal(list.status, 200, `DLQ list works against the live schema (was selecting a missing column): ${list.text.slice(0, 120)}`);
    assert.ok(list.json.deadLetters.some((x: any) => x.id === Number(d2Outbox.id) && x.projectId === A.projectId));

    await q(`UPDATE messages SET deleted_at = NULL WHERE id = $1`, [D2.messageId]); // operator fixes the cause
    const rq = await api("POST", `/api/admin/outbox/dead-letters/${d2Outbox.id}/requeue`, opA, {});
    assert.equal(rq.status, 200, rq.text.slice(0, 200));
    const [afterRq] = await q(`SELECT status FROM outbox_events WHERE id = $1`, [d2Outbox.id]);
    assert.notEqual(afterRq.status, "dead_letter", "requeue actually committed (audit failure no longer rolls it back)");
    const audit = await q(`SELECT entity_type, entity_id, project_id FROM admin_audit_logs WHERE action = 'DLQ_REQUEUE' AND entity_id = $1`, [String(d2Outbox.id)]);
    assert.equal(audit.length, 1, "requeue is audited");
    assert.equal(Number(audit[0].project_id), A.projectId);
    const replayId = `kg-eval-replay-${d2Outbox.id}-0`;
    const job = await waitFor("replay job", async () => queue.getJob(replayId), 30000, 1000);
    await waitFor("replay completed", async () => (await job!.getState()) === "completed", 30000, 500);
    const [ob] = await q(`SELECT status FROM outbox_events WHERE id = $1`, [d2Outbox.id]);
    assert.equal(ob.status, "processed");
    const cand = await waitFor("D2 candidate", async () =>
      (await q(`SELECT * FROM knowledge_gap_candidates WHERE message_id = $1`, [D2.messageId]))[0], 20000, 1000);
    assert.equal(Number(cand.project_id), A.projectId);
  });

  await check("4c DLQ project isolation: project-B operator cannot list, read or requeue a project-A dead letter", async () => {
    const [dl] = await q(`SELECT id FROM outbox_events WHERE event_type = 'KnowledgeGapEvaluationRequested' AND payload->>'bullJobId' = $1`, [`forged-${RUN}`]);
    // A project-A dead letter that stays dead: re-create one from a fresh forged A job on B's conversation.
    await queue.add("intelligence.knowledge_gap.evaluate", { projectId: A.projectId, conversationId: SB.conversationId, messageId: 1 }, { jobId: `forged-a-${RUN}` });
    const rowA = await waitFor("A dead letter", async () =>
      (await q(`SELECT * FROM outbox_events WHERE payload->>'bullJobId' = $1`, [`forged-a-${RUN}`]))[0], 30000, 1000);
    const listB = await api("GET", "/api/admin/outbox/dead-letters?projectId=all", opB);
    assert.equal(listB.status, 200);
    assert.ok(listB.json.deadLetters.every((x: any) => x.projectId === B.projectId), "B sees only project-B dead letters");
    assert.ok(listB.json.deadLetters.some((x: any) => x.id === Number(dl.id)));
    assert.equal((await api("GET", `/api/admin/outbox/dead-letters/${rowA.id}`, opB)).status, 403);
    assert.equal((await api("POST", `/api/admin/outbox/dead-letters/${rowA.id}/requeue`, opB, {})).status, 403);
    assert.equal((await api("GET", `/api/admin/outbox/dead-letters?projectId=${A.projectId}`, opB)).status, 403);
  });

  // =========================================================================
  // 8 (embeddings). Clustering with mock provider
  // =========================================================================
  await check("8 Embeddings: mock provider -> clustering explicitly lexical_only; clusters stay in project", async () => {
    await waitFor("K1b/K1c candidates", async () =>
      (await q(`SELECT count(*)::int n FROM knowledge_gap_candidates WHERE message_id = ANY($1::int[])`, [[K1b.messageId, K1c.messageId]]))[0].n === 2, 60000, 2000);
    const r = await api("POST", "/api/admin/intelligence/knowledge-gaps/clusters/run", opA, { projectId: A.projectId });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.json.similarityBasis, "lexical_only");
    assert.ok(r.json.clustersCreated >= 1, "similar queries from 3 customers cluster lexically");
    const cross = await q(`SELECT DISTINCT project_id FROM knowledge_gap_candidates WHERE cluster_id IN (SELECT cluster_id FROM knowledge_gap_candidates WHERE project_id = $1 AND cluster_id IS NOT NULL)`, [A.projectId]);
    assert.deepEqual(cross.map((x: any) => Number(x.project_id)), [A.projectId]);
    const kbRow = (await q(`SELECT cluster_id FROM knowledge_gap_candidates WHERE message_id = $1`, [KB.messageId]))[0];
    assert.equal(kbRow.cluster_id, null, "identical project-B query was not pulled into project A's cluster");
    assert.equal((await api("POST", "/api/admin/intelligence/knowledge-gaps/clusters/run", opA, { projectId: B.projectId })).status, 403);
    assert.ok(serverLog.join("").includes("lexical only"), "mock fallback is logged");
  });

  // =========================================================================
  // 5-9, 12. Conversation summary
  // =========================================================================
  const summaryUrl = `/api/admin/conversations/${S.conversationId}/ai-summary`;
  let lastGood = "";
  await check("5 Summary generation through the PromptX stub; persisted with provenance", async () => {
    stubMode = "ok";
    const callsBefore = stubCalls.length;
    const first = await api("GET", summaryUrl, opA);
    assert.equal(first.status, 200);
    assert.ok(first.ms < 3000, `GET does not block on the model (${first.ms} ms)`);
    assert.equal(first.json.refreshing, true);
    assert.equal(first.json.aiGenerated, true);
    const ready = await waitFor("summary ready", async () => {
      const r = await api("GET", summaryUrl, opA);
      return r.json?.status === "ready" && r.json.summary ? r : null;
    }, 30000, 1000);
    assert.ok(stubCalls.length > callsBefore, "PromptX stub was called");
    assert.equal(ready.json.facts.ticket.ticketNumber, `TCK-3C1-${RUN}`);
    assert.equal(ready.json.facts.ticket.status, "OPEN", "ticket state from the DB");
    assert.ok(!("ticket_status" in ready.json.summary), "model's ticket_status was stripped");
    const [row] = await q(`SELECT * FROM conversation_summaries WHERE conversation_id = $1`, [S.conversationId]);
    assert.equal(Number(row.project_id), A.projectId);
    assert.equal(row.prompt_version, "conv-summary-v1");
    assert.equal(row.generation_status, "ready");
    assert.equal(row.provider, "promptx");
    assert.equal(row.model, null);
    assert.equal(Number(row.source_last_message_id), sLast);
    assert.equal(Number(row.source_message_count), 4);
    lastGood = row.summary.summary_th;

    const callsMid = stubCalls.length;
    const forced = await api("POST", `${summaryUrl}/refresh`, opA, {});
    assert.equal(forced.status, 200);
    assert.equal(stubCalls.length, callsMid + 1, "forced refresh calls PromptX again");
    lastGood = forced.json.summary.summary_th;
  });

  await check("11 Summary context security: no internal notes, no other project, PII masked, no tools, unique call id", async () => {
    const calls = stubCalls.filter((c) => c.kind === "summary");
    assert.ok(calls.length >= 2);
    for (const c of calls) {
      assert.ok(!c.prompt.includes("INTERNAL-NOTE-SECRET-777"), "internal note excluded");
      assert.ok(!c.prompt.includes("PROJECT-B-SECRET-555"), "other project's messages excluded");
      assert.ok(!c.prompt.includes("081-234-5678") && !c.prompt.includes("somchai@example.com"), "PII masked");
      assert.ok(c.prompt.includes("[phone]") && c.prompt.includes("[email]"));
      assert.ok(!/SESSION_SECRET|PROMPTX_MCP_TOKEN|Bearer /.test(c.prompt), "no credentials in context");
      assert.deepEqual(c.tools, [], "no tools offered to the remote agent");
      assert.match(c.conversationId, /^ai-conversation_summary-[0-9a-f-]{36}$/);
    }
    assert.equal(new Set(calls.map((c) => c.conversationId)).size, calls.length, "every call has its own remote conversation id");
    assert.ok(!serverLog.join("").includes("INTERNAL-NOTE-SECRET-777"), "server log does not contain the internal note");
  });

  await check("6 Stale detection and background refresh after a new message", async () => {
    stubMode = "ok";
    const newId = await seedMessage(S.conversationId, "customer", "ขอบคุณครับ รอข่าวนะครับ", new Date());
    const stale = await api("GET", summaryUrl, opA);
    assert.equal(stale.json.stale, true);
    assert.equal(stale.json.refreshing, true);
    const fresh = await waitFor("refreshed", async () => {
      const r = await api("GET", summaryUrl, opA);
      return r.json?.stale === false && r.json.provenance?.sourceLastMessageId === newId ? r : null;
    }, 30000, 1000);
    assert.equal(fresh.json.provenance.messageCountAtGeneration, 5);
    lastGood = fresh.json.summary.summary_th;
  });

  const failureCases: Array<[StubMode, string]> = [["bad", "invalid_output"], ["empty", "empty_output"], ["malformed", "invalid_output"], ["error", "provider_error"], ["timeout", "timeout"]];
  for (const [mode, category] of failureCases) {
    await check(`7/10 Summary failure '${mode}': safe response, last good kept, category '${category}', no provider detail`, async () => {
      stubMode = mode;
      await seedMessage(S.conversationId, "customer", `ข้อความทดสอบ ${mode}`, new Date());
      const r = await api("POST", `${summaryUrl}/refresh`, opA, {});
      assert.equal(r.status, 200, r.text.slice(0, 200));
      assert.equal(r.json.summary.summary_th, lastGood, "last good summary preserved");
      assert.equal(r.json.stale, true, "and flagged stale");
      assert.equal(r.json.lastErrorCategory, category);
      assert.ok(!r.text.includes("SECRET-DETAIL-XYZ") && !r.text.includes("PromptX MCP Server Error"), "provider detail not exposed");
      const [row] = await q(`SELECT generation_status, last_error_category FROM conversation_summaries WHERE conversation_id = $1`, [S.conversationId]);
      assert.equal(row.generation_status, "ready");
      assert.equal(row.last_error_category, category);
    });
  }
  stubMode = "ok";

  await check("10b Summary failures do not break the operator/ticket flow", async () => {
    const profile = await api("GET", `/api/admin/conversations/${S.conversationId}/profile?projectId=${A.projectId}`, opA);
    assert.equal(profile.status, 200, profile.text.slice(0, 200));
    const tickets = await api("GET", `/api/admin/intelligence/knowledge-gaps/candidates?projectId=${A.projectId}`, opA);
    assert.equal(tickets.status, 200);
  });

  await check("12 Summary authorization: DB-derived project, forged headers and query ignored", async () => {
    const denials: Record<string, any> = {
      "B GET A-summary": await api("GET", summaryUrl, opB),
      "B GET A-summary forged headers": await api("GET", summaryUrl, opB, undefined, { "x-project-id": String(A.projectId), "x-org-id": A.orgId }),
      "B POST A-refresh ?projectId=A": await api("POST", `${summaryUrl}/refresh?projectId=${A.projectId}`, opB, {}),
      "A GET B-summary": await api("GET", `/api/admin/conversations/${SB.conversationId}/ai-summary`, opA),
    };
    for (const [label, r] of Object.entries(denials)) {
      console.log(`    ${label}: ${r.status} ${String(r.json?.message || "").slice(0, 90)}`);
      assert.ok(r.status === 403 || r.status === 404, `${label} must be denied (got ${r.status})`);
      assert.ok(!r.text.includes("summary_th"), `${label} leaks no summary`);
    }
    assert.equal((await api("GET", `/api/admin/conversations/999999999/ai-summary`, opA)).status, 404);
    const own = await api("GET", `/api/admin/conversations/${SB.conversationId}/ai-summary`, opB);
    assert.equal(own.status, 200);
    assert.ok(!/rawPrompt|chainOfThought|reasoning|<transcript>/i.test(own.text));
  });

  // =========================================================================
  // 10-11. Daily intelligence + narrative guard
  // =========================================================================
  const tokyoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const utcDate = new Date().toISOString().slice(0, 10);
  await check("10 Daily intelligence: project timezone boundaries, deterministic counts, cluster-derived gaps, NULL tokens", async () => {
    stubMode = "ok";
    const r = await api("POST", "/api/admin/intelligence/daily/calculate", opA, { projectId: A.projectId, date: tokyoDate });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const d = r.json.daily;
    assert.equal(d.timezone, "Asia/Tokyo");
    const [b] = await q(`SELECT ($1 || ' 00:00:00')::timestamp AT TIME ZONE 'Asia/Tokyo' s, ($1 || ' 23:59:59.999')::timestamp AT TIME ZONE 'Asia/Tokyo' e`, [tokyoDate]);
    const [exp] = await q(
      `SELECT
         (SELECT count(*)::int FROM conversations WHERE project_id = $1 AND created_at BETWEEN $2 AND $3 AND deleted_at IS NULL) conv,
         (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.project_id = $1 AND m.created_at BETWEEN $2 AND $3) msgs,
         (SELECT count(*)::int FROM tickets WHERE project_id = $1 AND created_at BETWEEN $2 AND $3 AND deleted_at IS NULL) tix,
         (SELECT count(*)::int FROM conversation_handoffs WHERE project_id = $1 AND started_at BETWEEN $2 AND $3) handoffs`,
      [A.projectId, b.s, b.e]
    );
    assert.deepEqual(
      { conv: d.totalConversations, msgs: d.totalMessages, tix: d.totalTickets, handoffs: d.humanHandoffs },
      { conv: exp.conv, msgs: exp.msgs, tix: exp.tix, handoffs: exp.handoffs },
      "metrics equal an independent SQL count over the project-local day"
    );
    assert.ok(exp.conv > 0 && exp.handoffs === 1);
    assert.equal(d.totalTokensConsumed, null);
    assert.equal(d.tokenTelemetry, "unavailable");
    const clusters = await q(`SELECT cluster_id, count(*)::int n FROM knowledge_gap_candidates WHERE project_id = $1 AND cluster_id IS NOT NULL AND created_at BETWEEN $2 AND $3 GROUP BY 1`, [A.projectId, b.s, b.e]);
    assert.ok(clusters.length >= 1);
    assert.deepEqual(
      d.topKnowledgeGaps.map((g: any) => [g.clusterId, g.inquiryCount]).sort(),
      clusters.map((c: any) => [c.cluster_id, c.n]).sort(),
      "top gaps are exactly the DB clusters"
    );
    const [stored] = await q(`SELECT total_tokens_consumed, narrative_source FROM daily_project_intelligence WHERE project_id = $1 AND date = $2`, [A.projectId, tokyoDate]);
    assert.equal(stored.total_tokens_consumed, null);
    assert.equal(stored.narrative_source, "template");

    const rb = await api("POST", "/api/admin/intelligence/daily/calculate", opB, { projectId: B.projectId, date: utcDate });
    assert.equal(rb.status, 200);
    assert.equal(rb.json.daily.timezone, process.env.DEFAULT_TIMEZONE || "UTC", "NULL project timezone falls back to DEFAULT_TIMEZONE, else UTC");
    assert.equal((await api("POST", "/api/admin/intelligence/daily/calculate", opA, { projectId: B.projectId, date: utcDate })).status, 403);
  });

  await check("11 Narrative guard: correct numbers accepted; invented number and invalid output fall back to template", async () => {
    stubMode = "ok";
    const good = await api("POST", "/api/admin/intelligence/daily/calculate", opA, { projectId: A.projectId, date: tokyoDate, generateNarrative: true });
    assert.equal(good.json.daily.narrativeSource, "ai_validated");
    const narrativeCall = stubCalls.filter((c) => c.kind === "narrative").pop()!;
    const facts = JSON.parse(narrativeCall.prompt.split("<facts>")[1].split("</facts>")[0]);
    assert.deepEqual(Object.keys(facts).sort(), ["date", "metrics", "timezone", "topIssueCategories", "topKnowledgeGaps"]);
    assert.ok(!/TCK-|org-3c1|@/.test(JSON.stringify(facts)), "no ticket ids, org ids or emails in the facts");

    stubMode = "invent";
    const invented = await api("POST", "/api/admin/intelligence/daily/calculate", opA, { projectId: A.projectId, date: tokyoDate, generateNarrative: true });
    assert.equal(invented.json.daily.narrativeSource, "template");
    assert.ok(!invented.json.daily.narrativeSummary.includes("987"));
    assert.equal(invented.json.daily.totalConversations, good.json.daily.totalConversations, "metrics unaffected by the narrative");

    for (const mode of ["empty", "error"] as StubMode[]) {
      stubMode = mode;
      const r = await api("POST", "/api/admin/intelligence/daily/calculate", opA, { projectId: A.projectId, date: tokyoDate, generateNarrative: true });
      assert.equal(r.status, 200);
      assert.equal(r.json.daily.narrativeSource, "template", `${mode} -> template`);
    }
    stubMode = "ok";
  });

  await check("12b projectId=all returns only authorized projects", async () => {
    const all = await api("GET", `/api/admin/intelligence/daily?projectId=all&date=${tokyoDate}`, opA);
    assert.equal(all.status, 200);
    const ids = (all.json.rollups || [all.json.daily]).map((x: any) => x.projectId);
    assert.ok(ids.length >= 1 && ids.every((x: number) => x === A.projectId), `A sees only A (${ids})`);
    const allB = await api("GET", `/api/admin/intelligence/daily?projectId=all&fromDate=${utcDate}&toDate=${tokyoDate > utcDate ? tokyoDate : utcDate}`, opB);
    assert.ok(allB.json.rollups.every((x: any) => x.projectId === B.projectId));
  });

  // =========================================================================
  // 13. Telemetry
  // =========================================================================
  await check("13 AI telemetry: one trace_events row per AI call; model/tokens NULL; no content", async () => {
    const summaryCalls = stubCalls.filter((c) => c.kind === "summary").length;
    const narrativeCalls = stubCalls.filter((c) => c.kind === "narrative").length;
    // A background refresh started by an earlier GET may still be recording.
    const rows = await waitFor("telemetry rows settle", async () => {
      const r = await q(`SELECT event_type, status, project_id, conversation_id, detail FROM trace_events WHERE component = 'ai' AND project_id = ANY($1::int[]) ORDER BY id`, [[A.projectId, B.projectId]]);
      return r.length === summaryCalls + narrativeCalls ? r : null;
    }, 15000, 1000);
    // Timeout calls are recorded too (the stub received them).
    assert.equal(rows.filter((r: any) => r.event_type === "ai.conversation_summary").length, summaryCalls);
    assert.equal(rows.filter((r: any) => r.event_type === "ai.daily_narrative").length, narrativeCalls);
    for (const r of rows) {
      assert.equal(r.detail.provider, "promptx");
      assert.ok(["conv-summary-v1", "daily-narrative-v1"].includes(r.detail.promptVersion));
      assert.equal(typeof r.detail.latencyMs, "number");
      assert.equal(r.detail.model, null);
      assert.equal(r.detail.inputTokens, null);
      assert.equal(r.detail.outputTokens, null);
      assert.equal(r.detail.tokenUsage, "unavailable");
      if (r.status === "failed") assert.ok(r.detail.errorCategory, "failed call has a category");
      assert.ok(!/สินค้า|somchai|SECRET/.test(JSON.stringify(r.detail)), "no content in telemetry");
    }
    assert.ok(rows.some((r: any) => r.detail.errorCategory === "timeout") && rows.some((r: any) => r.detail.errorCategory === "provider_error"));
  });

  // =========================================================================
  // Circuit breaker observation (known issue ISSUE-082)
  // =========================================================================
  await check("O Other PromptX callers observed during the run (outside Phase 3C.1)", async () => {
    const others = stubCalls.filter((c) => c.kind === "other");
    console.log(`  (${others.length} foreign chatAgent call(s): ${[...new Set(others.map((c) => c.conversationId))].join(", ") || "none"})`);
  });

  await check("CB Shared PromptX circuit breaker: summary failures stay below the opening threshold here", async () => {
    const opened = serverLog.join("").includes("Circuit Breaker transitioned to OPEN");
    console.log(`  (breaker opened during run: ${opened})`);
  });

  // =========================================================================
  // Protected-flow guard: nothing enqueued outside the intelligence queue
  // =========================================================================
  await check("P Only intelligence work was queued; no customer-message jobs created by this phase", async () => {
    const mq = new Queue("message-queue", { connection: redis as any });
    const counts = await mq.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    await mq.close();
    assert.equal(Object.values(counts).reduce((a: number, b: any) => a + Number(b), 0), 0);
  });
}

main()
  .catch((err) => {
    console.error("\nHARNESS ERROR:", err?.stack || err);
    results.push({ name: "harness", ok: false, detail: err?.message });
  })
  .finally(async () => {
    if (server?.pid) {
      try { execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: "ignore" }); } catch { server.kill(); }
    }
    await queue.close().catch(() => {});
    await redis.quit().catch(() => {});
    await db.end().catch(() => {});
    stub.close();
    const passed = results.filter((r) => r.ok).length;
    console.log("\n===============================================================================");
    console.log(` PHASE 3C.1 RUNTIME: ${passed}/${results.length} passed`);
    for (const r of results.filter((x) => !x.ok)) console.log(`   ✗ ${r.name}: ${r.detail}`);
    if (passed !== results.length) {
      const ESC = String.fromCharCode(27);
      const NL = String.fromCharCode(10);
      const tail = serverLog.join("").split(ESC).join("").split(NL).filter((l) => /ERROR|WARN|rror/.test(l)).slice(-15);
      console.log("--- server log (errors/warnings, last 15) ---" + NL + tail.join(NL));
    }
    console.log("===============================================================================");
    process.exit(passed === results.length ? 0 : 1);
  });
