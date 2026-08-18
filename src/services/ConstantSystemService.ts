import { createLogger } from "../observability/logger";
import { pool } from "../adapters/postgres/PostgresAdapter";

const logger = createLogger("ConstantSystemService");

export class ConstantSystemService {
  /**
   * Get Constant Value by Key with fallback
   */
  static async getConstant(key: string, defaultValue: string): Promise<string> {
    // 1. Check environment variable first
    if (process.env[key]) {
      return process.env[key]!;
    }

    // 2. Try database lookup if pool is available
    try {
      if (pool) {
        const res = await pool.query(
          "SELECT constant_value FROM system_constants WHERE constant_key = $1 LIMIT 1",
          [key]
        );
        if (res.rows.length > 0 && res.rows[0].constant_value) {
          return res.rows[0].constant_value;
        }
      }
    } catch (err: any) {
      // Table may not exist yet or DB connection error, ignore and use fallback
      logger.debug({ key, error: err.message }, "ConstantSystem DB lookup skipped/failed");
    }

    // 3. Fallback default
    return defaultValue;
  }

  /**
   * Get Center CM Service Base URL
   */
  static async getCenterCmServiceUrl(): Promise<string> {
    const url = await this.getConstant(
      "CENTER_CM_SERVICE_URL",
      "https://centerapp.io/cm-service/api/v1"
    );
    return url.replace(/\/$/, "");
  }
}
