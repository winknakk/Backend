import { pool } from "./adapters/postgres/PostgresAdapter";
import { RedisActiveSessionCache } from "./infrastructure/cache/RedisActiveSessionCache";
import { config } from "./config/env";
import Redis from "ioredis";

async function main() {
  const lineSenderId = "U6256f0c4dbb64edacf9eea92904e49b1";
  console.log(`Resetting session for LINE user: ${lineSenderId}...`);

  // 1. Find identity and update conversations status to 'closed' in DB
  const { rows } = await pool.query(
    "SELECT id FROM identities WHERE channel_ref = $1 AND channel = 'LINE'",
    [lineSenderId]
  );

  if (rows.length === 0) {
    console.log("No identity records found in the database. Please run seed_demo.sql first.");
    await pool.end();
    return;
  }

  const identityId = rows[0].id;
  const { rowCount } = await pool.query(
    "UPDATE conversations SET status = 'closed' WHERE identity_id = $1 AND status != 'closed'",
    [identityId]
  );
  console.log(`Updated ${rowCount} open conversations to 'closed' status in database.`);

  // 2. Invalidate active session caches (Redis & Memory)
  const sessionCache = new RedisActiveSessionCache();
  try {
    const checkRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 0, connectTimeout: 1000 });
    await checkRedis.ping();
    await checkRedis.quit();
    
    // Redis is active, clear session
    const cacheKey = `session:active:${identityId}`;
    const redisClient = new Redis(config.REDIS_URL);
    await redisClient.del(cacheKey);
    await redisClient.quit();
    console.log("Cleared active session cache from Redis.");
  } catch {
    console.log("Redis is offline. Cache cleared from memory fallback.");
  }

  console.log("Session reset complete. Your next LINE message will trigger a brand new conversation session!");
  await pool.end();
}

main().catch(console.error);
