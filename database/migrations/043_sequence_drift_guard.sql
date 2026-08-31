-- ============================================================
-- 043_sequence_drift_guard.sql
-- Repairs SERIAL sequence drift across the whole schema.
--
-- Root cause this fixes:
--   Some writers inserted an explicit id computed as MAX(id)+1, which never
--   advances the owning sequence, while others rely on the DEFAULT nextval().
--   Once MAX(id) climbs past the sequence, nextval() hands out an id that
--   already exists and the INSERT dies with
--     duplicate key value violates unique constraint "<table>_pkey".
--   Observed 2026-08-28 on conversations: last_value 1195 vs MAX(id) 1200,
--   which made every new LINE project-join fail with HTTP 503.
--
-- GREATEST(max_id, last_value) is deliberate: never rewind a sequence that is
-- legitimately ahead of MAX(id) (gaps from deleted rows or rolled-back
-- transactions). Rewinding is what recreates the outage.
--
-- Sequence counters are not transactional; this migration is idempotent and
-- safe to replay.
-- ============================================================

DO $$
DECLARE
  col          RECORD;
  seq_name     TEXT;
  seq_schema   TEXT;
  seq_relname  TEXT;
  max_id       BIGINT;
  last_val     BIGINT;
  target       BIGINT;
BEGIN
  FOR col IN
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema()
      AND t.table_type = 'BASE TABLE'
      AND c.column_default LIKE 'nextval(%'
    ORDER BY c.table_name, c.column_name
  LOOP
    seq_name := pg_get_serial_sequence(
      format('%I.%I', col.table_schema, col.table_name),
      col.column_name
    );
    CONTINUE WHEN seq_name IS NULL;

    SELECT n.nspname, cl.relname
      INTO seq_schema, seq_relname
      FROM pg_class cl
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE cl.oid = seq_name::regclass;

    EXECUTE format(
      'SELECT COALESCE(MAX(%I), 0) FROM %I.%I',
      col.column_name, col.table_schema, col.table_name
    ) INTO max_id;

    -- last_value is NULL while the sequence has never been read.
    SELECT s.last_value
      INTO last_val
      FROM pg_sequences s
     WHERE s.schemaname = seq_schema
       AND s.sequencename = seq_relname;

    -- Untouched sequence over an empty table: leave it alone so the first
    -- nextval() still returns 1.
    CONTINUE WHEN max_id = 0 AND last_val IS NULL;

    target := GREATEST(max_id, COALESCE(last_val, 0));
    CONTINUE WHEN target < 1;

    PERFORM setval(seq_name, target, TRUE);

    RAISE NOTICE 'sequence % realigned to % (table max %, previous last_value %)',
      seq_name, target, max_id, COALESCE(last_val::TEXT, 'never used');
  END LOOP;
END $$;
