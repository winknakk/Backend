import type { Pool, PoolClient } from "pg";
import { createLogger } from "../../observability/logger";

const logger = createLogger("postgres-sequences");

/**
 * Anything that can run a query — pool, client, or an open transaction.
 * Taking the connection as an argument keeps this module free of an import
 * cycle with PostgresAdapter, which is itself a consumer.
 */
type Queryable = Pick<Pool | PoolClient, "query">;

const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Allocates the next id from the table's own SERIAL sequence.
 *
 * Replaces `SELECT COALESCE(MAX(id),0)+1`, which had two defects: it never
 * advanced the sequence — so rows created here collided with rows created by
 * writers that rely on the DEFAULT nextval() (see migration 043) — and two
 * concurrent requests could read the same max and insert the same id.
 *
 * Returns the id as a string because the sequence is a bigint; callers pass it
 * straight back as a query parameter.
 */
export async function nextSequenceId(
  db: Queryable,
  table: string,
  column: string = "id"
): Promise<string> {
  if (!SAFE_TABLE_NAME.test(table) || !SAFE_TABLE_NAME.test(column)) {
    throw new Error(`Unsafe identifier passed to nextSequenceId: ${table}.${column}`);
  }

  const { rows } = await db.query(
    `SELECT nextval(pg_get_serial_sequence($1, $2))::text AS next_id`,
    [table, column]
  );

  const nextId = rows[0]?.next_id;
  if (!nextId) {
    // pg_get_serial_sequence returns NULL when the column has no owning
    // sequence (e.g. profiles.id, which is a varchar with no default).
    throw new Error(`No sequence owns ${table}.${column}`);
  }

  return String(nextId);
}

export interface SequenceRealignment {
  sequence: string;
  table: string;
  from: string | null;
  to: string;
}

/**
 * Moves every SERIAL sequence in the current schema forward so it sits at or
 * above the largest id already stored in its table.
 *
 * Migration 043 does this once; this runs it again on every boot, because a
 * migration is recorded in schema_migrations and never replayed — while a
 * database restore, a seed file, or any hand-written INSERT with an explicit id
 * can reintroduce the drift at any time.
 *
 * Only ever moves a counter forward. Rewinding a sequence below MAX(id) is what
 * produced the original duplicate-key outage.
 */
export async function syncSerialSequences(db: Queryable): Promise<SequenceRealignment[]> {
  const { rows } = await db.query(`
    WITH serial_columns AS (
      SELECT
        c.table_name,
        c.column_name,
        pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) AS seq
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND t.table_type = 'BASE TABLE'
        AND c.column_default LIKE 'nextval(%'
    )
    SELECT
      sc.table_name,
      sc.seq,
      s.last_value
    FROM serial_columns sc
    JOIN pg_class cl ON cl.oid = sc.seq::regclass
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    LEFT JOIN pg_sequences s
      ON s.schemaname = n.nspname AND s.sequencename = cl.relname
    WHERE sc.seq IS NOT NULL
      AND sc.column_name = 'id'
  `);

  const realigned: SequenceRealignment[] = [];

  for (const row of rows) {
    const table: string = row.table_name;
    const seq: string = row.seq;
    if (!SAFE_TABLE_NAME.test(table)) continue;

    const maxRes = await db.query(`SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM "${table}"`);
    const maxId = BigInt(maxRes.rows[0].max_id);
    const lastValue = row.last_value === null || row.last_value === undefined ? null : BigInt(row.last_value);

    // Untouched sequence over an empty table: leave it so nextval() still starts at 1.
    if (maxId === 0n && lastValue === null) continue;
    if (lastValue !== null && lastValue >= maxId) continue;

    const target = maxId > (lastValue ?? 0n) ? maxId : (lastValue ?? 0n);
    if (target < 1n) continue;

    await db.query(`SELECT setval($1::regclass, $2::bigint, TRUE)`, [seq, target.toString()]);

    realigned.push({
      sequence: seq,
      table,
      from: lastValue === null ? null : lastValue.toString(),
      to: target.toString()
    });
  }

  if (realigned.length > 0) {
    logger.warn(
      { realigned },
      "Realigned drifted SERIAL sequences — an explicit-id INSERT bypassed the sequence"
    );
  } else {
    logger.info("All SERIAL sequences are aligned with their table data");
  }

  return realigned;
}
