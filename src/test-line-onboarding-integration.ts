import assert from "node:assert/strict";
import pg from "pg";
import { config } from "./config/env";
import { LineProjectOnboardingService } from "./services/LineProjectOnboardingService";

async function main(): Promise<void> {
  if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const testPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  const client = await testPool.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE projects (
        id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, org_id VARCHAR(64) NOT NULL, name TEXT NOT NULL
      );
      CREATE TEMP TABLE project_channels (
        project_id INTEGER NOT NULL, channel_id TEXT NOT NULL, is_enabled BOOLEAN, active BOOLEAN
      );
      CREATE TEMP TABLE profiles (
        id TEXT PRIMARY KEY, company_id INTEGER NOT NULL, name TEXT NOT NULL, metadata JSONB,
        is_pii_erased BOOLEAN, is_merged BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
      );
      CREATE TEMP TABLE identities (
        id SERIAL PRIMARY KEY, profile_id TEXT, channel TEXT, channel_ref TEXT,
        is_shared BOOLEAN, is_pii BOOLEAN, account_type TEXT, is_shared_account BOOLEAN,
        org_id VARCHAR(64), deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
        UNIQUE(channel, channel_ref)
      );
      CREATE TEMP TABLE profile_projects (
        profile_id TEXT, project_id INTEGER, created_at TIMESTAMPTZ, PRIMARY KEY(profile_id, project_id)
      );
      CREATE TEMP TABLE conversations (
        id SERIAL PRIMARY KEY, identity_id INTEGER, project_id INTEGER, channel TEXT, status TEXT,
        handled_by TEXT, org_id VARCHAR(64), deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TEMP TABLE project_join_codes (
        id BIGSERIAL PRIMARY KEY, org_id VARCHAR(64), project_id INTEGER, code_digest CHAR(64) UNIQUE,
        code_hint VARCHAR(4), status VARCHAR(16) DEFAULT 'active', expires_at TIMESTAMPTZ,
        usage_count INTEGER DEFAULT 0, last_used_at TIMESTAMPTZ, created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ
      );
      CREATE TEMP TABLE line_onboarding_sessions (
        org_id VARCHAR(64), line_user_id TEXT, destination TEXT, state TEXT,
        selected_project_id INTEGER, attempts INTEGER DEFAULT 0, locked_until TIMESTAMPTZ,
        expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours', metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY(org_id, line_user_id, destination)
      );
      CREATE TEMP TABLE line_onboarding_requests (
        id BIGSERIAL PRIMARY KEY, org_id VARCHAR(64), line_user_id TEXT, destination TEXT,
        requested_details TEXT, status TEXT DEFAULT 'pending', resolved_project_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), resolved_at TIMESTAMPTZ
      );
      CREATE TEMP TABLE line_webhook_events (
        webhook_event_id TEXT PRIMARY KEY, line_user_id TEXT, event_type TEXT, status TEXT DEFAULT 'processing',
        response JSONB, received_at TIMESTAMPTZ DEFAULT NOW(), processed_at TIMESTAMPTZ
      );
      INSERT INTO projects VALUES (8, 5, 'org_default', '24/7');
      INSERT INTO project_channels VALUES (8, 'U_DESTINATION', TRUE, TRUE);
    `);
  } finally {
    client.release();
  }

  const service = new LineProjectOnboardingService(testPool, "integration-test-project-code-pepper", "code_required");
  const rotated = await service.rotateJoinCode({ projectId: 8, orgId: "org_default", createdBy: "test" });
  assert.match(rotated.code, /^TX-/);

  const follow = await service.processEvent({
    type: "follow", webhookEventId: "evt-follow", destination: "U_DESTINATION", userId: "U_NEW",
  });
  assert.equal(follow.state, "AWAITING_CHOICE");
  assert.equal(follow.quickReplies?.length, 2);
  const duplicate = await service.processEvent({
    type: "follow", webhookEventId: "evt-follow", destination: "U_DESTINATION", userId: "U_NEW",
  });
  assert.equal(duplicate.duplicate, true);

  const hasCode = await service.processEvent({
    type: "postback", webhookEventId: "evt-choice", destination: "U_DESTINATION", userId: "U_NEW",
    postbackData: "ticketx:onboarding:has_code",
  });
  assert.equal(hasCode.state, "AWAITING_CODE");
  const completed = await service.processEvent({
    type: "message", webhookEventId: "evt-code", destination: "U_DESTINATION", userId: "U_NEW",
    messageText: rotated.code,
  });
  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.projectId, 8);
  assert.ok(completed.conversationId);
  const pass = await service.processEvent({
    type: "message", webhookEventId: "evt-message", destination: "U_DESTINATION", userId: "U_NEW",
    messageText: "ระบบมีปัญหา",
  });
  assert.equal(pass.action, "PASS_TO_AI");
  assert.equal(pass.projectId, 8);

  const relink = await service.processEvent({
    type: "message", webhookEventId: "evt-relink", destination: "U_DESTINATION", userId: "U_NEW",
    messageText: "เริ่มใช้งาน",
  });
  assert.equal(relink.action, "REPLY");
  assert.equal(relink.state, "AWAITING_CHOICE");
  assert.equal(relink.reason, "existing_user_requested_project_relink");
  await service.processEvent({
    type: "postback", webhookEventId: "evt-relink-choice", destination: "U_DESTINATION", userId: "U_NEW",
    postbackData: "ticketx:onboarding:has_code",
  });
  const relinkCompleted = await service.processEvent({
    type: "message", webhookEventId: "evt-relink-code", destination: "U_DESTINATION", userId: "U_NEW",
    messageText: rotated.code,
  });
  assert.equal(relinkCompleted.state, "COMPLETED");
  assert.equal(relinkCompleted.projectId, 8);

  const existingFriendFirstMessage = await service.processEvent({
    type: "message", webhookEventId: "evt-existing-friend", destination: "U_DESTINATION", userId: "U_EXISTING_FRIEND",
    messageText: "ทดสอบ",
  });
  assert.equal(existingFriendFirstMessage.state, "AWAITING_CHOICE");
  assert.equal(existingFriendFirstMessage.reason, "first_message_requires_onboarding");

  await service.processEvent({
    type: "follow", webhookEventId: "evt-follow-2", destination: "U_DESTINATION", userId: "U_NO_CODE",
  });
  await service.processEvent({
    type: "postback", webhookEventId: "evt-choice-2", destination: "U_DESTINATION", userId: "U_NO_CODE",
    postbackData: "ticketx:onboarding:no_code",
  });
  const pending = await service.processEvent({
    type: "message", webhookEventId: "evt-details", destination: "U_DESTINATION", userId: "U_NO_CODE",
    messageText: "บริษัททดสอบ โปรเจกต์ 24/7",
  });
  assert.equal(pending.state, "PENDING_HUMAN");
  const requests = await testPool.query("SELECT id FROM line_onboarding_requests WHERE status = 'pending'");
  assert.equal(requests.rows.length, 1);
  const resolved = await service.resolveManualRequest({
    requestId: Number(requests.rows[0].id), projectId: 8, orgId: "org_default",
  });
  assert.equal(resolved.projectId, 8);
  assert.ok(resolved.conversationId);

  await testPool.end();
  process.stdout.write("LINE onboarding integration tests passed in temporary PostgreSQL tables.\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
