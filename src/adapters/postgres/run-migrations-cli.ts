import { pool } from "./PostgresAdapter";
import { runMigrations } from "./migrations";
import { createLogger } from "../../observability/logger";

const logger = createLogger("migrations-cli");

async function main() {
  logger.info("Starting decoupled database migration runner...");
  try {
    const onlyEqualsArg = process.argv.find((value) => value.startsWith("--only="));
    const onlyFlagIndex = process.argv.indexOf("--only");
    const only = onlyEqualsArg
      ? onlyEqualsArg.slice("--only=".length)
      : onlyFlagIndex >= 0
        ? process.argv[onlyFlagIndex + 1]
        : undefined;

    if (onlyFlagIndex >= 0 && !only) {
      throw new Error("Missing migration filename after --only");
    }

    await runMigrations(pool, { only });
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
