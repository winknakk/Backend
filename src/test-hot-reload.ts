import * as fs from "fs";
import * as path from "path";
import { startConfigWatcher, stopConfigWatcher } from "./cache/ConfigWatcher";
import { CacheService } from "./cache/CacheService";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    Testing Config Hot Reload Watchers");
  console.log("=========================================");

  const cache = CacheService.getInstance();
  await cache.clear();

  // 1. Start Config Watcher
  console.log("Starting FS watchers...");
  startConfigWatcher();

  // 2. Set cache values to test cache eviction
  const promptCacheKey = "tenant:global:prompt:test-reload:default";
  await cache.set(promptCacheKey, { template: "hello world v1" }, 60);

  // Assert it exists in cache
  const cachedBefore = await cache.get(promptCacheKey);
  assert(cachedBefore !== null, "Value must be in cache initially");

  // 3. Write a dummy file to the prompts folder to trigger the watcher
  const promptDir = path.resolve(process.cwd(), "prompts");
  if (!fs.existsSync(promptDir)) {
    fs.mkdirSync(promptDir, { recursive: true });
  }

  const dummyFilePath = path.join(promptDir, "test-reload-watcher.prompt");
  console.log(`Writing dummy prompt file to trigger watcher: ${dummyFilePath}`);
  fs.writeFileSync(dummyFilePath, "dummy content", "utf-8");

  // 4. Wait for FS event propagation (chokidar/FS events might have a slight delay)
  console.log("Waiting for FS event callback to propagate...");
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 5. Assert cache was cleared automatically
  const cachedAfter = await cache.get(promptCacheKey);
  assert(cachedAfter === null, "Cache must be cleared after prompt file is modified");
  console.log("Cache successfully cleared by hot reload watcher!");

  // Clean up dummy file
  try {
    if (fs.existsSync(dummyFilePath)) {
      fs.unlinkSync(dummyFilePath);
    }
  } catch {}

  // 6. Stop Watcher
  console.log("Stopping FS watchers...");
  stopConfigWatcher();

  await cache.disconnect();

  console.log("✅ Config Hot Reload tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
