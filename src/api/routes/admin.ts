import { FastifyInstance } from "fastify";
import { z } from "zod";
import { MetricAggregator } from "../../aiops/dashboard/MetricAggregator";
import { IngestionService } from "../../aiops/ragops/IngestionService";
import { EvalTestRunner } from "../../aiops/llmops/EvalTestRunner";
import { TrafficSplitter } from "../../aiops/prompt-control/TrafficSplitter";
import { authHook } from "../../middleware/auth";
import { DocumentIngestionPayloadSchema, AbTestWeightSchema, EvalTestCaseSchema } from "../../schemas/aiops";

export interface AdminRouteDependencies {
  metricAggregator: MetricAggregator;
  ingestionService: IngestionService;
  evalTestRunner: EvalTestRunner;
  trafficSplitter: TrafficSplitter;
}

export async function registerAdminRoutes(fastify: FastifyInstance, deps: AdminRouteDependencies) {
  // Add authentication hook for all admin endpoints
  fastify.addHook("onRequest", authHook);

  // 1. GET /api/v1/admin/metrics
  fastify.get("/api/v1/admin/metrics", async (request, reply) => {
    const query = request.query as any;
    const tenantId = query.tenantId ? String(query.tenantId) : undefined;
    const metrics = await deps.metricAggregator.getDashboardMetrics(tenantId);
    return reply.code(200).send(metrics);
  });

  // 2. GET /api/v1/admin/traces
  fastify.get("/api/v1/admin/traces", async (request, reply) => {
    const query = request.query as any;
    const tenantId = query.tenantId ? String(query.tenantId) : undefined;
    const traces = await deps.metricAggregator.getConversationTraceSummaries(tenantId);
    return reply.code(200).send(traces);
  });

  // 3. POST /api/v1/admin/knowledge/upload
  fastify.post("/api/v1/admin/knowledge/upload", async (request, reply) => {
    const parsed = DocumentIngestionPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Bad Request",
        message: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    const chunks = await deps.ingestionService.ingestDocument(parsed.data);
    return reply.code(200).send({
      success: true,
      documentId: chunks[0]?.docId || "unknown",
      chunksCount: chunks.length,
    });
  });

  // 4. POST /api/v1/admin/evals/run
  fastify.post("/api/v1/admin/evals/run", async (request, reply) => {
    const body = request.body as any;
    const tenantId = body.tenantId ? String(body.tenantId) : "1";
    const testCasesInput = z.array(EvalTestCaseSchema).safeParse(body.testCases);

    if (!testCasesInput.success) {
      return reply.code(400).send({
        error: "Bad Request",
        message: testCasesInput.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    const results = await deps.evalTestRunner.runSuite(testCasesInput.data, tenantId);
    const total = results.length;
    const successful = results.filter((r) => r.success).length;
    const avgAccuracy = total > 0 ? results.reduce((acc, r) => acc + r.accuracyScore, 0) / total : 0;

    return reply.code(200).send({
      summary: {
        totalTestCases: total,
        successfulTestCases: successful,
        averageAccuracyScore: parseFloat(avgAccuracy.toFixed(2)),
      },
      results,
    });
  });

  // 5. GET/POST /api/v1/admin/prompts/ab-test
  fastify.get("/api/v1/admin/prompts/ab-test", async (request, reply) => {
    const query = request.query as any;
    const tenantId = query.tenantId ? String(query.tenantId) : "1";
    const promptName = query.promptName ? String(query.promptName) : "support";

    const weights = deps.trafficSplitter.getWeights(tenantId, promptName);
    if (!weights) {
      return reply.code(404).send({
        error: "Not Found",
        message: `No A/B test weights configured for tenant ${tenantId} and prompt ${promptName}.`,
      });
    }
    return reply.code(200).send(weights);
  });

  fastify.post("/api/v1/admin/prompts/ab-test", async (request, reply) => {
    const parsed = AbTestWeightSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Bad Request",
        message: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }

    try {
      deps.trafficSplitter.setWeights(parsed.data);
      return reply.code(200).send({ success: true, message: "A/B test weights configured successfully." });
    } catch (err: any) {
      return reply.code(400).send({ error: "Bad Request", message: err.message });
    }
  });
}
