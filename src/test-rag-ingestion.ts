import { IngestionService } from "./aiops/ragops/IngestionService";
import { InMemoryVectorStore } from "./rag/InMemoryVectorStore";
import { EmbeddingService } from "./rag/EmbeddingService";
import { VectorStoreRetriever } from "./rag/VectorStoreRetriever";
import { DocumentIngestionPayload } from "./schemas/aiops";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("      AutomationX V2 RAG Ingestion Tests ");
  console.log("=========================================");

  const embeddingService = new EmbeddingService();
  const vectorStore = new InMemoryVectorStore(embeddingService);
  const retriever = new VectorStoreRetriever(embeddingService, vectorStore);
  const ingestionService = new IngestionService(vectorStore, embeddingService);

  // 1. Ingest document for Tenant A
  const docA: DocumentIngestionPayload = {
    tenantId: "tenant-A",
    projectId: "project-1",
    title: "SSO Troubleshooting Guide",
    content:
      "SSO is Single Sign-On. If you face a 500 error, restart your SSO agent. This should clear the session. For Orbit App, update your Orbit App credentials.",
    // projectId here must not re-tag the document (caller metadata cannot override scope).
    metadata: { author: "System Architect", projectId: "project-2" },
  };

  const chunksA = await ingestionService.ingestDocument(docA);
  console.log(`Ingested Tenant A document. Chunks created: ${chunksA.length}`);
  assert(chunksA.length > 0, "Should generate at least one chunk.");
  assert(chunksA[0].tenantId === "tenant-A", "Tenant ID must match.");
  assert(chunksA[0].metadata?.author === "System Architect", "Metadata must be preserved.");
  assert(Array.isArray(chunksA[0].metadata?.embedding), "Embedding should be attached to metadata.");
  assert(chunksA[0].metadata?.projectId === "project-1", "Caller metadata must not override the project scope.");

  // 2. Ingest document for Tenant B
  const docB: DocumentIngestionPayload = {
    tenantId: "tenant-B",
    projectId: "project-2",
    title: "VPN Guide",
    content:
      "To connect to the VPN, use the Cisco AnyConnect client. Enter server address vpn.company.com and enter your credentials.",
  };

  const chunksB = await ingestionService.ingestDocument(docB);
  console.log(`Ingested Tenant B document. Chunks created: ${chunksB.length}`);

  // 3. Test Retrieval isolation (Multi-tenant RAG Safety)
  console.log("\nTesting RAG multi-tenant isolation...");

  // Search for "SSO error" under Tenant A -> should find it
  const resultsA = await retriever.retrieve("SSO error", { tenantId: "tenant-A", projectId: "project-1" });
  console.log(`Tenant A results count: ${resultsA.length}`);
  assert(resultsA.length > 0, "Should retrieve Tenant A SSO guide.");
  assert(resultsA[0].content.includes("SSO"), "Result should contain SSO content.");
  assert(resultsA[0].metadata?.tenantId === "tenant-A", "Retrieved document must belong to tenant-A.");

  // Search for "SSO error" under Tenant B -> should NOT find it
  const resultsB = await retriever.retrieve("SSO error", { tenantId: "tenant-B", projectId: "project-2" });
  console.log(`Tenant B results count: ${resultsB.length}`);
  // Should either be empty or contain only Tenant B docs (which don't match, or score low and are filtered)
  const tenantAFoundInB = resultsB.some((r) => r.metadata?.tenantId === "tenant-A");
  assert(!tenantAFoundInB, "Tenant B search must NOT return Tenant A documents!");

  // 4. Fail closed: no project scope -> no results, and no unscoped ingestion
  const unscoped = await retriever.retrieve("SSO error", { tenantId: "tenant-A" });
  assert(unscoped.length === 0, "Retrieval without a project scope must return nothing.");
  let rejected = false;
  try {
    await ingestionService.ingestDocument({ tenantId: "tenant-A", title: "x", content: "SSO unscoped" });
  } catch (err: any) {
    rejected = err?.name === "KnowledgeScopeRequiredError";
  }
  assert(rejected, "Ingestion without a project scope must be refused.");

  console.log("\n✅ All RAG Ingestion tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
