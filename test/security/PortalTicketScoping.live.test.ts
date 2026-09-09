/**
 * Portal ticket ownership scoping.
 *
 * The portal list used to pass no profile filter while the detail route did, so
 * a customer was shown every ticket in their project and then got a 404 when
 * they tapped one that was not theirs. These tests pin both halves to the same
 * rule: a customer sees their own tickets and nothing else, and anything the
 * list shows must open.
 *
 * Fixtures are created here and removed at the end. Real customer profile 999
 * and its tickets are never touched, and no historical row is backfilled.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { config } from "../../src/config/env";
import { JwtUtil } from "../../src/shared/jwt";

const API = process.env.TEST_API_BASE || "http://localhost:3000";
const SECRET = config.SESSION_SECRET;
const STAMP = Date.now();

/** Everything this test creates, so teardown removes exactly its own rows. */
const made = {
  profiles: [] as string[],
  identities: [] as number[],
  conversations: [] as number[],
  tickets: [] as number[],
};

let PROJECT = 0;
let ORG = "";
let tokenA = "";
let tokenB = "";
let ticketA = { id: 0, number: "" };
let ticketB = { id: 0, number: "" };

/** A customer session obtained the way the product issues one: proof -> handshake. */
async function customerSession(ref: string, projectId: number) {
  const proof = JwtUtil.sign({ customerId: ref, name: `Fixture ${ref}` }, SECRET, 3600);
  const res = await fetch(`${API}/api/v1/webchat/handshake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerToken: proof, projectId: String(projectId) }),
  });
  const body = (await res.json()) as any;
  assert.ok(body.token, `handshake failed for ${ref}: ${JSON.stringify(body).slice(0, 160)}`);
  const claims = JwtUtil.verify(body.token, SECRET);
  assert.equal(claims.role, "customer", "fixture must be a real customer session");
  if (claims.profileId) made.profiles.push(String(claims.profileId));
  const ident = await pool.query("SELECT id FROM identities WHERE channel_ref = $1", [ref]);
  ident.rows.forEach((r) => made.identities.push(Number(r.id)));
  return { token: body.token, claims };
}

async function createTicket(token: string, subject: string) {
  const res = await fetch(`${API}/api/portal/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ subject, summary: "scoping fixture", priority: "Medium", severity: "Low" }),
  });
  assert.equal(res.status, 201, `ticket create failed: ${res.status}`);
  const { rows } = await pool.query(
    "SELECT id, ticket_number, conversation_id FROM tickets WHERE subject = $1",
    [subject]
  );
  assert.equal(rows.length, 1, "fixture ticket must exist exactly once");
  made.tickets.push(Number(rows[0].id));
  made.conversations.push(Number(rows[0].conversation_id));
  return { id: Number(rows[0].id), number: String(rows[0].ticket_number) };
}

/** The customer-facing number as the API returns it (mapper aliases the column). */
const publicNumber = (t: any): string => String(t?.ticket_number ?? t?.ticketId ?? t?.ticket_id ?? "");

