import assert from "assert";
import { describe, it, before, after } from "node:test";
import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { resolveIdentityForProfile, CUSTOMER_PROOF_CHANNEL } from "../../src/api/routes/auth";

/**
 * Customer login resolved a profile's identity without naming a channel.
 *
 * All three customer-proof paths in `auth.ts` ran
 *
 *   SELECT channel_ref, org_id FROM identities WHERE profile_id::text = $1 LIMIT 1
 *
 * with no channel predicate and no ORDER BY, so the row was whatever the
 * planner returned first. A profile holding both a LINE and a WebChat identity
 * could yield the LINE `channel_ref`, which was then signed into a WebChat
 * proof as `customerId`. The handshake resolves that through
 * `findByChannelAndRef("WebChat", ref)`; the unique key is
 * `(channel, channel_ref)`, so a LINE row never satisfies it — the lookup
 * misses and the gateway creates a **new profile and identity** for someone who
 * already had both. An authentication defect could mint duplicate customers.
 *
 * These tests pin the corrected contract: resolution is scoped to the channel
 * being authenticated, deterministic, and refuses rather than inventing a
 * `channel_ref` when the profile has no identity on that channel.
 *
 * Requires PostgreSQL. Fixtures are created inside a transaction that is always
 * rolled back; the canonical rows (profile 999, identities 999/1135,
 * conversation 1210) are only ever read.
 */

const PROFILE = "999";
const LINE_IDENTITY_ID = 999;
const LINE_REF = "U367f5ba23c8167bc4b15a7a4e7c52b26";
const WEBCHAT_IDENTITY_ID = 1135;
const WEBCHAT_REF = "fa775e9b-371f-4944-afe8-cccd4b8f0bf2";

