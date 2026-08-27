import assert from "assert";
import { describe, it, before, after } from "node:test";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { ProjectResolver } from "../../src/domain/project/ProjectResolver";
import { config } from "../../src/config/env";

/**
 * Project resolution against the live database.
 *
 * The five cases the recovery sprint requires — projects 1, 101, 301, an
 * unmapped project, and cross-tenant access — plus join-code redemption,
 * which is the mechanism the Orchestrator was reimplementing incorrectly.
 */

const resolver = new ProjectResolver();
let dbAvailable = false;
let stagingCode = "";
const STAGING_PROJECT = 301;
const STAGING_ORG = "org_staging";

describe("ProjectResolver (live database)", () => {
  before(async () => {
    try {
      await pool.query("SELECT 1");
      dbAvailable = true;
      stagingCode = process.env.QA_STAGING_JOIN_CODE || "";
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    await pool.end().catch(() => {});
  });

  // ---------------------------------------------------------------- by id
  it("PROJ-001: project 1 resolves with its own organization", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    const r = await resolver.resolveById(1);
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.project!.projectId, 1);
    assert.strictEqual(r.project!.orgId, "org_default");
  });

  it("PROJ-002: project 101 resolves to org_excise, not org_default", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    const r = await resolver.resolveById(101);
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.project!.orgId, "org_excise");
  });

  it("PROJ-003: staging project 301 resolves to org_staging", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    // The staging project was never provisioned - creating it depends on a
    // staging Plane workspace, which is BLOCKED. Skipping with that reason
    // keeps the gap visible; asserting against a fixture that does not exist
    // would report a resolver defect that is not one.
    const exists = await resolver.resolveById(STAGING_PROJECT);
    if (!exists.ok && exists.failure === "PROJECT_NOT_FOUND") {
      return t.skip(`BLOCKED: project ${STAGING_PROJECT} is not provisioned (staging Plane workspace unavailable)`);
    }
    const r = exists;
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.project!.projectId, STAGING_PROJECT);
    assert.strictEqual(r.project!.orgId, STAGING_ORG);
  });

  it("PROJ-004: an unmapped project fails closed", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    const r = await resolver.resolveById(9999);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failure, "PROJECT_NOT_FOUND");
    assert.strictEqual(r.project, undefined, "no fallback project may be returned");
  });

  it("PROJ-005: cross-tenant project access fails closed", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    // org_default asking for project 101, which belongs to org_excise.
    const r = await resolver.resolveById(101, "org_default");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failure, "CROSS_TENANT_DENIED");
    assert.strictEqual(r.project, undefined);

    // ...and the reverse direction.
    const back = await resolver.resolveById(1, "org_excise");
    assert.strictEqual(back.ok, false);
    assert.strictEqual(back.failure, "CROSS_TENANT_DENIED");
  });

  it("rejects malformed project ids without querying", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    for (const bad of ["abc", "-1", "0", "", "1; DROP TABLE projects"]) {
      const r = await resolver.resolveById(bad);
      assert.strictEqual(r.ok, false, `accepted ${bad}`);
      assert.strictEqual(r.failure, "PROJECT_NOT_FOUND");
    }
  });

  // --------------------------------------------------------- by join code
  it("PROJ-006: a valid join code resolves to its project", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    if (!stagingCode) return t.skip("QA_STAGING_JOIN_CODE not supplied");
    if (!config.PROJECT_JOIN_CODE_PEPPER) return t.skip("PROJECT_JOIN_CODE_PEPPER not configured");

    const r = await resolver.resolveByJoinCode(stagingCode, { channel: "line" });
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.project!.projectId, STAGING_PROJECT);
    assert.strictEqual(r.project!.orgId, STAGING_ORG);
  });

  it("PROJ-007: join-code matching is normalised, not literal", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    if (!stagingCode) return t.skip("QA_STAGING_JOIN_CODE not supplied");
    if (!config.PROJECT_JOIN_CODE_PEPPER) return t.skip("PROJECT_JOIN_CODE_PEPPER not configured");

    const messy = ` ${stagingCode.toLowerCase().replace(/-/g, " ")} `;
    const r = await resolver.resolveByJoinCode(messy, { channel: "line" });
    assert.ok(r.ok, `normalised form should resolve: ${r.reason}`);
    assert.strictEqual(r.project!.projectId, STAGING_PROJECT);
  });

  it("PROJ-008: an unknown join code fails closed with no project", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    for (const bad of ["TX-0000-0000", "NOPE", "‌", "' OR '1'='1"]) {
      const r = await resolver.resolveByJoinCode(bad, { channel: "line" });
      assert.strictEqual(r.ok, false, `accepted ${bad}`);
      assert.strictEqual(r.project, undefined, "no fallback project may be returned");
    }
  });

  it("PROJ-009: an empty code is refused before any lookup", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    const r = await resolver.resolveByJoinCode("   ", { channel: "line" });
    assert.strictEqual(r.failure, "CODE_EMPTY");
  });

  it("PROJ-010: a project name is not accepted as a join code", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    // The Orchestrator's old query matched projects.name directly, so typing
    // another tenant's project name joined it. Names must never redeem.
    for (const name of ["AutomationX Demo", "24/7", "Golden Flow Staging"]) {
      const r = await resolver.resolveByJoinCode(name, { channel: "line" });
      assert.strictEqual(r.ok, false, `project name "${name}" redeemed as a code`);
    }
  });

  it("PROJ-011: a code for a channel that is not enabled is refused", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    if (!stagingCode) return t.skip("QA_STAGING_JOIN_CODE not supplied");
    if (!config.PROJECT_JOIN_CODE_PEPPER) return t.skip("PROJECT_JOIN_CODE_PEPPER not configured");

    const r = await resolver.resolveByJoinCode(stagingCode, { channel: "carrier-pigeon" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failure, "CHANNEL_NOT_ENABLED");
  });

  it("PROJ-012: redeeming a code while claiming another org fails closed", async (t) => {
    if (!dbAvailable) return t.skip("database unavailable");
    if (!stagingCode) return t.skip("QA_STAGING_JOIN_CODE not supplied");
    if (!config.PROJECT_JOIN_CODE_PEPPER) return t.skip("PROJECT_JOIN_CODE_PEPPER not configured");

    const r = await resolver.resolveByJoinCode(stagingCode, {
      channel: "line",
      expectedOrgId: "org_excise",
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failure, "CROSS_TENANT_DENIED");
  });
});
