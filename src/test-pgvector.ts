import { EmbeddingService } from "./rag/EmbeddingService";
import { PgVectorStore } from "./rag/PgVectorStore";
import { VectorStoreRetriever } from "./rag/VectorStoreRetriever";
import { pool } from "./adapters/postgres/PostgresAdapter";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  if (!process.env.DATABASE_URL) {
    console.log("test-pgvector skipped: DATABASE_URL is not set.");
    return;
  }

  try {
    await pool.query("SELECT 1");
  } catch (err: any) {
    console.log(`test-pgvector skipped: postgres is unavailable (${err.message}).`);
    return;
  }

  const embeddingService = new EmbeddingService();
  const vectorStore = new PgVectorStore();
  const retriever = new VectorStoreRetriever(embeddingService, vectorStore);
  const embedding = await embeddingService.embedQuery("reset SSO password");

  await vectorStore.addDocuments([
    {
      id: "test-doc-sso-reset",
      content: "To reset an SSO password, open the identity portal and choose reset password.",
      metadata: { type: "document", projectId: "p1", embedding }
    }
  ]);

  const results = await retriever.retrieve("reset SSO password", { projectId: "p1" });
  assert(results.length > 0, "Expected vector search result.");
  assert(results[0].id === "test-doc-sso-reset", "Expected inserted document to rank first.");

  console.log("test-pgvector passed");
}

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
