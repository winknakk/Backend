-- ============================================================================
-- Migration 025: Repair swapped Ticket Intelligence column types
-- ============================================================================
-- The runtime repository persists ai_confidence_metrics as JSON and
-- enrichment_state as a bounded string. Some PostgreSQL V3 databases were
-- created with those physical types reversed, which makes any aggregate save
-- (including close_ticket) fail with "invalid input syntax for type json".

CREATE OR REPLACE FUNCTION pg_temp.ticketx_try_parse_jsonb(input_value text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN input_value::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  metrics_type text;
  state_type text;
BEGIN
  SELECT data_type
  INTO metrics_type
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'tickets'
    AND column_name = 'ai_confidence_metrics';

  IF metrics_type IS NOT NULL AND metrics_type <> 'jsonb' THEN
    ALTER TABLE tickets
      ALTER COLUMN ai_confidence_metrics DROP DEFAULT;

    ALTER TABLE tickets
      ALTER COLUMN ai_confidence_metrics TYPE jsonb
      USING COALESCE(
        pg_temp.ticketx_try_parse_jsonb(ai_confidence_metrics::text),
        '{"title":0,"summary":0,"duplicate":0}'::jsonb
      );
  END IF;

  UPDATE tickets
  SET ai_confidence_metrics = '{"title":0,"summary":0,"duplicate":0}'::jsonb
  WHERE ai_confidence_metrics IS NULL;

  ALTER TABLE tickets
    ALTER COLUMN ai_confidence_metrics
      SET DEFAULT '{"title":0,"summary":0,"duplicate":0}'::jsonb;

  SELECT data_type
  INTO state_type
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'tickets'
    AND column_name = 'enrichment_state';

  IF state_type IS NOT NULL AND state_type NOT IN ('character varying', 'text') THEN
    ALTER TABLE tickets
      ALTER COLUMN enrichment_state DROP DEFAULT;

    ALTER TABLE tickets
      ALTER COLUMN enrichment_state TYPE varchar(50)
      USING CASE
        WHEN enrichment_state IS NULL THEN 'PENDING'
        WHEN jsonb_typeof(enrichment_state) = 'string'
          THEN COALESCE(NULLIF(enrichment_state #>> '{}', ''), 'PENDING')
        WHEN jsonb_typeof(enrichment_state) = 'object'
          THEN COALESCE(NULLIF(enrichment_state ->> 'state', ''), 'PENDING')
        ELSE 'PENDING'
      END;
  END IF;

  UPDATE tickets
  SET enrichment_state = UPPER(BTRIM(enrichment_state))
  WHERE enrichment_state IS NOT NULL;

  UPDATE tickets
  SET enrichment_state = 'PENDING'
  WHERE enrichment_state IS NULL
     OR enrichment_state NOT IN ('PENDING', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED');

  ALTER TABLE tickets
    ALTER COLUMN enrichment_state SET DEFAULT 'PENDING',
    ALTER COLUMN enrichment_state SET NOT NULL;
END;
$$;
