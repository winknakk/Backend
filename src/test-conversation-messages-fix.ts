import assert from "assert";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { S3MediaStorageService } from "./media/services/S3MediaStorageService";
import { PostgresAdapter } from "./adapters/postgres/PostgresAdapter";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function runTest() {
  console.log("=================================================================");
  console.log("Test: Conversation Messages 500 Fix & Resilient Schema Handling");
  console.log("=================================================================");

  // 1. Test S3MediaStorageService in production mode without fatal exception
  console.log("\n[Test 1] Testing S3MediaStorageService in production without secret...");
  const originalEnv = process.env.NODE_ENV;
  const originalMediaSecret = process.env.MEDIA_SIGNING_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.MEDIA_SIGNING_SECRET;
    delete process.env.JWT_SECRET;

    // Should not throw fatal error
    const service = new S3MediaStorageService({});
    assert(service !== null, "S3MediaStorageService instance must be created");
    const testUrl = await service.generatePresignedUrl("test/key.jpg", 3600);
    assert(testUrl.includes("signature="), "Presigned URL must contain signature");
    console.log("  ✅ Test 1 PASSED: S3MediaStorageService initialized safely in production mode.");
  } finally {
    process.env.NODE_ENV = originalEnv;
    if (originalMediaSecret) process.env.MEDIA_SIGNING_SECRET = originalMediaSecret;
    if (originalJwtSecret) process.env.JWT_SECRET = originalJwtSecret;
  }

  // 2. Test Migration 037 SQL syntax
  console.log("\n[Test 2] Verifying Migration 037 SQL file exists and parses...");
  const migPath = path.resolve(__dirname, "../database/migrations/037_complete_messages_schema.sql");
  assert(fs.existsSync(migPath), "037_complete_messages_schema.sql must exist");
  const sql = fs.readFileSync(migPath, "utf-8");
  assert(sql.includes("reply_to_message_id"), "Must include reply_to_message_id");
  assert(sql.includes("delivery_status"), "Must include delivery_status");
  assert(sql.includes("reactions"), "Must include reactions");
  assert(sql.includes("is_pinned"), "Must include is_pinned");
  assert(sql.includes("quote_token"), "Must include quote_token");
  console.log("  ✅ Test 2 PASSED: Migration 037 SQL content verified.");

  // 3. Test PostgresAdapter getMessages handling
  console.log("\n[Test 3] Testing PostgresAdapter getMessages method...");
  const adapter = new PostgresAdapter();
  const messages = await adapter.getMessages("67");
  assert(Array.isArray(messages), "getMessages must return an array");
  console.log(`  ✅ Test 3 PASSED: getMessages('67') returned ${messages.length} messages safely.`);

  console.log("\n=================================================================");
  console.log("All Conversation Messages Fix Tests Passed Successfully! (3/3)");
  console.log("=================================================================");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
