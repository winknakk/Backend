import { RequestContextHolder } from "./shared/context/RequestContextHolder";
import { BaseEntity } from "./shared/domain/BaseEntity";
import { BaseAggregate } from "./shared/domain/BaseAggregate";
import { BaseDomainEvent } from "./shared/domain/BaseDomainEvent";
import { ValueObject } from "./shared/domain/ValueObject";

// ─── HELPER MODELS FOR TESTING ───────────────────────────────────────────

class TestEntity extends BaseEntity<string> {
  constructor(id: string, public name: string) {
    super(id);
  }
}

class TestEvent extends BaseDomainEvent {
  constructor(public readonly aggregateId: string, public readonly action: string) {
    super();
  }

  getAggregateId(): string {
    return this.aggregateId;
  }
}

class TestAggregate extends BaseAggregate<string> {
  constructor(id: string) {
    super(id);
  }

  public triggerAction(action: string): void {
    this.addDomainEvent(new TestEvent(this.id, action));
  }
}

interface TestProps {
  street: string;
  city: string;
  zip: number;
  tags?: string[];
  createdAt?: Date;
  details?: {
    approved: boolean;
  };
}

class TestValueObject extends ValueObject<TestProps> {
  constructor(props: TestProps) {
    super(props);
  }

  public get value(): TestProps {
    return this.props;
  }
}

// ─── ASSERTION UTILITY ───────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}`);
  }
}

async function runTests() {
  console.log("============================================================");
  console.log("             AX-BE-001 Shared Kernel Unit Tests             ");
  console.log("============================================================\n");

  // 1. RequestContext & Context Propagation
  console.log("Running Test 1: Context Isolation & Concurrency...");
  const task1 = new Promise<void>((resolve) => {
    RequestContextHolder.run(
      {
        correlationId: "corr-1",
        requestId: "req-1",
        projectId: "proj-1",
      },
      async () => {
        // Yield execution loop
        await new Promise((r) => setTimeout(r, 100));
        assert(RequestContextHolder.getCorrelationId() === "corr-1", "Context 1: correlation ID mismatch");
        assert(RequestContextHolder.getProjectId() === "proj-1", "Context 1: project ID mismatch");
        resolve();
      }
    );
  });

  const task2 = new Promise<void>((resolve) => {
    RequestContextHolder.run(
      {
        correlationId: "corr-2",
        requestId: "req-2",
        projectId: "proj-2",
      },
      async () => {
        // Yield execution loop
        await new Promise((r) => setTimeout(r, 50));
        assert(RequestContextHolder.getCorrelationId() === "corr-2", "Context 2: correlation ID mismatch");
        assert(RequestContextHolder.getProjectId() === "proj-2", "Context 2: project ID mismatch");
        resolve();
      }
    );
  });

  await Promise.all([task1, task2]);
  console.log("✔ Test 1 Passed.\n");

  // 2. BaseEntity Identity Comparisons
  console.log("Running Test 2: BaseEntity Identity Comparisons...");
  const entityA1 = new TestEntity("ent-1", "Alpha");
  const entityA2 = new TestEntity("ent-1", "Omega");
  const entityB = new TestEntity("ent-2", "Beta");

  assert(entityA1.equals(entityA2), "Entities with same ID must be equal");
  assert(!entityA1.equals(entityB), "Entities with different IDs must not be equal");
  assert(!entityA1.equals(undefined), "Entity equality with undefined must return false");
  console.log("✔ Test 2 Passed.\n");

  // 3. BaseAggregate & Domain Events Immutability
  console.log("Running Test 3: BaseAggregate Domain Event Immutability...");
  const agg = new TestAggregate("agg-1");
  agg.triggerAction("created");
  agg.triggerAction("updated");

  assert(agg.domainEvents.length === 2, "Aggregate should have tracked 2 events");
  assert(agg.domainEvents[0].getAggregateId() === "agg-1", "Event aggregate ID mismatch");

  // Verify event collection is immutable
  let threwOnMutateEvents = false;
  try {
    // Attempting to push to events collection
    (agg.domainEvents as any).push(new TestEvent("agg-1", "illegal"));
  } catch (err) {
    threwOnMutateEvents = true;
  }
  assert(threwOnMutateEvents, "Mutating domainEvents array should throw in strict mode");

  // Verify domain event object is frozen
  const firstEvent = agg.domainEvents[0];
  let threwOnMutateEventProps = false;
  try {
    (firstEvent as any).occurredAt = new Date();
  } catch (err) {
    threwOnMutateEventProps = true;
  }
  assert(threwOnMutateEventProps, "Mutating domain event properties should throw because it is frozen");

  // Clear events
  agg.clearDomainEvents();
  assert(agg.domainEvents.length === 0, "Domain events collection should be cleared");
  console.log("✔ Test 3 Passed.\n");

  // 4. ValueObject Deep Equality
  console.log("Running Test 4: ValueObject Deep Equality & Cloning...");
  const dateObj = new Date("2026-07-13T00:00:00Z");

  const initialProps: TestProps = {
    street: "123 Main St",
    city: "Bangkok",
    zip: 10110,
    tags: ["home", "office"],
    createdAt: dateObj,
    details: {
      approved: true,
    },
  };

  const vo1 = new TestValueObject(initialProps);

  // Deep clone test: Mutating initial input props should not affect ValueObject properties
  initialProps.details!.approved = false;
  initialProps.tags!.push("guest");
  assert(vo1.value.details!.approved === true, "ValueObject was mutated through input reference leak");
  assert(vo1.value.tags!.length === 2, "ValueObject tags array was mutated through input reference leak");

  // Deep equality comparison tests
  const voSame = new TestValueObject({
    street: "123 Main St",
    city: "Bangkok",
    zip: 10110,
    tags: ["home", "office"],
    createdAt: new Date("2026-07-13T00:00:00Z"),
    details: {
      approved: true,
    },
  });

  const voKeyOrder = new TestValueObject({
    city: "Bangkok", // keys in different order
    street: "123 Main St",
    zip: 10110,
    createdAt: new Date("2026-07-13T00:00:00Z"),
    tags: ["home", "office"],
    details: {
      approved: true,
    },
  });

  const voDifferent = new TestValueObject({
    street: "123 Main St",
    city: "Bangkok",
    zip: 10110,
    tags: ["home"], // different tags
    createdAt: new Date("2026-07-13T00:00:00Z"),
    details: {
      approved: true,
    },
  });

  assert(vo1.equals(voSame), "Equal ValueObjects must be equal");
  assert(vo1.equals(voKeyOrder), "ValueObjects with different key orders must be equal");
  assert(!vo1.equals(voDifferent), "Unequal ValueObjects must not be equal");
  assert(!vo1.equals(undefined), "Comparison with undefined must return false");
  console.log("✔ Test 4 Passed.\n");

  console.log("============================================================");
  console.log("              All Shared Kernel Tests Passed!               ");
  console.log("============================================================");
}

runTests().catch((err) => {
  console.error("❌ Test Suite Failed:");
  console.error(err);
  process.exit(1);
});
