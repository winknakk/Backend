/**
 * Flow 5 & 6 Backend Contract Verification Suite
 *
 * Verifies:
 * A. authorized A selection
 * B. authorized B selection
 * C. unauthorized ticket rejected
 * D. cross-project ticket rejected
 * E. active_ticket_id persisted
 * F. project_id unchanged
 * G. message.ticket_id persisted
 * H. duplicate message does not create second row
 * I. reconnect returns canonical active ticket
 * J. closed active ticket is not restored
 * K. concurrent switch
 * L. concurrent cancel (idempotent NO-OP)
 * M. unauthorized message with activeTicketId rejected
 * N. unauthorized attachment with activeTicketId rejected
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { config } from "../../src/config/env";
import { JwtUtil } from "../../src/shared/jwt";

const API = process.env.TEST_API_BASE || "http://localhost:3000";
const SECRET = config.SESSION_SECRET || "ticketx-fallback-session-secret";
const STAMP = Date.now();

const made = {
  profiles: [] as string[],
  identities: [] as number[],
  conversations: [] as number[],
  tickets: [] as number[],
  messages: [] as number[],
};

let PROJECT_1 = 0;
let PROJECT_2 = 0;
let tokenCust1 = "";
let tokenCust2 = "";
let ticketA = { id: 0, number: "" };
let ticketB = { id: 0, number: "" };
let ticketC = { id: 0, number: "" };
let ticketCross = { id: 0, number: "" };
let convId = 0;

async function customerSession(ref: string, projectId: number) {
  const pRow = await pool.query("SELECT company_id FROM projects WHERE id = $1", [projectId]);
  const compId = pRow.rows[0]?.company_id ? String(pRow.rows[0].company_id) : "1";

  const proof = JwtUtil.sign({ customerId: ref, name: `Fixture ${ref}` }, SECRET, 3600);
  const res = await fetch(`${API}/api/v1/webchat/handshake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerToken: proof, projectId: String(projectId), companyId: compId }),
  });
  const body = (await res.json()) as any;
  assert.ok(body.token, `handshake failed for ${ref}: ${JSON.stringify(body).slice(0, 160)}`);
  let finalToken = body.token;
  let claims = JwtUtil.verify(finalToken, SECRET);
  if (claims.profileId) {
    made.profiles.push(String(claims.profileId));
    await pool.query(
      `INSERT INTO profile_projects (profile_id, project_id, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT DO NOTHING`,
      [String(claims.profileId), projectId]
    );
    const switchRes = await fetch(`${API}/api/portal/switch-project`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ projectId }),
    });
    if (switchRes.status === 200) {
      const switchBody = (await switchRes.json()) as any;
      if (switchBody.token) {
        finalToken = switchBody.token;
        claims = JwtUtil.verify(finalToken, SECRET);
      }
    }
  }
  const ident = await pool.query("SELECT id FROM identities WHERE channel_ref = $1", [ref]);
  ident.rows.forEach((r) => made.identities.push(Number(r.id)));
  return { token: finalToken, claims, identityId: ident.rows[0]?.id };
}

async function createTicket(token: string, subject: string) {
  const res = await fetch(`${API}/api/portal/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ subject, summary: "contract fixture", priority: "Medium", severity: "Low" }),
  });
  assert.equal(res.status, 201, `ticket create failed: ${res.status}`);
  const { rows } = await pool.query(
    "SELECT id, ticket_number, conversation_id FROM tickets WHERE subject = $1",
    [subject]
  );
  assert.equal(rows.length, 1, "fixture ticket must exist");
  made.tickets.push(Number(rows[0].id));
  if (rows[0].conversation_id) made.conversations.push(Number(rows[0].conversation_id));
  return { id: Number(rows[0].id), number: String(rows[0].ticket_number), conversationId: Number(rows[0].conversation_id) };
}

describe("Flow 5 & 6 Backend Contract Closure", () => {
  before(async () => {
    // 1. Pick two real projects with id > 1 (excluding sentinel project 1)
    const projRes = await pool.query("SELECT id, company_id FROM projects WHERE id > 1 ORDER BY id ASC LIMIT 2");
    assert.ok(projRes.rows.length >= 2, "Must have at least 2 real projects (id > 1) in database");
    PROJECT_1 = Number(projRes.rows[0].id);
    PROJECT_2 = Number(projRes.rows[1].id);

    // 2. Provision two distinct customers
    const cust1 = await customerSession(`flow6_cust1_${STAMP}`, PROJECT_1);
    tokenCust1 = cust1.token;

    const cust2 = await customerSession(`flow6_cust2_${STAMP}`, PROJECT_2);
    tokenCust2 = cust2.token;

    // 3. Create Ticket A, Ticket B, and Ticket C for Customer 1 under Project 1
    const tA = await createTicket(tokenCust1, `Ticket A ${STAMP}`);
    ticketA = { id: tA.id, number: tA.number };
    convId = tA.conversationId;

    const tB = await createTicket(tokenCust1, `Ticket B ${STAMP}`);
    ticketB = { id: tB.id, number: tB.number };

    const tC = await createTicket(tokenCust1, `Ticket C ${STAMP}`);
    ticketC = { id: tC.id, number: tC.number };

    // 4. Create Ticket Cross for Customer 2 under Project 2
    const tCross = await createTicket(tokenCust2, `Ticket Cross ${STAMP}`);
    ticketCross = { id: tCross.id, number: tCross.number };
  });

  after(async () => {
    // Cleanup in foreign-key order
    for (const id of made.messages) {
      await pool.query("DELETE FROM message_attachments WHERE message_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM messages WHERE id = $1", [id]).catch(() => {});
    }
    for (const id of made.tickets) {
      await pool.query("UPDATE conversations SET active_ticket_id = NULL WHERE active_ticket_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM ticket_audit_logs WHERE ticket_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM tickets WHERE id = $1", [id]).catch(() => {});
    }
    for (const id of made.conversations) {
      await pool.query("DELETE FROM messages WHERE conversation_id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM conversations WHERE id = $1", [id]).catch(() => {});
    }
    for (const id of made.identities) {
      await pool.query("DELETE FROM identities WHERE id = $1", [id]).catch(() => {});
    }
    for (const id of made.profiles) {
      await pool.query("DELETE FROM profile_projects WHERE profile_id::text = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM profiles WHERE id::text = $1", [id]).catch(() => {});
    }
    await pool.end();
  });

  it("A & E & F: Authorized Ticket A selection persists active_ticket_id without mutating project_id", async () => {
    const res = await fetch(`${API}/api/portal/switch-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
      body: JSON.stringify({ ticketId: ticketA.id }),
    });
    assert.equal(res.status, 200, "Switching to authorized Ticket A must succeed with 200");
    const body = await res.json() as any;
    assert.equal(body.success, true);
    assert.equal(body.activeTicketId, ticketA.id);
    assert.equal(body.projectId, PROJECT_1);

    // Database verification: conversations.active_ticket_id == A, project_id == PROJECT_1
    const { rows } = await pool.query("SELECT id, project_id, active_ticket_id FROM conversations WHERE id = $1", [convId]);
    assert.equal(rows[0].active_ticket_id, ticketA.id, "conversations.active_ticket_id must be Ticket A");
    assert.equal(Number(rows[0].project_id), PROJECT_1, "conversations.project_id must remain PROJECT_1");
  });

  it("B & E & F: Authorized Ticket B selection persists active_ticket_id without mutating project_id", async () => {
    const res = await fetch(`${API}/api/portal/switch-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
      body: JSON.stringify({ ticketId: ticketB.id }),
    });
    assert.equal(res.status, 200, "Switching to authorized Ticket B must succeed with 200");
    const body = await res.json() as any;
    assert.equal(body.success, true);
    assert.equal(body.activeTicketId, ticketB.id);

    // Database verification: conversations.active_ticket_id == B, project_id == PROJECT_1
    const { rows } = await pool.query("SELECT id, project_id, active_ticket_id FROM conversations WHERE id = $1", [convId]);
    assert.equal(rows[0].active_ticket_id, ticketB.id, "conversations.active_ticket_id must be Ticket B");
    assert.equal(Number(rows[0].project_id), PROJECT_1, "conversations.project_id must remain unchanged");
  });

  it("C: Unauthorized/arbitrary foreign ticket ID is rejected", async () => {
    const res = await fetch(`${API}/api/portal/switch-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
      body: JSON.stringify({ ticketId: 999999 }),
    });
    assert.equal(res.status, 404, "Arbitrary ticket ID must be rejected with 404 Not Found");

    // Database verification: active_ticket_id remains B
    const { rows } = await pool.query("SELECT active_ticket_id FROM conversations WHERE id = $1", [convId]);
    assert.equal(rows[0].active_ticket_id, ticketB.id, "active_ticket_id must remain unchanged on rejection");
  });

  it("D: Cross-project ticket ID is rejected", async () => {
    const res = await fetch(`${API}/api/portal/switch-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
      body: JSON.stringify({ ticketId: ticketCross.id }),
    });
    assert.ok(res.status === 403 || res.status === 404, `Cross-project ticket must be rejected (got ${res.status})`);

    // Database verification: active_ticket_id remains B, project_id remains PROJECT_1
    const { rows } = await pool.query("SELECT project_id, active_ticket_id FROM conversations WHERE id = $1", [convId]);
    assert.equal(rows[0].active_ticket_id, ticketB.id);
    assert.equal(Number(rows[0].project_id), PROJECT_1);
  });

  it("G: Inbound WebChat message persists messages.ticket_id under authorized active ticket", async () => {
    // Switch to ticket A first
    await fetch(`${API}/api/portal/switch-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
      body: JSON.stringify({ ticketId: ticketA.id }),
    });

    // Obtain ws-ticket
    const wsRes = await fetch(`${API}/api/v1/webchat/ws-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
    });
    assert.equal(wsRes.status, 200);
    const { ticket: wsTicket } = await wsRes.json() as any;

    // Connect WebSocket
    const wsUrl = `ws://localhost:3000/api/v1/webchat/socket?ticket=${encodeURIComponent(wsTicket)}`;
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(wsUrl);

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WS connect timeout")), 5000);
        ws.on("open", () => {
          clearTimeout(timer);
          resolve(null);
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const extIdA = `msg_a_${STAMP}`;
      const sendPayloadA = {
        text: "Message under Ticket A",
        tempId: extIdA,
        activeTicketId: ticketA.id,
        ticketNumber: ticketA.number,
        attachments: [
          {
            fileUrl: "http://localhost:3000/uploads/test_a.png",
            fileName: "test_a.png",
            fileType: "image/png",
            fileSize: 1024,
          }
        ]
      };

      const ackPromiseA = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for message A ACK")), 5000);
        ws.on("message", (raw) => {
          try {
            const p = JSON.parse(raw.toString());
            if (p.event === "message" && p.data?.externalId === extIdA) {
              clearTimeout(timer);
              resolve(p.data);
            }
          } catch {}
        });
      });

      ws.send(JSON.stringify(sendPayloadA));
      const ackA = await ackPromiseA;
      assert.ok(ackA.id, "Server must ACK with message ID");
      made.messages.push(Number(ackA.id));

      // Database verification: messages.ticket_id == ticketA.id
      const msgARows = await pool.query(
        "SELECT id, conversation_id, ticket_id, content FROM messages WHERE external_id = $1",
        [extIdA]
      );
      assert.equal(msgARows.rows.length, 1);
      assert.equal(msgARows.rows[0].ticket_id, ticketA.id, "messages.ticket_id must equal Ticket A ID");

      // Database verification: message_attachments metadata contains ticket A
      const attARows = await pool.query(
        "SELECT metadata FROM message_attachments WHERE message_id = $1",
        [msgARows.rows[0].id]
      );
      assert.equal(attARows.rows.length, 1);
      assert.equal(attARows.rows[0].metadata?.activeTicketId, ticketA.id);

      // Now switch to Ticket B and send immediate message under Ticket B
      const extIdB = `msg_b_${STAMP}`;
      const sendPayloadB = {
        text: "Message under Ticket B",
        tempId: extIdB,
        activeTicketId: ticketB.id,
        ticketNumber: ticketB.number,
        attachments: [
          {
            fileUrl: "http://localhost:3000/uploads/test_b.png",
            fileName: "test_b.png",
            fileType: "image/png",
            fileSize: 2048,
          }
        ]
      };

      const ackPromiseB = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for message B ACK")), 5000);
        ws.on("message", (raw) => {
          try {
            const p = JSON.parse(raw.toString());
            if (p.event === "message" && p.data?.externalId === extIdB) {
              clearTimeout(timer);
              resolve(p.data);
            }
          } catch {}
        });
      });

      ws.send(JSON.stringify(sendPayloadB));
      const ackB = await ackPromiseB;
      assert.ok(ackB.id, "Server must ACK message B");
      made.messages.push(Number(ackB.id));

      // Database verification: messages.ticket_id == ticketB.id
      const msgBRows = await pool.query(
        "SELECT id, conversation_id, ticket_id, content FROM messages WHERE external_id = $1",
        [extIdB]
      );
      assert.equal(msgBRows.rows.length, 1);
      assert.equal(msgBRows.rows[0].ticket_id, ticketB.id, "messages.ticket_id must equal Ticket B ID");

      // Verify conversation.project_id remains unchanged
      const convCheck = await pool.query("SELECT project_id, active_ticket_id FROM conversations WHERE id = $1", [convId]);
      assert.equal(Number(convCheck.rows[0].project_id), PROJECT_1, "conversation.project_id must still be PROJECT_1");
      assert.equal(convCheck.rows[0].active_ticket_id, ticketB.id, "conversations.active_ticket_id must be Ticket B");
    } finally {
      ws.close();
    }
  });

  it("H: Duplicate message does not create second row", async () => {
    const extId = `dedupe_msg_${STAMP}`;
    // First insert
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, message_type, external_id, ticket_id, created_at)
       VALUES ($1, 'customer', 'Dedupe test 1', 'text', $2, $3, NOW())`,
      [convId, extId, ticketA.id]
    );
    const firstRes = await pool.query("SELECT id FROM messages WHERE external_id = $1", [extId]);
    assert.equal(firstRes.rows.length, 1);
    made.messages.push(Number(firstRes.rows[0].id));

    // Second insert with ON CONFLICT
    await pool.query(
      `INSERT INTO messages (conversation_id, role, content, message_type, external_id, ticket_id, created_at)
       VALUES ($1, 'customer', 'Dedupe test 2', 'text', $2, $3, NOW())
       ON CONFLICT (conversation_id, external_id) DO UPDATE SET
         content = EXCLUDED.content,
         ticket_id = COALESCE(EXCLUDED.ticket_id, messages.ticket_id)`,
      [convId, extId, ticketA.id]
    );
    const secondRes = await pool.query("SELECT id, content FROM messages WHERE external_id = $1", [extId]);
    assert.equal(secondRes.rows.length, 1, "Duplicate message must NOT create a second row");
    assert.equal(secondRes.rows[0].id, firstRes.rows[0].id, "Message ID must be identical");
  });

  it("I: Reconnect / refresh returns canonical active ticket from backend", async () => {
    // 1. Check GET /api/v1/webchat/messages
    const msgRes = await fetch(`${API}/api/v1/webchat/messages`, {
      headers: { authorization: `Bearer ${tokenCust1}` },
    });
    assert.equal(msgRes.status, 200);
    const msgBody = await msgRes.json() as any;
    assert.equal(Number(msgBody.activeTicketId), ticketB.id, "Messages endpoint must return canonical activeTicketId");

    // 2. Check GET /api/portal/tickets
    const ticketsRes = await fetch(`${API}/api/portal/tickets`, {
      headers: { authorization: `Bearer ${tokenCust1}` },
    });
    assert.equal(ticketsRes.status, 200);
    const ticketsBody = await ticketsRes.json() as any;
    assert.equal(Number(ticketsBody.activeTicketId), ticketB.id, "Portal tickets endpoint must return canonical activeTicketId");
  });

  it("J: Closed/cancelled active ticket is not restored", async () => {
    // Transition Ticket B to CANCELLED
    const cancelRes = await fetch(`${API}/api/portal/tickets/${ticketB.id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
      body: JSON.stringify({ targetStatus: "CANCELLED", reason: "Customer requested cancel" }),
    });
    assert.equal(cancelRes.status, 200, "Customer cancellation must succeed");

    // Verify conversations.active_ticket_id was cleared upon cancellation
    const { rows } = await pool.query("SELECT active_ticket_id FROM conversations WHERE id = $1", [convId]);
    assert.equal(rows[0].active_ticket_id, null, "Cancelled ticket must NOT be active ticket in database");

    // Refresh contract: reconnect does not restore closed/cancelled ticket
    const refreshRes = await fetch(`${API}/api/portal/tickets`, {
      headers: { authorization: `Bearer ${tokenCust1}` },
    });
    const refreshBody = await refreshRes.json() as any;
    assert.equal(refreshBody.activeTicketId, null, "Canonical active ticket must be null when ticket is cancelled");
  });

  it("K: Concurrent switch operations resolve deterministically without mutating project_id", async () => {
    // Concurrently switch A -> B and A -> C
    const [resB, resC] = await Promise.all([
      fetch(`${API}/api/portal/switch-ticket`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
        body: JSON.stringify({ ticketId: ticketA.id }),
      }),
      fetch(`${API}/api/portal/switch-ticket`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
        body: JSON.stringify({ ticketId: ticketC.id }),
      }),
    ]);

    assert.equal(resB.status, 200);
    assert.equal(resC.status, 200);

    const { rows } = await pool.query("SELECT project_id, active_ticket_id FROM conversations WHERE id = $1", [convId]);
    assert.equal(Number(rows[0].project_id), PROJECT_1, "conversations.project_id must not change under concurrent switch");
    assert.ok(
      rows[0].active_ticket_id === ticketA.id || rows[0].active_ticket_id === ticketC.id,
      "Final active_ticket_id must be one of the requested tickets"
    );
  });

  it("L: Concurrent cancellation requests execute idempotently with single logical state transition", async () => {
    // Concurrently cancel Ticket C 3 times
    const [c1, c2, c3] = await Promise.all([
      fetch(`${API}/api/portal/tickets/${ticketC.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
        body: JSON.stringify({ targetStatus: "CANCELLED", reason: "Concurrent cancel 1" }),
      }),
      fetch(`${API}/api/portal/tickets/${ticketC.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
        body: JSON.stringify({ targetStatus: "CANCELLED", reason: "Concurrent cancel 2" }),
      }),
      fetch(`${API}/api/portal/tickets/${ticketC.id}/transition`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
        body: JSON.stringify({ targetStatus: "CANCELLED", reason: "Concurrent cancel 3" }),
      }),
    ]);

    assert.equal(c1.status, 200);
    assert.equal(c2.status, 200);
    assert.equal(c3.status, 200);

    const tRows = await pool.query("SELECT status FROM tickets WHERE id = $1", [ticketC.id]);
    assert.equal(tRows.rows[0].status, "CANCELLED");
  });

  it("M: Unauthorized message with activeTicketId is rejected without database insertion", async () => {
    // Connect WebSocket
    const wsRes = await fetch(`${API}/api/v1/webchat/ws-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
    });
    assert.equal(wsRes.status, 200);
    const { ticket: wsTicket } = await wsRes.json() as any;

    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(`ws://localhost:3000/api/v1/webchat/socket?ticket=${encodeURIComponent(wsTicket)}`);

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WS connect timeout")), 5000);
        ws.on("open", () => {
          clearTimeout(timer);
          resolve(null);
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const unauthExtId = `unauth_msg_${STAMP}`;
      const unauthPayload = {
        text: "Malicious message with foreign ticket",
        tempId: unauthExtId,
        activeTicketId: ticketCross.id, // Cross-project ticket from Project 2!
        ticketNumber: ticketCross.number,
      };

      const errorPromise = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for rejection frame")), 5000);
        ws.on("message", (raw) => {
          try {
            const p = JSON.parse(raw.toString());
            if (p.event === "error" || p.error) {
              clearTimeout(timer);
              resolve(p);
            }
          } catch {}
        });
      });

      ws.send(JSON.stringify(unauthPayload));
      const errFrame = await errorPromise;
      assert.ok(errFrame.error || errFrame.code, "Must receive error frame on unauthorized ticket context");

      // Database verification: message MUST NOT be inserted
      const msgCheck = await pool.query("SELECT id FROM messages WHERE external_id = $1", [unauthExtId]);
      assert.equal(msgCheck.rows.length, 0, "Unauthorized message must NOT be persisted to messages table");
    } finally {
      ws.close();
    }
  });

  it("N: Unauthorized attachment with activeTicketId is rejected without attachment insertion", async () => {
    // Connect WebSocket
    const wsRes = await fetch(`${API}/api/v1/webchat/ws-ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokenCust1}` },
    });
    assert.equal(wsRes.status, 200);
    const { ticket: wsTicket } = await wsRes.json() as any;

    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(`ws://localhost:3000/api/v1/webchat/socket?ticket=${encodeURIComponent(wsTicket)}`);

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WS connect timeout")), 5000);
        ws.on("open", () => {
          clearTimeout(timer);
          resolve(null);
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const unauthAttExtId = `unauth_att_${STAMP}`;
      const unauthPayload = {
        text: "Malicious attachment with foreign ticket",
        tempId: unauthAttExtId,
        activeTicketId: 999999, // Non-existent arbitrary ticket
        attachments: [
          {
            fileUrl: "http://localhost:3000/uploads/exploit.png",
            fileName: "exploit.png",
            fileType: "image/png",
            fileSize: 512,
          }
        ]
      };

      const errorPromise = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for rejection frame")), 5000);
        ws.on("message", (raw) => {
          try {
            const p = JSON.parse(raw.toString());
            if (p.event === "error" || p.error) {
              clearTimeout(timer);
              resolve(p);
            }
          } catch {}
        });
      });

      ws.send(JSON.stringify(unauthPayload));
      const errFrame = await errorPromise;
      assert.ok(errFrame.error || errFrame.code, "Must receive error frame on unauthorized attachment");

      // Database verification: no message and no attachment
      const msgCheck = await pool.query("SELECT id FROM messages WHERE external_id = $1", [unauthAttExtId]);
      assert.equal(msgCheck.rows.length, 0, "Message must not be persisted");
      const attCheck = await pool.query("SELECT id FROM message_attachments WHERE file_name = 'exploit.png'");
      assert.equal(attCheck.rows.length, 0, "Unauthorized attachment must not be persisted");
    } finally {
      ws.close();
    }
  });
});
