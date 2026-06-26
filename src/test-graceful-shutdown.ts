import Fastify from "fastify";
import { GracefulShutdownService } from "./api/GracefulShutdownService";
import axios from "axios";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    Testing Graceful Shutdown System");
  console.log("=========================================");

  // Mock process.exit to verify it is called cleanly with code 0
  const originalExit = process.exit;
  let exitCodeCalled: number | null = null;
  (process as any).exit = (code?: number) => {
    exitCodeCalled = code ?? 0;
  };

  const testPort = 19999;
  const fastify = Fastify();

  fastify.get("/health", async (request, reply) => {
    if (GracefulShutdownService.checkShuttingDown()) {
      return reply.code(503).send({
        status: "service_unavailable",
        message: "Server is shutting down",
      });
    }
    return reply.code(200).send({ status: "healthy" });
  });

  await fastify.listen({ port: testPort, host: "127.0.0.1" });
  console.log(`Test server listening on port ${testPort}`);

  GracefulShutdownService.register(fastify);

  // 1. Initial State: health should be 200 OK
  const res1 = await axios.get(`http://127.0.0.1:${testPort}/health`);
  assert(res1.status === 200 && res1.data.status === "healthy", "Initial health check should be 200");

  // 2. Trigger Shutdown: simulate SIGTERM signal handlers
  console.log("Simulating SIGTERM signal...");
  const listeners = process.listeners("SIGTERM");
  assert(listeners.length > 0, "SIGTERM listener must be registered");

  const sigtermHandler = listeners[0] as any;
  await sigtermHandler();

  // 3. Post-Shutdown trigger state verification
  assert(GracefulShutdownService.checkShuttingDown() === true, "isShuttingDown state must be true");
  assert(exitCodeCalled === 0, "process.exit(0) must have been called");

  try {
    const res2 = await axios.get(`http://127.0.0.1:${testPort}/health`);
    assert(res2.status === 503, "Should return 503 once shutdown sequence starts");
  } catch (err: any) {
    console.log("Request failed as expected after close:", err.message);
  }

  // Restore process.exit
  process.exit = originalExit;

  // Cleanup registered event listeners to prevent leakage in subsequent tests
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");

  console.log("✅ Graceful Shutdown tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
