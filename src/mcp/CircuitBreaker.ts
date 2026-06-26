import { createLogger } from "../observability/logger";

const logger = createLogger("CircuitBreaker");

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private consecutiveFailures = 0;
  private failureThreshold: number;
  private cooldownMs: number;
  private cooldownExpiresAt = 0;

  constructor(failureThreshold = 3, cooldownMs = 5000) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
  }

  getState(): BreakerState {
    this.checkCooldown();
    return this.state;
  }

  private checkCooldown(): void {
    if (this.state === "OPEN" && Date.now() > this.cooldownExpiresAt) {
      this.state = "HALF_OPEN";
      logger.info("Circuit Breaker transitioned to HALF_OPEN (cooldown expired)");
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === "HALF_OPEN" || this.state === "OPEN") {
      this.state = "CLOSED";
      logger.info("Circuit Breaker transitioned to CLOSED (successful request)");
    }
  }

  private recordFailure(err: any): void {
    this.consecutiveFailures++;
    logger.warn(
      { consecutiveFailures: this.consecutiveFailures, error: err.message },
      "Circuit Breaker recorded failure"
    );

    if (this.state === "CLOSED" || this.state === "HALF_OPEN") {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.state = "OPEN";
        this.cooldownExpiresAt = Date.now() + this.cooldownMs;
        logger.error(
          { cooldownMs: this.cooldownMs },
          `Circuit Breaker transitioned to OPEN (consecutive failures threshold of ${this.failureThreshold} reached)`
        );
      }
    }
  }

  /**
   * Executes a promise-returning function with circuit breaker protection and jittered exponential retry for 429s.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkCooldown();

    if (this.state === "OPEN") {
      throw new CircuitBreakerOpenError(
        "Circuit breaker is currently OPEN. PromptX MCP calls are temporarily blocked."
      );
    }

    // Try executing the request with retries for 429s
    let lastError: any;
    let attempt = 0;
    const maxRetries = 3;
    const baseDelayMs = 100;

    while (attempt <= maxRetries) {
      try {
        const result = await fn();
        this.recordSuccess();
        return result;
      } catch (err: any) {
        lastError = err;

        // Check if HTTP 429
        const is429 = err.response?.status === 429 || err.status === 429 || err.message?.includes("429");

        if (is429 && attempt < maxRetries) {
          attempt++;
          // Exponential Backoff with Jitter: base * 2^attempt + random(0, 50% of delay)
          const delay = baseDelayMs * Math.pow(2, attempt);
          const jitter = Math.random() * (delay * 0.5);
          const finalDelay = delay + jitter;

          logger.warn(
            { attempt, delayMs: finalDelay, error: err.message },
            "HTTP 429 Rate Limit encountered. Retrying with jittered backoff..."
          );

          await new Promise((resolve) => setTimeout(resolve, finalDelay));
          continue; // Retry
        }

        // Non-429 error or out of retries
        break;
      }
    }

    // If we reach here, a failure occurred (either non-429 or exhausted 429 retries)
    this.recordFailure(lastError);
    throw lastError;
  }
}
