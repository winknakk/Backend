/**
 * Where live tests are allowed to run.
 *
 * The audit proved this is not theoretical: a row inserted into
 * `cs_tickets.outbox_events` as `pending` was flipped to `processed` within 25
 * seconds by a consumer outside this environment — a deployed backend polling
 * the same database. So the live tests were not merely flaky, they were
 * writing into the production outbox and racing production for it.
 *
 * The default is therefore to refuse. A test that would write to the shared
 * primary skips with an explicit BLOCKED reason instead of running, so a fresh
 * clone or a CI job cannot quietly start mutating production.
 *
 * Two ways to run:
 *
 *   TEST_DATABASE_URL=postgres://…      an isolated database. Preferred.
 *   ALLOW_LIVE_TESTS_ON_PRIMARY=true    an explicit, deliberate override.
 *
 * The override exists because the isolated database does not exist yet, and
 * removing the tests in the meantime would lose real coverage. It is a stated
 * exception, not a default.
 */

export interface TestDatabaseDecision {
  /** True when a dedicated test database is configured. */
  isolated: boolean;
  /** True when the test may proceed at all. */
  allowed: boolean;
  /** Set when the test must skip; suitable to pass straight to t.skip(). */
  skipReason?: string;
  /** Connection string to use, when one was configured explicitly. */
  url?: string;
}

export function resolveTestDatabase(): TestDatabaseDecision {
  const isolatedUrl = process.env.TEST_DATABASE_URL;
  if (isolatedUrl && isolatedUrl.trim()) {
    return { isolated: true, allowed: true, url: isolatedUrl.trim() };
  }

  if (String(process.env.ALLOW_LIVE_TESTS_ON_PRIMARY || "").toLowerCase() === "true") {
    return { isolated: false, allowed: true };
  }

  return {
    isolated: false,
    allowed: false,
    skipReason:
      "BLOCKED: no isolated test database. This test writes rows a production consumer will pick up. " +
      "Set TEST_DATABASE_URL to an isolated database, or ALLOW_LIVE_TESTS_ON_PRIMARY=true to override deliberately.",
  };
}

/**
 * True when the test is about to mutate shared state that a production worker
 * also consumes — the outbox being the proven case.
 */
export function requiresIsolatedDatabase(): TestDatabaseDecision {
  return resolveTestDatabase();
}
