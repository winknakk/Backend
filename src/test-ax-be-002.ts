import { pool } from "./adapters/postgres/PostgresAdapter";
import { TransactionManager } from "./shared/repositories/TransactionManager";
import { BaseRepository } from "./shared/repositories/BaseRepository";
import { UnitOfWork } from "./shared/repositories/UnitOfWork";
import { BaseAggregate } from "./shared/domain/BaseAggregate";
import { BaseDomainEvent } from "./shared/domain/BaseDomainEvent";

// ─── HELPER MODELS FOR TESTING ───────────────────────────────────────────

class TestEvent extends BaseDomainEvent {
  constructor(public readonly aggId: string) {
    super();
  }
  getAggregateId(): string {
    return this.aggId;
  }
}

class TestAggregate extends BaseAggregate<string> {
  constructor(id: string) {
    super(id);
  }
  public doSomething(): void {
    this.addDomainEvent(new TestEvent(this.id));
  }
}

class TestRepository extends BaseRepository<TestAggregate, string> {
  async findById(id: string): Promise<TestAggregate | null> {
    const { rows } = await this.db.query(
      "SELECT id FROM conversations WHERE id = $1 LIMIT 1",
      [parseInt(id, 10)]
    );
    if (rows.length === 0) return null;
    return new TestAggregate(rows[0].id.toString());
  }

  async save(entity: TestAggregate): Promise<TestAggregate> {
    await this.db.query(
      `INSERT INTO conversations (id, project_id, identity_id, status, handled_by, channel)
       VALUES ($1, 1, 12, 'open', 'ai', 'WebChat')
       ON CONFLICT (id) DO UPDATE SET status = 'open'`,
      [parseInt(entity.id, 10)]
    );
    return entity;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log("============================================================");
  console.log("             AX-BE-002 Repository & UoW Tests               ");
  console.log("============================================================\n");

  const txManager = new TransactionManager();
  const uow = new UnitOfWork(txManager);
  const repo = new TestRepository(txManager);

  // Clear previous records to avoid key conflict errors
  await pool.query("DELETE FROM conversations WHERE id IN (1001, 1002)");

  // 1. Transaction Commit & Event Propagation
  console.log("Running Test 1: Commit and Post-Commit Event Dispatch...");
  let eventsDispatched: any[] = [];
  const agg = new TestAggregate("1001");
  agg.doSomething();

  await uow.execute(
    async () => {
      uow.registerAggregate(agg);
      await repo.save(agg);
    },
    async (events) => {
      eventsDispatched = events;
    }
  );

  assert(eventsDispatched.length === 1, "Should have dispatched 1 event");
  assert(eventsDispatched[0].getAggregateId() === "1001", "Dispatched event aggregate ID mismatch");
  assert(agg.domainEvents.length === 0, "Aggregate domain events collection should be cleared after dispatch");

  // Verify it exists in database
  const saved = await repo.findById("1001");
  assert(saved !== null && saved.id === "1001", "Saved aggregate not found in database");
  console.log("✔ Test 1 Passed.\n");

  // 2. Transaction Rollback & Invalidation
  console.log("Running Test 2: Rollback on Error...");
  let rollbackEvents: any[] = [];
  const badAgg = new TestAggregate("1002");
  badAgg.doSomething();

  let threwError = false;
  try {
    await uow.execute(
      async () => {
        uow.registerAggregate(badAgg);
        await repo.save(badAgg);
        // Force an execution error inside transaction boundary
        throw new Error("Simulated Rollback Target Error");
      },
      async (events) => {
        rollbackEvents = events;
      }
    );
  } catch (err: any) {
    if (err.message === "Simulated Rollback Target Error") {
      threwError = true;
    }
  }

  assert(threwError, "UoW did not throw transaction exception");
  assert(rollbackEvents.length === 0, "Events should not be dispatched on rollback");

  // Verify that the record was rolled back and does not exist in DB
  const rolledBack = await repo.findById("1002");
  assert(rolledBack === null, "Rolled back record should not be committed to database");
  console.log("✔ Test 2 Passed.\n");

  console.log("============================================================");
  console.log("              All AX-BE-002 Tests Passed!                   ");
  console.log("============================================================");
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Test Suite Failed:");
    console.error(err);
    process.exit(1);
  });
