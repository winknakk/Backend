import { AdapterFactory } from "./adapters/AdapterFactory";
import { pool } from "./adapters/postgres/PostgresAdapter";
import { config } from "./config/env";
import { PlaneWebhookService } from "./services/planeWebhookService";

async function run(): Promise<void> {
  const adapter = AdapterFactory.getAdapter();
  const service = new PlaneWebhookService(adapter);

  try {
    const summary = await service.syncLinkedTicketsFromPlane();
    console.log(JSON.stringify({ planeReverseSync: summary }));
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    if (config.DATABASE_PROVIDER === "postgres") await pool.end();
  }
}

run().catch((error) => {
  console.error(`Plane reverse sync failed: ${error.message}`);
  process.exit(1);
});
