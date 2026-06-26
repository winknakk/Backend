import { pool } from "./PostgresAdapter";
import { runMigrations } from "./migrations";
import { createLogger } from "../../observability/logger";

const logger = createLogger("migrations-cli");

async function main() {
  logger.info("Starting decoupled database migration runner...");
  try {
    await runMigrations(pool);
    logger.info("Decoupled database migration completed successfully.");
    await pool.end();
    process.exit(0);
  } catch (err: any) {
    logger.error({ error: err.message }, "Decoupled database migration failed!");
    try {
      await pool.end();
    } catch {}
    process.exit(1);
  }
}

main();
