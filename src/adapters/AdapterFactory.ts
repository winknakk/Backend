import { DatabaseAdapter } from "./types";
import { LocalDataAdapter } from "./local-data/LocalDataAdapter";
import { NocoDBAdapter } from "../piece-adapter/NocoDBAdapter";
import { PostgresAdapter } from "./postgres/PostgresAdapter";

export class AdapterFactory {
  /**
   * Factory method to load the correct Database Adapter based on env variables.
   * DATABASE_PROVIDER = local | nocodb | postgres
   */
  static getAdapter(): DatabaseAdapter {
    const provider = process.env.DATABASE_PROVIDER || "local";
    console.log(`[AdapterFactory] Resolving Database Adapter for provider: "${provider}"`);
    if (provider.toLowerCase() === "nocodb") {
      return new NocoDBAdapter();
    } else if (provider.toLowerCase() === "postgres") {
      return new PostgresAdapter();
    } else {
      return new LocalDataAdapter();
    }
  }
}
