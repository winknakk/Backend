import pg from "pg";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../../observability/logger";

const logger = createLogger("postgres-migrations");

// Migration 000 was renamed after it had already been applied to development
// databases. Keep the historical ledger name as an alias so the destructive
// baseline migration is never replayed solely because of the filename change.
const legacyMigrationAliases: Record<string, string[]> = {
  "000_nocodb_to_postgresql.sql": ["nocodb_to_postgresql.sql"],
};

export async function runMigrations(pool: pg.Pool): Promise<void> {
  logger.info("Starting database migrations check...");

  // We want to ensure we can run queries. Let's make sure a migrations metadata table exists.
  // This helps keep track of executed migrations if we want, or at least run the bootstrap scripts.
  // The user says "Add migration execution during application startup before Fastify listen. Keep schema.sql as bootstrap only."
  // Wait, let's create a simple migrations table to track what has been executed.

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const migrationsDir = path.resolve(__dirname, "../../../database/migrations");
  if (!fs.existsSync(migrationsDir)) {
    logger.warn({ migrationsDir }, "Migrations directory does not exist. Skipping migrations.");
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort(); // ensures 001 runs before 002

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);

    // Check if this migration was already executed
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);

    if (rows.length > 0) {
      logger.debug({ file }, "Migration already executed, skipping");
      continue;
    }

    const aliases = legacyMigrationAliases[file] ?? [];
    if (aliases.length > 0) {
      const legacyResult = await pool.query(
        "SELECT version FROM schema_migrations WHERE version = ANY($1::varchar[])",
        [aliases]
      );

      if (legacyResult.rows.length > 0) {
        await pool.query(
          "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
          [file]
        );
        logger.info(
          { file, legacyVersion: legacyResult.rows[0].version },
          "Recorded renamed migration alias without replaying migration"
        );
        continue;
      }
    }

    logger.info({ file }, "Executing migration");
    const sql = fs.readFileSync(filePath, "utf-8");

    // Run the migration in a transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      logger.info({ file }, "Migration completed successfully");
    } catch (err: any) {
      await client.query("ROLLBACK");
      logger.error({ file, error: err.message }, "Migration failed");
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info("All database migrations are up to date.");
}