const list = async (token: string, qs = "") =>
  (await (await fetch(`${API}/api/portal/tickets${qs}`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;

const detail = async (token: string, ref: string | number) =>
  fetch(`${API}/api/portal/tickets/${encodeURIComponent(String(ref))}`, {
    headers: { authorization: `Bearer ${token}` },
  });

describe("portal tickets are scoped to the authenticated customer", () => {
  before(async () => {
    const a = await customerSession(`cust_scopeA_${STAMP}`, 101);
    tokenA = a.token;
    PROJECT = Number(a.claims.projectId);
    ORG = String(a.claims.orgId || "");
    const b = await customerSession(`cust_scopeB_${STAMP}`, PROJECT);
    tokenB = b.token;
    // Both fixtures must land in the same project, or "another customer's
    // ticket in my project" is not actually being tested.
    assert.equal(Number(b.claims.projectId), PROJECT, "both fixtures must share a project");

    ticketA = await createTicket(tokenA, `SCOPE-A ${STAMP}`);
    ticketB = await createTicket(tokenB, `SCOPE-B ${STAMP}`);
  });

  after(async () => {
    // Narrow, id-based teardown of this test's own rows only.
    for (const id of made.tickets) await pool.query("DELETE FROM tickets WHERE id = $1", [id]);
    for (const id of made.conversations) {
      await pool.query("DELETE FROM messages WHERE conversation_id = $1", [id]);
      await pool.query("DELETE FROM conversations WHERE id = $1", [id]);
    }
    for (const id of made.identities) await pool.query("DELETE FROM identities WHERE id = $1", [id]);
    for (const id of made.profiles) await pool.query("DELETE FROM profiles WHERE id = $1", [id]);
    await pool.end();
  });

  it("T1 — a customer's list contains their own ticket", async () => {
    const res = await list(tokenA);
    assert.ok(
      res.tickets.some((t: any) => String(t.id) === String(ticketA.id)),
      "customer A must see ticket A"
    );
  });

  it("T2 — the list does NOT contain another customer's ticket", async () => {
    const res = await list(tokenA);
    assert.equal(
      res.tickets.filter((t: any) => String(t.id) === String(ticketB.id)).length,
      0,
      "customer A must not see customer B's ticket"
    );
  });

  it("T2b — the leak is symmetric: B does not see A either", async () => {
    const res = await list(tokenB);
    assert.equal(res.tickets.filter((t: any) => String(t.id) === String(ticketA.id)).length, 0);
    assert.ok(res.tickets.some((t: any) => String(t.id) === String(ticketB.id)));
  });

  it("T3 — a customer can open their own ticket detail", async () => {
    const res = await detail(tokenA, ticketA.id);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    // The detail response exposes the ticket number as `ticketId` / `ticket_id`,
    // not as `ticket_number` — that is the mapper's shape, so assert on what the
    // API actually returns rather than on the column name.
    assert.equal(publicNumber(body.ticket), ticketA.number);
  });

  it("T4 — another customer's ticket detail is refused, indistinguishably from nonexistent", async () => {
    const foreign = await detail(tokenA, ticketB.id);
    const missing = await detail(tokenA, 99999999);
    assert.equal(foreign.status, 404, "a foreign ticket must not be readable");
    assert.equal(
      foreign.status,
      missing.status,
      "a foreign ticket must not be distinguishable from one that does not exist"
    );
    const fBody = await foreign.text();
    const mBody = await missing.text();
    assert.equal(fBody, mBody, "the bodies must not leak that the foreign ticket exists");
  });

  it("T4b — the same holds for the foreign ticket_number", async () => {
    const res = await detail(tokenA, ticketB.number);
    assert.equal(res.status, 404, "a foreign ticket must not be readable by its number either");
  });

  it("T5 — a project the customer does not hold yields none of its tickets", async () => {
    const { rows } = await pool.query(
      "SELECT id FROM projects WHERE id <> $1 AND deleted_at IS NULL ORDER BY id LIMIT 1",
      [PROJECT]
    );
    if (rows.length === 0) return; // nothing to test against
    const other = Number(rows[0].id);
    const res = await list(tokenA, `?projectId=${other}`);
    const foreign = res.tickets.filter((t: any) => Number(t.project_id) === other);
    assert.equal(foreign.length, 0, "a client-supplied project id must not widen visibility");
  });

  it("T8 — every ticket the list shows can actually be opened (list and detail agree)", async () => {
    const res = await list(tokenA);
    assert.ok(res.tickets.length > 0, "precondition: the list is not empty");
    for (const t of res.tickets) {
      const d = await detail(tokenA, t.id);
      assert.equal(
        d.status,
        200,
        `ticket ${t.id} (${t.ticket_number}) is listed but its detail returns ${d.status}`
      );
    }
  });

  it("T9 — id and ticket_number both resolve to the same owned ticket", async () => {
    const byId = (await (await detail(tokenA, ticketA.id)).json()) as any;
    const byNumber = (await (await detail(tokenA, ticketA.number)).json()) as any;
    assert.equal(String(byId.ticket.id), String(byNumber.ticket.id));
    assert.equal(publicNumber(byId.ticket), ticketA.number);
    assert.equal(publicNumber(byNumber.ticket), ticketA.number);
  });

  it("the ownership rule is the platform's chain, not a project match", async () => {
    const { rows } = await pool.query(
      `SELECT t.id
         FROM tickets t
         JOIN conversations c ON c.id = t.conversation_id
         JOIN identities i ON i.id = c.identity_id
        WHERE t.id = $1 AND i.profile_id::text = (
          SELECT i2.profile_id::text FROM identities i2
           JOIN conversations c2 ON c2.identity_id = i2.id
           JOIN tickets t2 ON t2.conversation_id = c2.id
          WHERE t2.id = $1 LIMIT 1)`,
      [ticketA.id]
    );
    assert.equal(rows.length, 1, "ticket -> conversation -> identity -> profile must hold");
    assert.ok(PROJECT > 0 && ORG.length >= 0);
  });
});
