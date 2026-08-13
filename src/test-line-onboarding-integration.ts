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
        id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, org_id VARCHAR(64) NOT NULL, name TEXT NOT NULL,
        project_type TEXT, environment TEXT
      );
      CREATE TEMP TABLE companies (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL
      );
      CREATE TEMP TABLE project_channels (
        project_id INTEGER NOT NULL, channel_id TEXT NOT NULL, channel_type TEXT NOT NULL, is_enabled BOOLEAN, active BOOLEAN
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
      CREATE TEMP TABLE messages (
        id SERIAL PRIMARY KEY, conversation_id INTEGER, role TEXT, content TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
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
      INSERT INTO companies VALUES
        (5, 'Avalant Co.,Ltd.'),
        (101, 'กรมสรรพสามิต');
      INSERT INTO projects VALUES
        (8, 5, 'org_default', '24/7', 'Support Project', 'Avalant 24/7 Production'),
        (11, 5, 'org_default', 'SSO Project', 'Support Project', 'SSO Production'),
        (101, 101, 'org_excise', 'EXC03 - ระบบสารสนเทศกรมสรรพสามิต', 'Enterprise Application', 'Production');
      INSERT INTO project_channels VALUES
        (8, 'U_DESTINATION', 'line', TRUE, TRUE),
        (11, 'U_OTHER_DESTINATION', 'line', TRUE, TRUE),
        (101, 'U_EXCISE_DESTINATION', 'line', TRUE, TRUE);
    `);
  } finally {
    client.release();
  }

  const service = new LineProjectOnboardingService(testPool, "integration-test-project-code-pepper", "code_required");
  await service.rotateJoinCode({ projectId: 8, orgId: "org_default", createdBy: "test" });
  const restoredCode = "TX-ABCD-2345";
  await service.restoreJoinCode({
    projectId: 8,
    orgId: "org_default",
    code: restoredCode,
    createdBy: "test-restore",
  });
  await service.rotateJoinCode({ projectId: 8, orgId: "org_default", createdBy: "test" });
  const restored = await service.restoreJoinCode({
    projectId: 8,
    orgId: "org_default",
    code: restoredCode,
    createdBy: "test-restore",
  });
  assert.equal(restored.codeHint, "2345");
  const restoredRows = await testPool.query(
    `SELECT code_hint, status, expires_at
     FROM project_join_codes
     WHERE project_id = 8 AND status = 'active'`
  );
  assert.equal(restoredRows.rows.length, 1);
  assert.equal(restoredRows.rows[0].code_hint, "2345");
  assert.equal(restoredRows.rows[0].expires_at, null);
  const relinkCode = await service.rotateJoinCode({ projectId: 11, orgId: "org_default", createdBy: "test" });
  const crossOrgCode = await service.rotateJoinCode({ projectId: 101, orgId: "org_excise", createdBy: "test" });
  assert.match(restoredCode, /^TX-/);

  await service.processEvent({
    type: "follow", webhookEventId: "evt-retry-follow", destination: "U_DESTINATION", userId: "U_RETRY",
  });
  await service.processEvent({
    type: "postback", webhookEventId: "evt-retry-choice", destination: "U_DESTINATION", userId: "U_RETRY",
    postbackData: "ticketx:onboarding:has_code",
  });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const invalid = await service.processEvent({
      type: "message", webhookEventId: `evt-retry-invalid-${attempt}`,
      destination: "U_DESTINATION", userId: "U_RETRY", messageText: "TX-WRNG-CODE",
    });
    assert.equal(invalid.reason, "invalid_code");
    assert.doesNotMatch(invalid.replyText || "", /15 นาที|เหลือ .* ครั้ง/);
  }
  const validAfterRetries = await service.processEvent({
    type: "message", webhookEventId: "evt-retry-valid", destination: "U_DESTINATION",
    userId: "U_RETRY", messageText: restoredCode,
  });
  assert.equal(validAfterRetries.state, "COMPLETED");
  assert.equal(validAfterRetries.projectId, 8);
  const singleProjectMenu = await service.processEvent({
    type: "postback", webhookEventId: "evt-retry-change", destination: "U_DESTINATION",
    userId: "U_RETRY", postbackData: "ticketx:onboarding:menu:change",
  });
  assert.equal(singleProjectMenu.reason, "change_single_membership");
  assert.equal(singleProjectMenu.projectMenu?.projects.length, 1);
  assert.equal(singleProjectMenu.projectMenu?.projects[0].projectId, 8);
  assert.equal(singleProjectMenu.projectMenu?.projects[0].isCurrent, true);

  const noProjectMenu = await service.processEvent({
    type: "postback", webhookEventId: "evt-no-project-change", destination: "U_DESTINATION",
    userId: "U_NO_PROJECT", postbackData: "ticketx:onboarding:menu:change",
  });
  assert.equal(noProjectMenu.reason, "change_without_membership");
  assert.match(noProjectMenu.replyText || "", /ยินดีต้อนรับ/);
  assert.equal(noProjectMenu.quickReplies?.length, 2);

  const follow = await service.processEvent({
    type: "follow", webhookEventId: "evt-follow", destination: "U_DESTINATION", userId: "U_NEW",
  });
  assert.equal(follow.state, "AWAITING_CHOICE");
  assert.equal(follow.replyWithOnboardingCarousel, true);
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
    messageText: restoredCode,
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
  assert.equal(pass.pushOnboardingCarousel, undefined);

  await testPool.query(
    `UPDATE line_onboarding_sessions
     SET metadata = jsonb_set(metadata, '{lastDmActivityAt}', to_jsonb((NOW() - INTERVAL '23 hours 59 minutes')::text))
     WHERE line_user_id = 'U_NEW' AND destination = 'U_DESTINATION'`
  );
  const activeBeforeCooldown = await service.processEvent({
    type: "message", webhookEventId: "evt-carousel-before-cooldown", destination: "U_DESTINATION",
    userId: "U_NEW", messageText: "กลับมาก่อนครบหนึ่งวัน",
  });
  assert.equal(activeBeforeCooldown.action, "PASS_TO_AI");
  assert.equal(activeBeforeCooldown.pushOnboardingCarousel, undefined);

  await testPool.query(
    `UPDATE line_onboarding_sessions
     SET metadata = jsonb_set(metadata, '{lastDmActivityAt}', to_jsonb((NOW() - INTERVAL '24 hours')::text))
     WHERE line_user_id = 'U_NEW' AND destination = 'U_DESTINATION'`
  );
  const recalledAfterCooldown = await service.processEvent({
    type: "message", webhookEventId: "evt-carousel-after-cooldown", destination: "U_DESTINATION",
    userId: "U_NEW", messageText: "กลับมาหลังหนึ่งวัน",
  });
  assert.equal(recalledAfterCooldown.action, "PASS_TO_AI");
  assert.equal(recalledAfterCooldown.pushOnboardingCarousel, true);

  const immediateFollowUp = await service.processEvent({
    type: "message", webhookEventId: "evt-carousel-immediate-follow-up", destination: "U_DESTINATION",
    userId: "U_NEW", messageText: "ส่งต่อทันที",
  });
  assert.equal(immediateFollowUp.action, "PASS_TO_AI");
  assert.equal(immediateFollowUp.pushOnboardingCarousel, undefined);

  await testPool.query(
    `UPDATE line_onboarding_sessions
     SET metadata = metadata - 'lastDmActivityAt'
     WHERE line_user_id = 'U_NEW' AND destination = 'U_DESTINATION'`
  );
  await testPool.query(
    `INSERT INTO messages (conversation_id, role, content, created_at)
     VALUES ($1, 'customer', 'old activity', NOW() - INTERVAL '25 hours')`,
    [completed.conversationId]
  );
  const relink = await service.processEvent({
    type: "message", webhookEventId: "evt-relink", destination: "U_DESTINATION", userId: "U_NEW",
    messageText: "เริ่มใช้งาน",
  });
  assert.equal(relink.action, "REPLY");
  assert.equal(relink.state, "AWAITING_CHOICE");
  assert.equal(relink.reason, "existing_user_requested_project_relink");
  assert.equal(relink.replyWithOnboardingCarousel, true);
  const carouselSelection = await service.processEvent({
    type: "postback", webhookEventId: "evt-relink-menu-selection", destination: "U_DESTINATION", userId: "U_NEW",
    postbackData: "ticketx:onboarding:menu:change",
  });
  assert.equal(carouselSelection.state, "AWAITING_CHOICE");
  assert.equal(carouselSelection.reason, "change_single_membership");
  assert.equal(carouselSelection.replyWithOnboardingCarousel, undefined);
  assert.equal(carouselSelection.projectMenu?.projects.length, 1);
  await service.processEvent({
    type: "postback", webhookEventId: "evt-relink-choice", destination: "U_DESTINATION", userId: "U_NEW",
    postbackData: "ticketx:onboarding:has_code",
  });
  const relinkCompleted = await service.processEvent({
    type: "message", webhookEventId: "evt-relink-code", destination: "U_DESTINATION", userId: "U_NEW",
    messageText: relinkCode.code,
  });
  assert.equal(relinkCompleted.state, "COMPLETED");
  assert.equal(relinkCompleted.reason, "project_linked_switch_confirmation");
  assert.equal(relinkCompleted.projectId, 8);
  assert.equal(relinkCompleted.projectLinkConfirmation?.linkedProjectId, 11);
  assert.equal(relinkCompleted.projectLinkConfirmation?.currentProjectId, 8);
  const memberships = await testPool.query(
    `SELECT pp.project_id
     FROM profile_projects pp
     JOIN identities i ON i.profile_id = pp.profile_id
     WHERE i.channel_ref = 'U_NEW'
     ORDER BY pp.project_id`
  );
  assert.deepEqual(memberships.rows.map((row) => Number(row.project_id)), [8, 11]);
  const openConversations = await testPool.query(
    `SELECT c.project_id
     FROM conversations c
     JOIN identities i ON i.id = c.identity_id
     WHERE i.channel_ref = 'U_NEW' AND c.status = 'open'
     ORDER BY c.project_id`
  );
  assert.deepEqual(openConversations.rows.map((row) => Number(row.project_id)), [8, 11]);
  const passBeforeConfirmedSwitch = await service.processEvent({
    type: "message", webhookEventId: "evt-before-confirmed-switch", destination: "U_DESTINATION", userId: "U_NEW",
    messageText: "ทดสอบก่อนยืนยันเปลี่ยนโปรเจกต์",
  });
  assert.equal(passBeforeConfirmedSwitch.action, "PASS_TO_AI");
  assert.equal(passBeforeConfirmedSwitch.projectId, 8);
  assert.equal(passBeforeConfirmedSwitch.pushOnboardingCarousel, undefined);
  const confirmNewProject = await service.processEvent({
    type: "postback", webhookEventId: "evt-confirm-new-project", destination: "U_DESTINATION",
    userId: "U_NEW", postbackData: "ticketx:onboarding:switch_project:11",
  });
  assert.equal(confirmNewProject.reason, "project_switch_completed");
  assert.equal(confirmNewProject.projectId, 11);
  const passAfterRelink = await service.processEvent({
    type: "message", webhookEventId: "evt-after-relink", destination: "U_DESTINATION", userId: "U_NEW",
    messageText: "ทดสอบหลังยืนยันเปลี่ยนโปรเจกต์",
  });
  assert.equal(passAfterRelink.action, "PASS_TO_AI");
  assert.equal(passAfterRelink.projectId, 11);

  const multiProjectMenu = await service.processEvent({
    type: "postback", webhookEventId: "evt-change-multiple", destination: "U_DESTINATION",
    userId: "U_NEW", postbackData: "ticketx:onboarding:menu:change",
  });
  assert.equal(multiProjectMenu.reason, "change_multiple_memberships");
  assert.deepEqual(
    multiProjectMenu.projectMenu?.projects.map((project) => [project.projectId, project.isCurrent]),
    [[8, false], [11, true]]
  );

  const deniedSwitch = await service.processEvent({
    type: "postback", webhookEventId: "evt-change-denied", destination: "U_DESTINATION",
    userId: "U_NEW", postbackData: "ticketx:onboarding:switch_project:999",
  });
  assert.equal(deniedSwitch.reason, "project_switch_unavailable");
  assert.match(deniedSwitch.projectMenu?.notice || "", /ไม่พร้อมใช้งาน/);

  const switched = await service.processEvent({
    type: "postback", webhookEventId: "evt-change-to-eight", destination: "U_DESTINATION",
    userId: "U_NEW", postbackData: "ticketx:onboarding:switch_project:8",
  });
  assert.equal(switched.reason, "project_switch_completed");
  assert.equal(switched.projectId, 8);
  assert.match(switched.replyText || "", /24\/7/);
  const passAfterSwitch = await service.processEvent({
    type: "message", webhookEventId: "evt-after-switch", destination: "U_DESTINATION",
    userId: "U_NEW", messageText: "ทดสอบหลังเปลี่ยนโปรเจกต์",
  });
  assert.equal(passAfterSwitch.action, "PASS_TO_AI");
  assert.equal(passAfterSwitch.projectId, 8);

  await service.processEvent({
    type: "follow", webhookEventId: "evt-cross-follow", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
  });
  await service.processEvent({
    type: "postback", webhookEventId: "evt-cross-choice", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
    postbackData: "ticketx:onboarding:has_code",
  });
  await service.processEvent({
    type: "message", webhookEventId: "evt-cross-default-code", destination: "U_DESTINATION",
    userId: "U_CROSS_ORG", messageText: restoredCode,
  });
  await service.processEvent({
    type: "message", webhookEventId: "evt-cross-relink", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
    messageText: "เริ่มใช้งาน",
  });
  await service.processEvent({
    type: "postback", webhookEventId: "evt-cross-connect-new", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
    postbackData: "ticketx:onboarding:menu:connect_new",
  });
  await service.processEvent({
    type: "postback", webhookEventId: "evt-cross-has-code", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
    postbackData: "ticketx:onboarding:has_code",
  });
  const crossOrgLinked = await service.processEvent({
    type: "message", webhookEventId: "evt-cross-code", destination: "U_DESTINATION",
    userId: "U_CROSS_ORG", messageText: crossOrgCode.code,
  });
  assert.equal(crossOrgLinked.reason, "project_linked_switch_confirmation");
  assert.equal(crossOrgLinked.projectId, 8);
  assert.equal(crossOrgLinked.projectLinkConfirmation?.linkedProjectId, 101);
  assert.equal(crossOrgLinked.projectLinkConfirmation?.linkedCompanyName, "กรมสรรพสามิต");
  assert.equal(crossOrgLinked.projectLinkConfirmation?.linkedProjectType, "Enterprise Application");
  assert.equal(crossOrgLinked.projectLinkConfirmation?.linkedEnvironment, "Production");

  const crossOrgSwitch = await service.processEvent({
    type: "postback", webhookEventId: "evt-cross-switch", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
    postbackData: "ticketx:onboarding:switch_project:101",
  });
  assert.equal(crossOrgSwitch.reason, "project_switch_completed");
  assert.equal(crossOrgSwitch.projectId, 101);
  const crossOrgPass = await service.processEvent({
    type: "message", webhookEventId: "evt-cross-pass", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
    messageText: "ตรวจสอบระบบสรรพสามิต",
  });
  assert.equal(crossOrgPass.action, "PASS_TO_AI");
  assert.equal(crossOrgPass.projectId, 101);

  const crossOrgMenu = await service.processEvent({
    type: "postback", webhookEventId: "evt-cross-menu", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
    postbackData: "ticketx:onboarding:menu:change",
  });
  assert.equal(crossOrgMenu.reason, "change_multiple_memberships");
  assert.deepEqual(
    crossOrgMenu.projectMenu?.projects.map((project) => ({
      projectId: project.projectId,
      companyName: project.companyName,
      projectType: project.projectType,
      environment: project.environment,
      isCurrent: project.isCurrent,
    })),
    [
      {
        projectId: 101,
        companyName: "กรมสรรพสามิต",
        projectType: "Enterprise Application",
        environment: "Production",
        isCurrent: true,
      },
      {
        projectId: 8,
        companyName: "Avalant Co.,Ltd.",
        projectType: "Support Project",
        environment: "Avalant 24/7 Production",
        isCurrent: false,
      },
    ]
  );
  const completedCrossOrgSessions = await testPool.query(
    `SELECT org_id, selected_project_id
     FROM line_onboarding_sessions
     WHERE line_user_id = 'U_CROSS_ORG' AND destination = 'U_DESTINATION' AND state = 'COMPLETED'`
  );
  assert.deepEqual(completedCrossOrgSessions.rows, [{ org_id: "org_excise", selected_project_id: 101 }]);
  const crossOrgSwitchBack = await service.processEvent({
    type: "postback", webhookEventId: "evt-cross-switch-back", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
    postbackData: "ticketx:onboarding:switch_project:8",
  });
  assert.equal(crossOrgSwitchBack.reason, "project_switch_completed");
  assert.equal(crossOrgSwitchBack.projectId, 8);
  const crossOrgPassBack = await service.processEvent({
    type: "message", webhookEventId: "evt-cross-pass-back", destination: "U_DESTINATION", userId: "U_CROSS_ORG",
    messageText: "กลับมาใช้โปรเจกต์เดิม",
  });
  assert.equal(crossOrgPassBack.action, "PASS_TO_AI");
  assert.equal(crossOrgPassBack.projectId, 8);
  const completedDefaultSession = await testPool.query(
    `SELECT org_id, selected_project_id
     FROM line_onboarding_sessions
     WHERE line_user_id = 'U_CROSS_ORG' AND destination = 'U_DESTINATION' AND state = 'COMPLETED'`
  );
  assert.deepEqual(completedDefaultSession.rows, [{ org_id: "org_default", selected_project_id: 8 }]);

  const existingFriendFirstMessage = await service.processEvent({
    type: "message", webhookEventId: "evt-existing-friend", destination: "U_DESTINATION", userId: "U_EXISTING_FRIEND",
    messageText: "ทดสอบ",
  });
  assert.equal(existingFriendFirstMessage.state, "AWAITING_CHOICE");
  assert.equal(existingFriendFirstMessage.reason, "first_message_requires_onboarding");
  assert.equal(existingFriendFirstMessage.replyWithOnboardingCarousel, true);

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
  const duplicatePending = await service.processEvent({
    type: "postback", webhookEventId: "evt-choice-duplicate-pending", destination: "U_DESTINATION",
    userId: "U_NO_CODE", postbackData: "ticketx:onboarding:no_code",
  });
  assert.equal(duplicatePending.reason, "manual_verification_already_pending");
  const requestsAfterDuplicate = await testPool.query(
    "SELECT id FROM line_onboarding_requests WHERE status = 'pending'"
  );
  assert.equal(requestsAfterDuplicate.rows.length, 1);
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
