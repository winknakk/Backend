import { pool } from "./PostgresAdapter";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../../observability/logger";

const logger = createLogger("seeds-cli");

async function main() {
  // Determine seed file name from command line argument (e.g. --file=seed_demo.sql) or default to seed_dev.sql
  let seedFile = "seed_dev.sql";
  const fileArg = process.argv.find(arg => arg.startsWith("--file="));
  if (fileArg) {
    seedFile = fileArg.split("=")[1];
  }

  logger.info({ seedFile }, "Starting database seed runner...");

  const seedsDir = path.resolve(__dirname, "../../../database/seeds");
  const filePath = path.join(seedsDir, seedFile);

  if (!fs.existsSync(filePath)) {
    logger.error({ filePath }, "Seed file does not exist!");
    process.exit(1);
  }

  const sql = fs.readFileSync(filePath, "utf-8");
  const client = await pool.connect();
  let exitCode = 0;

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    logger.info({ seedFile }, "Database seeding completed successfully.");
  } catch (err: any) {
    await client.query("ROLLBACK");
    logger.error({ seedFile, error: err.message }, "Database seeding failed!");
    exitCode = 1;
  } finally {
    client.release();
  }

  await pool.end();
  process.exitCode = exitCode;
}

main().catch(async (err: any) => {
  logger.error({ error: err.message }, "Database seed runner failed before transaction completion!");
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
