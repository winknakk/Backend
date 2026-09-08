import { pool } from "../../adapters/postgres/PostgresAdapter";
import { Identity } from "../../domain/entities/Identity";
import { IdentityMapper } from "./mappers/IdentityMapper";
import { createLogger } from "../../observability/logger";

const logger = createLogger("guest-provisioning");

/**
 * Atomically resolves — or creates exactly once — the identity behind a WebChat
 * guest handshake.
 *
 * The handshake used to do this, and it raced on two separate rows (ISSUE-063):
 *
 *   identity = findByChannelAndRef("WebChat", channelRef)
 *   if (!identity) {
 *     SELECT COALESCE(MAX(id),0)+1 FROM profiles   // profile id
 *     profileRepo.save(...)                        // ON CONFLICT (id) DO UPDATE
 *     identityRepo.save(...)                       // ON CONFLICT (id) DO UPDATE
 *   }
 *
 * Two concurrent first contacts for the same `channel_ref` both saw "not found":
 *
 *   - The identity insert declared its conflict target as `(id)`, and each
 *     racer held a different id from the sequence, so that clause never fired.
 *     They collided instead on `uq_identities_channel_ref UNIQUE (channel,
 *     channel_ref)` — which nothing handled — and one request died with
 *     `duplicate key value violates unique constraint`.
 *   - Worse and silent: `profiles.id` is VARCHAR with no default and no
 *     sequence, so ids came from `MAX(id)+1`. Both racers read the same
 *     maximum, and the profile insert's `ON CONFLICT (id) DO UPDATE` meant the
 *     second guest quietly *overwrote* the first guest's profile row. No error
 *     was raised; two visitors simply shared one profile.
 *
 * The database is the only arbiter here. Correctness rests on
 * `ON CONFLICT (channel, channel_ref) DO NOTHING RETURNING`: exactly one
 * transaction gets a row back, and the loser rolls back — which also discards
 * its speculative profile, so a lost race leaves nothing behind. Re-reading
 * afterwards is a read of the winner's committed row, not a retry loop.
 *
 * The advisory lock covers only the `MAX+1` profile-id allocation, which has no
 * constraint to arbitrate it. It is a transaction-scoped Postgres lock, not an
 * application mutex: it spans every process and replica and is released on
 * commit or rollback, including on crash. Giving `profiles.id` a sequence or a
 * UUID default would remove the need for it, but that is a migration.
 */

/** Namespaced so the key cannot collide with another advisory lock user. */
const PROFILE_ALLOC_LOCK_KEY = "webchat_guest_profile_alloc";

export interface GuestProvisioningResult {
  identity: Identity;
  /** False when an existing identity was reused, or when another racer won. */
  created: boolean;
}

export async function findOrCreateWebChatGuestIdentity(
  channelRef: string,
  companyId: number | string
): Promise<GuestProvisioningResult> {
  // Fast path: already provisioned. No transaction, no lock — this is the
  // overwhelming majority of handshakes.
  const existing = await pool.query(
    `SELECT * FROM identities WHERE LOWER(channel) = 'webchat' AND channel_ref = $1 LIMIT 1`,
    [channelRef]
  );
  if (existing.rows.length > 0) {
    return { identity: IdentityMapper.toDomain(existing.rows[0]), created: false };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serialises profile-id allocation only. Released automatically when this
    // transaction ends, however it ends.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [PROFILE_ALLOC_LOCK_KEY]);

    // Re-read inside the lock: a racer that committed between the fast path
    // and here is now visible.
    const recheck = await client.query(
      `SELECT * FROM identities WHERE LOWER(channel) = 'webchat' AND channel_ref = $1 LIMIT 1`,
      [channelRef]
    );
    if (recheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return { identity: IdentityMapper.toDomain(recheck.rows[0]), created: false };
    }

    const nextProfileIdRes = await client.query(
      `SELECT COALESCE(MAX(CASE WHEN id::text ~ '^[0-9]+$' THEN id::bigint ELSE 0 END), 0) + 1 AS next_id
         FROM profiles`
    );
    const profileId = String(nextProfileIdRes.rows[0].next_id);

    await client.query(
      `INSERT INTO profiles (id, company_id, name, created_at, is_pii_erased, is_merged)
       VALUES ($1, $2, $3, NOW(), false, false)`,
      [profileId, Number(companyId) || 1, `Guest_${channelRef.slice(0, 8)}`]
    );

    // `id` is omitted so the column DEFAULT nextval('identities_id_seq')
    // assigns it — one less value to allocate and one less chance to reuse one.
    //
    // The conflict target is the constraint that actually governs uniqueness
    // for this row, which is what the old code got wrong.
    const inserted = await client.query(
      `INSERT INTO identities (profile_id, channel, channel_ref, created_at, is_pii, is_shared_account)
       VALUES ($1, 'WebChat', $2, NOW(), false, false)
       ON CONFLICT (channel, channel_ref) DO NOTHING
       RETURNING *`,
      [profileId, channelRef]
    );

    if (inserted.rows.length === 0) {
      // Another transaction committed this channel_ref first. Roll back —
      // which discards the profile inserted above, so the lost race leaves no
      // orphan — and read the winner's row.
      await client.query("ROLLBACK");
      const winner = await pool.query(
        `SELECT * FROM identities WHERE LOWER(channel) = 'webchat' AND channel_ref = $1 LIMIT 1`,
        [channelRef]
      );
      if (winner.rows.length === 0) {
        // Only reachable if the winner rolled back after we observed its
        // conflict. Surfacing it is honest; inventing an identity is not.
        throw new Error(`WebChat guest identity for ${channelRef} vanished after a lost insert race`);
      }
      logger.info({ channelRef }, "Concurrent guest handshake converged on the existing identity");
      return { identity: IdentityMapper.toDomain(winner.rows[0]), created: false };
    }

    await client.query("COMMIT");
    return { identity: IdentityMapper.toDomain(inserted.rows[0]), created: true };
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
