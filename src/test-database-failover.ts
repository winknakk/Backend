import { PostgresAdapter, pool, replicaPool } from "./adapters/postgres/PostgresAdapter";
import { BackupManager } from "./adapters/postgres/BackupManager";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    Testing Database Failover & Backups");
  console.log("=========================================");

  // Seed the local encrypted backup
  console.log("Seeding local encrypted backup...");
  const mockProject = { id: "p-failover-123", name: "Backup Project Title" };
  await BackupManager.saveToBackup("projects", mockProject, "id");

  const adapter = new PostgresAdapter();

  // 1. Mock primary pool failure, but replica succeeds
  console.log("Simulating primary failure -> replica success...");
  const originalPoolQuery = pool.query;
  const originalReplicaQuery = replicaPool.query;

  pool.query = (async () => {
    throw new Error("Primary DB Offline Connection Error");
  }) as any;

  let replicaCalled: boolean = false;
  replicaPool.query = (async (text: string, params: any[]) => {
    replicaCalled = true;
    return {
      rows: [{ id: "p-failover-123", name: "Replica Project Title" }],
    };
  }) as any;

  try {
    const proj = await adapter.findProject("p-failover-123");
    assert(proj !== null, "Project must not be null");
    assert(proj.name === "Replica Project Title", "Should return data from replica");
    assert(replicaCalled, "Replica pool must have been called");
  } finally {
    pool.query = originalPoolQuery;
    replicaPool.query = originalReplicaQuery;
  }

  // 2. Mock both primary and replica failure -> fallback to local encrypted backup
  console.log("Simulating both primary and replica failures -> local backup fallback...");

  pool.query = (async () => {
    throw new Error("Primary Offline");
  }) as any;

  replicaPool.query = (async () => {
    throw new Error("Replica Offline");
  }) as any;

  try {
    const projBackup = await adapter.findProject("p-failover-123");
    assert(projBackup !== null, "Project must be found in backup");
    assert(projBackup.name === "Backup Project Title", "Should return decrypted data from local backup file");
  } finally {
    pool.query = originalPoolQuery;
    replicaPool.query = originalReplicaQuery;
  }

  console.log("✅ Database Failover & Backup tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