describe("customer auth resolves the identity of the channel being authenticated", () => {
  let baselineIdentities = 0;
  let baselineProfiles = 0;

  before(async () => {
    baselineIdentities = Number((await pool.query("SELECT COUNT(*) n FROM identities")).rows[0].n);
    baselineProfiles = Number((await pool.query("SELECT COUNT(*) n FROM profiles")).rows[0].n);
  });

  after(async () => {
    await pool.end().catch(() => {});
  });

  it("A — a WebChat proof for a multi-identity profile resolves the WebChat identity", async () => {
    const resolved = await resolveIdentityForProfile({ profileId: PROFILE, channel: CUSTOMER_PROOF_CHANNEL });
    assert.ok(resolved, "profile 999 must resolve a WebChat identity");
    assert.strictEqual(resolved.identityId, WEBCHAT_IDENTITY_ID);
    assert.strictEqual(resolved.channelRef, WEBCHAT_REF);
    assert.notStrictEqual(resolved.channelRef, LINE_REF, "must never hand back the LINE channel_ref");
  });

  it("B — a LINE lookup for the same profile resolves the LINE identity", async () => {
    const resolved = await resolveIdentityForProfile({ profileId: PROFILE, channel: "line" });
    assert.ok(resolved, "profile 999 must resolve a LINE identity");
    assert.strictEqual(resolved.identityId, LINE_IDENTITY_ID);
    assert.strictEqual(resolved.channelRef, LINE_REF);
    assert.notStrictEqual(resolved.channelRef, WEBCHAT_REF, "must never hand back the WebChat channel_ref");
  });

  it("B2 — channel matching is case-insensitive, matching the repository and the data", async () => {
    // The column stores 'line' lower-case and 'WebChat' mixed-case.
    const lower = await resolveIdentityForProfile({ profileId: PROFILE, channel: "webchat" });
    const upper = await resolveIdentityForProfile({ profileId: PROFILE, channel: "WEBCHAT" });
    assert.strictEqual(lower?.identityId, WEBCHAT_IDENTITY_ID);
    assert.strictEqual(upper?.identityId, WEBCHAT_IDENTITY_ID);
    const line = await resolveIdentityForProfile({ profileId: PROFILE, channel: "LINE" });
    assert.strictEqual(line?.identityId, LINE_IDENTITY_ID);
  });

  it("C — the answer does not depend on insertion order", async () => {
    // Two throwaway profiles: one with LINE inserted first, one with WebChat
    // first. Under the old LIMIT-1 query these could disagree. Everything here
    // is rolled back.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results: Record<string, { web?: string; line?: string }> = {};

      for (const order of ["line-first", "webchat-first"] as const) {
        const pid = `test_order_${order}_${Date.now()}`;
        await client.query(
          "INSERT INTO profiles (id, name, company_id, created_at) VALUES ($1, $2, 1, NOW())",
          [pid, `Fixture ${order}`]
        );
        const rows =
          order === "line-first"
            ? [
                ["line", `Ufixture_${pid}`],
                ["WebChat", `wc-fixture-${pid}`],
              ]
            : [
                ["WebChat", `wc-fixture-${pid}`],
                ["line", `Ufixture_${pid}`],
              ];
        for (const [channel, ref] of rows) {
          await client.query(
            `INSERT INTO identities (profile_id, channel, channel_ref, org_id, created_at, updated_at)
             VALUES ($1, $2, $3, 'org_default', NOW(), NOW())`,
            [pid, channel, ref]
          );
        }

        // Same SQL the resolver runs, on this transaction's connection so it
        // can see the uncommitted fixture.
        const pick = async (channel: string) =>
          (
            await client.query(
              `SELECT id, channel_ref FROM identities
                WHERE profile_id::text = $1::text AND LOWER(channel) = LOWER($2)
                ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`,
              [pid, channel]
            )
          ).rows[0];

        results[order] = {
          web: (await pick("WebChat"))?.channel_ref,
          line: (await pick("line"))?.channel_ref,
        };

        assert.ok(results[order].web?.startsWith("wc-fixture-"), `${order}: WebChat lookup must return the WebChat ref`);
        assert.ok(results[order].line?.startsWith("Ufixture_"), `${order}: LINE lookup must return the LINE ref`);
      }
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("D — a profile with no identity on the requested channel resolves to null, not a substitute", async () => {
    const missing = await resolveIdentityForProfile({ profileId: PROFILE, channel: "facebook" });
    assert.strictEqual(missing, null, "an absent channel identity must not fall back to another channel");

    const unknownProfile = await resolveIdentityForProfile({
      profileId: "___no_such_profile___",
      channel: CUSTOMER_PROOF_CHANNEL,
    });
    assert.strictEqual(unknownProfile, null);
  });

  it("D2 — every customer-proof path refuses instead of synthesising a channel_ref", async () => {
    // The `|| \`cust_${profileId}\`` fallback was the mechanism that fed the
    // handshake an unresolvable ref. It must be gone from all three sites.
    const fs = await import("fs");
    const src = fs.readFileSync(new URL("../../src/api/routes/auth.ts", import.meta.url), "utf8");
    const body = src.split("export async function resolveIdentityForProfile")[1] || src;
    assert.ok(!/cust_\$\{/.test(body), "no customer-proof path may invent a channel_ref");
    assert.strictEqual(
      (src.match(/NO_CHANNEL_IDENTITY/g) || []).length,
      3,
      "all three customer-proof paths must return the controlled refusal"
    );
    assert.ok(
      !/FROM identities WHERE profile_id::text = \$1::text LIMIT 1/.test(src.replace(/^\s*\*.*$/gm, "")),
      "no unscoped LIMIT 1 identity lookup may remain outside comments"
    );
  });

  it("E — repeated resolution is stable and creates nothing", async () => {
    const first = await resolveIdentityForProfile({ profileId: PROFILE, channel: CUSTOMER_PROOF_CHANNEL });
    const second = await resolveIdentityForProfile({ profileId: PROFILE, channel: CUSTOMER_PROOF_CHANNEL });
    const third = await resolveIdentityForProfile({ profileId: PROFILE, channel: CUSTOMER_PROOF_CHANNEL });
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(second, third);

    const identities = Number((await pool.query("SELECT COUNT(*) n FROM identities")).rows[0].n);
    const profiles = Number((await pool.query("SELECT COUNT(*) n FROM profiles")).rows[0].n);
    assert.strictEqual(identities, baselineIdentities, "resolution must not create identities");
    assert.strictEqual(profiles, baselineProfiles, "resolution must not create profiles");
  });

  it("F — the canonical mapping and conversation 1210 are untouched", async () => {
    const { rows: idents } = await pool.query(
      "SELECT id, channel, channel_ref, profile_id FROM identities WHERE id = ANY($1::int[]) ORDER BY id",
      [[LINE_IDENTITY_ID, WEBCHAT_IDENTITY_ID]]
    );
    assert.strictEqual(idents.length, 2);
    assert.ok(idents.every((r: any) => String(r.profile_id) === PROFILE), "both identities stay on profile 999");
    assert.strictEqual(idents.find((r: any) => r.id === LINE_IDENTITY_ID)?.channel_ref, LINE_REF);
    assert.strictEqual(idents.find((r: any) => r.id === WEBCHAT_IDENTITY_ID)?.channel_ref, WEBCHAT_REF);

    const { rows: conv } = await pool.query(
      "SELECT identity_id, project_id, org_id FROM conversations WHERE id = 1210"
    );
    assert.strictEqual(conv[0]?.identity_id, WEBCHAT_IDENTITY_ID);
    assert.strictEqual(conv[0]?.project_id, 101);
    assert.strictEqual(conv[0]?.org_id, "org_excise");
  });
});
