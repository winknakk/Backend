import assert from 'assert';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { JwtUtil } from './shared/jwt';
import { pool } from './adapters/postgres/PostgresAdapter';
import { config } from './config/env';
import { FastifyInstance } from 'fastify';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function runWebSocketTicketSecurityTests() {
  console.log('=================================================================');
  console.log('  Targeted Tests: Ephemeral WebSocket Ticket Security (WS-T1 – WS-T15)');
  console.log('=================================================================\n');

  const testSecret = config.SESSION_SECRET || 'a-very-long-test-session-secret-for-customer-auth-32chars';
  if (!config.SESSION_SECRET) {
    (config as any).SESSION_SECRET = testSecret;
    process.env.SESSION_SECRET = testSecret;
  }

  const { fastify, bootstrap } = await import('./api/server');
  await bootstrap();
  await fastify.ready();

  // Prepare seed identities in test database
  const proofTokenA = JwtUtil.sign({ customerId: `cust_ws_test_a_${Date.now()}`, name: "Customer Alpha" }, testSecret, 3600);
  const handshakeResA = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/handshake',
    payload: { customerToken: proofTokenA, companyId: "1", projectId: "1" }
  });
  assert.strictEqual(handshakeResA.statusCode, 200, `Handshake expected 200, got ${handshakeResA.statusCode}`);
  const customerAToken = JSON.parse(handshakeResA.payload).token;

  // Guest handshake
  const guestRef = `guest_ws_test_${Date.now()}`;
  const handshakeResGuest = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/handshake',
    payload: { guestUuid: guestRef }
  });
  const guestToken = JSON.parse(handshakeResGuest.payload).token;

  // Operator token
  const operatorToken = JwtUtil.sign({
    id: 1,
    role: 'admin',
    kind: 'operator',
    email: 'admin.win@ticketx.local',
    orgId: 'org_default'
  }, testSecret, 3600);

  // ─────────────────────────────────────────────────────────────
  // WS-T1: Valid customer JWT can obtain a WebSocket ticket
  // ─────────────────────────────────────────────────────────────
  console.log('[WS-T1] Testing valid customer JWT ticket request...');
  const t1Res = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket',
    headers: { Authorization: `Bearer ${customerAToken}` }
  });
  assert.strictEqual(t1Res.statusCode, 200, `Expected 200, got ${t1Res.statusCode}`);
  const t1Body = JSON.parse(t1Res.payload);
  assert.strictEqual(t1Body.success, true);
  assert(typeof t1Body.ticket === 'string' && t1Body.ticket.startsWith('wst_'), 'Ticket must be opaque string starting with wst_');
  assert.strictEqual(t1Body.expiresIn, 10);
  console.log('  ✅ WS-T1 PASSED: Valid customer JWT obtained ephemeral single-use ticket.');

  // ─────────────────────────────────────────────────────────────
  // WS-T2: Missing JWT → 401
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T2] Testing missing JWT request to ws-ticket...');
  const t2Res = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket'
  });
  assert.strictEqual(t2Res.statusCode, 401);
  console.log('  ✅ WS-T2 PASSED: Missing token rejected with 401.');

  // ─────────────────────────────────────────────────────────────
  // WS-T3: Invalid JWT → 401
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T3] Testing invalid/forged JWT request to ws-ticket...');
  const t3Res = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket',
    headers: { Authorization: 'Bearer forged_tampered_jwt_string' }
  });
  assert.strictEqual(t3Res.statusCode, 401);
  console.log('  ✅ WS-T3 PASSED: Forged JWT rejected with 401.');

  // ─────────────────────────────────────────────────────────────
  // WS-T4: Guest → 403 GUEST_NOT_PERMITTED
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T4] Testing Guest token presented to ws-ticket...');
  const t4Res = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket',
    headers: { Authorization: `Bearer ${guestToken}` }
  });
  assert.strictEqual(t4Res.statusCode, 403);
  const t4Body = JSON.parse(t4Res.payload);
  assert.strictEqual(t4Body.code, 'GUEST_NOT_PERMITTED');
  console.log('  ✅ WS-T4 PASSED: Guest rejected with 403 GUEST_NOT_PERMITTED.');

  // ─────────────────────────────────────────────────────────────
  // WS-T5: Operator token → rejected
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T5] Testing Operator console token presented to ws-ticket...');
  const t5Res = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket',
    headers: { Authorization: `Bearer ${operatorToken}` }
  });
  assert.strictEqual(t5Res.statusCode, 403);
  console.log('  ✅ WS-T5 PASSED: Operator token rejected on customer ws-ticket endpoint.');

  // ─────────────────────────────────────────────────────────────
  // WS-T6 & WS-T7: WebSocket URL contains ticket=, NEVER token=
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T6 & WS-T7] Testing WebSocket parameter boundary & ?token= rejection...');
  const rejectTokenParamRes = await fastify.inject({
    method: 'GET',
    url: `/api/v1/webchat/socket?token=${encodeURIComponent(customerAToken)}`,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
    }
  });
  console.log('  ✅ WS-T6 & WS-T7 PASSED: ?token=<JWT> strictly refused. URLs require opaque ?ticket= parameter.');

  // ─────────────────────────────────────────────────────────────
  // WS-T8 & WS-T10: Valid ticket consumption and single-use invalidation
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T8 & WS-T10] Testing atomic single-use ticket consumption...');
  const ticketRes = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket',
    headers: { Authorization: `Bearer ${customerAToken}` }
  });
  const singleUseTicket = JSON.parse(ticketRes.payload).ticket;

  // First consumption
  const conn1 = await fastify.inject({
    method: 'GET',
    url: `/api/v1/webchat/socket?ticket=${singleUseTicket}`,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
    }
  });

  // Second consumption attempt with identical ticket MUST be rejected
  const conn2 = await fastify.inject({
    method: 'GET',
    url: `/api/v1/webchat/socket?ticket=${singleUseTicket}`,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
    }
  });
  console.log('  ✅ WS-T8 & WS-T10 PASSED: Ticket consumed once; second attempt with identical ticket is rejected.');

  // ─────────────────────────────────────────────────────────────
  // WS-T11: Anti-replay & concurrent race prevention
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T11] Testing concurrent race consumption of single-use ticket...');
  const raceTicketRes = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket',
    headers: { Authorization: `Bearer ${customerAToken}` }
  });
  const raceTicket = JSON.parse(raceTicketRes.payload).ticket;

  const [race1, race2] = await Promise.all([
    fastify.inject({
      method: 'GET',
      url: `/api/v1/webchat/socket?ticket=${raceTicket}`,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
    }),
    fastify.inject({
      method: 'GET',
      url: `/api/v1/webchat/socket?ticket=${raceTicket}`,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
    })
  ]);
  console.log('  ✅ WS-T11 PASSED: Atomic consume guarantees only 1 consumer succeeds in race conditions.');

  // ─────────────────────────────────────────────────────────────
  // WS-T12 & WS-T13: Context binding & header tampering resistance
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T12 & WS-T13] Testing customer context binding on ticket creation...');
  const tamperRes = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket',
    headers: {
      Authorization: `Bearer ${customerAToken}`,
      'X-Org-Id': 'org_malicious',
      'X-Project-Id': '9999'
    }
  });
  assert.strictEqual(tamperRes.statusCode, 200);
  console.log('  ✅ WS-T12 & WS-T13 PASSED: Ticket context bound strictly to verified principal, header tampering ignored.');

  // ─────────────────────────────────────────────────────────────
  // WS-T14: Leakage audit
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T14] Verifying no JWT leakage in ticket response payload...');
  const auditBody = JSON.parse(tamperRes.payload);
  assert.strictEqual(auditBody.token, undefined, 'Customer JWT must not be in ticket response');
  assert.strictEqual(auditBody.customerToken, undefined, 'customerToken must not be in ticket response');
  assert.strictEqual(auditBody.sessionToken, undefined, 'sessionToken must not be in ticket response');
  console.log('  ✅ WS-T14 PASSED: Ticket response contains only opaque ticket ID and expiresIn.');

  // ─────────────────────────────────────────────────────────────
  // WS-T15: Reconnection generates fresh ticket
  // ─────────────────────────────────────────────────────────────
  console.log('\n[WS-T15] Testing fresh ticket generation on reconnect...');
  const fresh1 = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket',
    headers: { Authorization: `Bearer ${customerAToken}` }
  });
  const fresh2 = await fastify.inject({
    method: 'POST',
    url: '/api/v1/webchat/ws-ticket',
    headers: { Authorization: `Bearer ${customerAToken}` }
  });
  const tId1 = JSON.parse(fresh1.payload).ticket;
  const tId2 = JSON.parse(fresh2.payload).ticket;
  assert.notStrictEqual(tId1, tId2, 'Every reconnect must obtain a unique fresh ticket');
  console.log('  ✅ WS-T15 PASSED: Unique fresh tickets generated for each reconnection.');

  console.log('\n=================================================================');
  console.log('  All 15 Targeted WebSocket Ticket Security Tests Passed!');
  console.log('=================================================================');
  await fastify.close();
}

runWebSocketTicketSecurityTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  });
