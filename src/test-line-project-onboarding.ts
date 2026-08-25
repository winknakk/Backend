import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  LineProjectOnboardingService,
  PROJECT_RELINK_COMMAND_TEXTS,
} from "./services/LineProjectOnboardingService";
import { resolveLineWebhookPayload, verifyLineSignature } from "./services/lineWebhookSecurity";

function testProjectCodeFormat(): void {
  const codes = new Set<string>();
  for (let index = 0; index < 100; index += 1) {
    const code = LineProjectOnboardingService.generateCode();
    assert.match(code, /^TX-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    assert.equal(LineProjectOnboardingService.normalizeCode(code), code.replaceAll("-", ""));
    codes.add(code);
  }
  assert.equal(codes.size, 100, "generated project codes should be unique in the sample");
  assert.equal(LineProjectOnboardingService.normalizeCode(" tx-abcd-2345 "), "TXABCD2345");
}

function testLineSignature(): void {
  const rawBody = Buffer.from('{"destination":"U123","events":[]}', "utf8");
  const secret = "line-channel-secret-for-test";
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  assert.equal(verifyLineSignature(rawBody, signature, secret), true);
  assert.equal(verifyLineSignature(Buffer.from("{}"), signature, secret), false);
  assert.equal(verifyLineSignature(rawBody, `${signature}x`, secret), false);
  assert.equal(verifyLineSignature(rawBody, "", secret), false);

  const forwarded = resolveLineWebhookPayload({
    body: { rawBody: rawBody.toString("utf8"), signature },
    requestRawBody: Buffer.from('{"wrapper":true}', "utf8"),
  });
  assert.equal(forwarded.forwardedByRouter, true);
  assert.deepEqual(forwarded.body, { destination: "U123", events: [] });
  assert.equal(verifyLineSignature(forwarded.rawBody, forwarded.signature, secret), true);

  const forwardedNested = resolveLineWebhookPayload({
    body: { data: { rawBody: rawBody.toString("utf8"), signature } },
    requestRawBody: Buffer.from('{"wrapper":true}', "utf8"),
  });
  assert.equal(forwardedNested.forwardedByRouter, true);
  assert.deepEqual(forwardedNested.body, { destination: "U123", events: [] });
  assert.equal(verifyLineSignature(forwardedNested.rawBody, forwardedNested.signature, secret), true);

  const direct = resolveLineWebhookPayload({
    body: { destination: "U123", events: [] },
    requestRawBody: rawBody,
    headerSignature: signature,
  });
  assert.equal(direct.forwardedByRouter, false);
  assert.equal(verifyLineSignature(direct.rawBody, direct.signature, secret), true);
  assert.throws(
    () => resolveLineWebhookPayload({ body: { rawBody: "not-json", signature } }),
    /JSON/
  );
}

function testMigrationContract(): void {
  const migrationPath = path.resolve(__dirname, "../database/migrations/030_line_project_onboarding.sql");
  const migration = fs.readFileSync(migrationPath, "utf8");
  for (const table of [
    "project_join_codes",
    "line_onboarding_sessions",
    "line_onboarding_requests",
    "line_webhook_events",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /code_digest CHAR\(64\) NOT NULL UNIQUE/);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+project_join_codes/i);
  assert.doesNotMatch(migration, /TX-[A-Z0-9]{4}-[A-Z0-9]{4}/);
}

function testOnboardingVoice(): void {
  const serviceSource = fs.readFileSync(
    path.resolve(__dirname, "services/LineProjectOnboardingService.ts"),
    "utf8"
  );
  const routeSource = fs.readFileSync(path.resolve(__dirname, "api/routes/lineWebhook.ts"), "utf8");
  const greetingPolicy = fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../workflow-tooling/promptx_tools/workflow/Workflow latest (Good)/documentation/LINE-OA-Greeting-Disabled.txt"
    ),
    "utf8"
  );

  assert.match(serviceSource, /ส่งรหัสโปรเจกต์มาได้เลยค่ะ/);
  assert.match(serviceSource, /พร้อมใช้งานได้เลยค่ะ/);
  assert.doesNotMatch(serviceSource, /15 นาที|invalid_code_locked|temporarily_locked/);
  assert.match(serviceSource, /s\.selected_project_id = c\.project_id/);
  assert.match(serviceSource, /JOIN profile_projects pp ON pp\.profile_id = pr\.id/);
  assert.match(serviceSource, /project_switch_completed/);
  assert.doesNotMatch(serviceSource, /p\.company_id = pr\.company_id/);
  assert.match(serviceSource, /provisionProject\(client, target\.orgId/);
  assert.match(serviceSource, /companyName: project\.companyName/);
  assert.match(serviceSource, /ticketx:onboarding:switch_project/);
  assert.match(serviceSource, /CAROUSEL_RECALL_AFTER_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(serviceSource, /pushOnboardingCarousel/);
  assert.match(routeSource, /24-hour carousel recall push failed/);
  assert.match(routeSource, /notificationDisabled/);
  assert.doesNotMatch(serviceSource, /ครับ/);
  assert.doesNotMatch(routeSource, /ครับ/);
  assert.match(greetingPolicy, /ปิดข้อความทักทายเพื่อนใหม่/);
  for (const alias of ["เริ่มใช้งาน", "เมนู", "โปรเจกต์ของฉัน", "/menu", "/project"]) {
    assert.ok(PROJECT_RELINK_COMMAND_TEXTS.includes(alias as any), `missing menu alias: ${alias}`);
  }
}

testProjectCodeFormat();
testLineSignature();
testMigrationContract();
testOnboardingVoice();
process.stdout.write("LINE project onboarding source tests passed.\n");
