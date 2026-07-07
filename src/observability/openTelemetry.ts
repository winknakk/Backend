import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { createLogger } from "./logger";

const logger = createLogger("otel");

let sdk: NodeSDK | null = null;

export function initOpenTelemetry(): void {
  try {
    const resource = resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: "automationx-backend",
      [SemanticResourceAttributes.SERVICE_VERSION]: "3.0.0",
    });

    sdk = new NodeSDK({
      resource,
      spanProcessor: new SimpleSpanProcessor(new ConsoleSpanExporter()),
    });

    sdk.start();
    logger.info("OpenTelemetry SDK initialized successfully");

    process.on("SIGTERM", () => {
      sdk?.shutdown()
        .then(() => logger.info("OpenTelemetry SDK shutdown complete"))
        .catch((err) => logger.error({ error: err.message }, "Error shutting down OpenTelemetry SDK"))
        .finally(() => process.exit(0));
    });
  } catch (err: any) {
    logger.error({ error: err.message }, "Failed to initialize OpenTelemetry SDK");
  }
}
