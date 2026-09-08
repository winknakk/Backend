import assert from "assert";
import { describe, it, after } from "node:test";
import { pool } from "../../src/adapters/postgres/PostgresAdapter";
import { findOrCreateWebChatGuestIdentity } from "../../src/infrastructure/db/guestIdentityProvisioning";

/**
 * ISSUE-063 — concurrent first-time guest handshakes raced on two rows.
 *
 * The old path did `findByChannelAndRef` then, if absent, inserted a profile
 * and an identity. Two racers both saw "not found"; the identity insert's
 * conflict target was `(id)` (each racer held a different sequence id, so it
 * never fired) and they collided on `uq_identities_channel_ref`, killing one
 * request. The profile insert's `ON CONFLICT (id) DO UPDATE` meanwhile let the
 * second guest overwrite the first guest's profile — silently, because
 * `profiles.id` is VARCHAR with no sequence and ids came from `MAX(id)+1`.
 *
 * These tests assert invariants rather than absolute table counts, and touch
 * only their own `i63-` fixture rows.
 */

const created: string[] = [];

async function identitiesFor(ref: string) {
  const { rows } = await pool.query(
    `SELECT id, profile_id, channel, channel_ref FROM identities
      WHERE LOWER(channel) = 'webchat' AND channel_ref = $1`,
    [ref]
  );
  return rows;
}

