import { CircuitBreaker, CircuitBreakerOpenError } from "./mcp/CircuitBreaker";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    Testing Circuit Breaker Functionality");
  console.log("=========================================");

  // 1. Initialize Circuit Breaker: threshold 2, cooldown 100ms
  const breaker = new CircuitBreaker(2, 100);
  assert(breaker.getState() === "CLOSED", "Initial state must be CLOSED");

  // 2. Test successful execution
  const res1 = await breaker.execute(async () => "success");
  assert(res1 === "success", "Successful execution should return value");
  assert(breaker.getState() === "CLOSED", "State must remain CLOSED on success");

  // 3. Test transitioning to OPEN
  let firstFailThrown = false;
  try {
    await breaker.execute(async () => {
      throw new Error("Failure 1");
    });
  } catch (err: any) {
    assert(err.message === "Failure 1", "Should throw the actual error");
    firstFailThrown = true;
  }
  assert(firstFailThrown, "First failure must be thrown");
  assert(breaker.getState() === "CLOSED", "State should still be CLOSED after 1 failure");

  let secondFailThrown = false;
  try {
    await breaker.execute(async () => {
      throw new Error("Failure 2");
    });
  } catch (err: any) {
    assert(err.message === "Failure 2", "Should throw the actual error");
    secondFailThrown = true;
  }
  assert(secondFailThrown, "Second failure must be thrown");
  assert(breaker.getState() === "OPEN", "State must transition to OPEN after 2 failures");

  // 4. Test execution in OPEN state (fast fail)
  let openErrorThrown = false;
  try {
    await breaker.execute(async () => "should not run");
  } catch (err: any) {
    assert(err instanceof CircuitBreakerOpenError, "Should throw CircuitBreakerOpenError");
    assert(err.message.includes("blocked"), "Error message should mention blocked");
    openErrorThrown = true;
  }
  assert(openErrorThrown, "Fast fail in OPEN state must trigger");

  // 5. Test transitioning to HALF_OPEN after cooldown expires
  console.log("Waiting for cooldown to expire...");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(breaker.getState() === "HALF_OPEN", "State must transition to HALF_OPEN after cooldown");

  // 6. Test HALF_OPEN success resets to CLOSED
  const res2 = await breaker.execute(async () => "half-open success");
  assert(res2 === "half-open success", "Should return success value");
  assert(breaker.getState() === "CLOSED", "State must transition to CLOSED on HALF_OPEN success");

  // 7. Test HTTP 429 Retry Backoff behavior
  console.log("Testing 429 exponential backoff retry...");
  let attemptCount = 0;
  const breaker429 = new CircuitBreaker(5, 5000);
  const start = Date.now();

  const res3 = await breaker429.execute(async () => {
    attemptCount++;
    if (attemptCount < 3) {
      const err = new Error("Too Many Requests") as any;
      err.status = 429;
      throw err;
    }
    return "success after 429";
  });

  const duration = Date.now() - start;
  console.log(`429 execution succeeded after ${attemptCount} attempts in ${duration}ms`);
  assert(res3 === "success after 429", "Should return the success value after retries");
  assert(attemptCount === 3, "Should have retried exactly 3 times (2 failures, 1 success)");
  assert(duration >= 300, "Should have delayed execution (backoff delay)");

  console.log("✅ Circuit Breaker tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
