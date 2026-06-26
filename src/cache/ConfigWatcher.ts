import * as fs from "fs";
import * as path from "path";
import { CacheService } from "./CacheService";
import { createLogger } from "../observability/logger";

const logger = createLogger("ConfigWatcher");

let promptWatcher: fs.FSWatcher | null = null;
let policyWatcher: fs.FSWatcher | null = null;

export function startConfigWatcher() {
  const promptDir = path.resolve(process.cwd(), "prompts");
  const policyDir = path.resolve(process.cwd(), "agent-policies");

  const watchDir = (dirPath: string, type: "prompt" | "policy"): fs.FSWatcher | null => {
    if (!fs.existsSync(dirPath)) {
      try {
        fs.mkdirSync(dirPath, { recursive: true });
      } catch (err: any) {
        logger.warn({ error: err.message, dirPath }, "Failed to create directory for watching");
        return null;
      }
    }

    logger.info(`Starting dynamic config watcher for ${type} directory: ${dirPath}`);

    try {
      return fs.watch(dirPath, { recursive: true }, async (eventType, filename) => {
        if (!filename) return;
        logger.info({ eventType, filename, type }, `Dynamic config file change detected. Evicting caches.`);

        // Instantly invalidate caches
        await CacheService.getInstance().clear();
      });
    } catch (err: any) {
      logger.error({ error: err.message, dirPath }, "Failed to start FS watcher");
      return null;
    }
  };

  promptWatcher = watchDir(promptDir, "prompt");
  policyWatcher = watchDir(policyDir, "policy");
}

export function stopConfigWatcher() {
  if (promptWatcher) {
    promptWatcher.close();
    promptWatcher = null;
  }
  if (policyWatcher) {
    policyWatcher.close();
    policyWatcher = null;
  }
  logger.info("Dynamic config watchers stopped.");
}