function fixtureRef(tag: string): string {
  const ref = `i63-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  created.push(ref);
  return ref;
}

describe("ISSUE-063 — guest identity creation is atomic", () => {
  after(async () => {
    // Only the fixture rows this file created.
    for (const ref of created) {
      const rows = await identitiesFor(ref);
      for (const r of rows) {
        await pool.query("DELETE FROM conversations WHERE identity_id = $1", [r.id]).catch(() => {});
        await pool.query("DELETE FROM identities WHERE id = $1", [r.id]).catch(() => {});
        await pool.query("DELETE FROM profiles WHERE id = $1", [r.profile_id]).catch(() => {});
      }
    }
    await pool.end().catch(() => {});
  });

  it("A — 20 concurrent first provisions for one channel_ref yield exactly one identity", async () => {
    const ref = fixtureRef("conc");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => findOrCreateWebChatGuestIdentity(ref, 1))
    );

    assert.strictEqual(results.length, 20, "every call must resolve, none may throw");

    const rows = await identitiesFor(ref);
    assert.strictEqual(rows.length, 1, `exactly one identity must exist, found ${rows.length}`);

    const ids = new Set(results.map((r) => String(r.identity.id)));
    assert.strictEqual(ids.size, 1, `all callers must converge on one identity, got ${[...ids].join(",")}`);
    assert.strictEqual(String(rows[0].id), [...ids][0]);

    const profileIds = new Set(results.map((r) => String(r.identity.profileId)));
    assert.strictEqual(profileIds.size, 1, "all callers must converge on one profile");

    // Exactly one caller may claim to have created it.
    assert.strictEqual(results.filter((r) => r.created).length, 1, "exactly one creator");

    // And the loser must not have left a speculative profile behind.
    const { rows: profs } = await pool.query(
      `SELECT id FROM profiles WHERE name = $1`,
      [`Guest_${ref.slice(0, 8)}`]
    );
    assert.strictEqual(profs.length, 1, `exactly one guest profile, found ${profs.length}`);
  });

  it("D — two simultaneous calls converge deterministically", async () => {
    const ref = fixtureRef("pair");
    const [a, b] = await Promise.all([
      findOrCreateWebChatGuestIdentity(ref, 1),
      findOrCreateWebChatGuestIdentity(ref, 1),
    ]);
    assert.strictEqual(String(a.identity.id), String(b.identity.id));
    assert.strictEqual(String(a.identity.profileId), String(b.identity.profileId));
    assert.strictEqual((await identitiesFor(ref)).length, 1);
    assert.strictEqual([a, b].filter((r) => r.created).length, 1);
  });

  it("C — an already-existing identity is reused, and nothing new is created", async () => {
    const ref = fixtureRef("existing");
    const first = await findOrCreateWebChatGuestIdentity(ref, 1);
    assert.strictEqual(first.created, true);

    const identitiesBefore = Number((await pool.query("SELECT COUNT(*) n FROM identities")).rows[0].n);
    const profilesBefore = Number((await pool.query("SELECT COUNT(*) n FROM profiles")).rows[0].n);

    const again = await findOrCreateWebChatGuestIdentity(ref, 1);
    assert.strictEqual(again.created, false, "an existing identity must not be recreated");
    assert.strictEqual(String(again.identity.id), String(first.identity.id));
    assert.strictEqual(String(again.identity.profileId), String(first.identity.profileId));

    assert.strictEqual(
      Number((await pool.query("SELECT COUNT(*) n FROM identities")).rows[0].n),
      identitiesBefore,
      "no identity may be created for an existing channel_ref"
    );
    assert.strictEqual(
      Number((await pool.query("SELECT COUNT(*) n FROM profiles")).rows[0].n),
      profilesBefore,
      "no profile may be created for an existing channel_ref"
    );
  });

  it("E — concurrent provisions for different refs do not collapse into one identity", async () => {
    const refs = Array.from({ length: 8 }, (_, i) => fixtureRef(`multi${i}`));
    const results = await Promise.all(refs.map((r) => findOrCreateWebChatGuestIdentity(r, 1)));

    const identityIds = new Set(results.map((r) => String(r.identity.id)));
    const profileIds = new Set(results.map((r) => String(r.identity.profileId)));
    assert.strictEqual(identityIds.size, refs.length, "each channel_ref must get its own identity");
    assert.strictEqual(profileIds.size, refs.length, "each channel_ref must get its own profile");

    for (const ref of refs) {
      assert.strictEqual((await identitiesFor(ref)).length, 1, `${ref} must have exactly one identity`);
    }
  });

  it("the check-then-insert sequence is gone from the handshake", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(
      new URL("../../src/presentation/http/routes/WebChatGateway.ts", import.meta.url),
      "utf8"
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");

    assert.ok(
      /findOrCreateWebChatGuestIdentity\(/.test(code),
      "the handshake must provision through the atomic helper"
    );
    // Scoped to the guest branch. A separate MAX(id)+1 still exists in the
    // join-code fallback further down this file; that is a different path,
    // owned by ISSUE-058, and is reported as a residual risk rather than
    // silently widened into this change.
    const guestBranch = code.split("if (isGuest) {")[1]?.split("} else {")[0] ?? "";
    assert.ok(guestBranch.length > 0, "expected to locate the guest branch");
    assert.ok(
      !/COALESCE\(MAX\(/.test(guestBranch),
      "the guest branch must not allocate a profile id with MAX(id)+1"
    );
    assert.ok(
      !/profileRepo\.save\(guestProfile\)/.test(code),
      "the unguarded guest profile save must be gone"
    );
  });

  it("the atomic helper conflicts on the constraint that governs uniqueness", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(
      new URL("../../src/infrastructure/db/guestIdentityProvisioning.ts", import.meta.url),
      "utf8"
    );
    // Comments in that file quote the old, broken clause when explaining the
    // bug, so the assertion has to look at executable code only.
    const helperCode = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.ok(
      /ON CONFLICT \(channel, channel_ref\) DO NOTHING/.test(helperCode),
      "the identity insert must declare (channel, channel_ref) as its conflict target"
    );
    assert.ok(
      !/ON CONFLICT \(id\)/.test(helperCode),
      "conflicting on (id) is what failed to arbitrate the race"
    );
    assert.ok(
      /pg_advisory_xact_lock/.test(helperCode),
      "profile-id allocation must be serialised by a transaction-scoped database lock"
    );
  });
});
