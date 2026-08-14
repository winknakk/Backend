import { pool, PostgresAdapter } from "../adapters/postgres/PostgresAdapter";
import { KnowledgeService } from "../tools/search-project-docs/KnowledgeService";

async function testSearchExciseDocs() {
  console.log("=== TESTING KNOWLEDGE BASE SEARCH FOR EXC03 (PROJECT 101) ===");

  let client;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      client = await pool.connect();
      break;
    } catch (err: any) {
      console.warn(`Connection attempt ${attempt} failed: ${err.message}`);
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  try {
    const postgresAdapter = new PostgresAdapter();
    const knowledgeService = new KnowledgeService(postgresAdapter);

    const query = "EXC03";
    console.log(`Query: "${query}"`);

    const results = await knowledgeService.searchKnowledgeBase(query, "101", "org_excise");

    console.log("\nSearch Results:");
    console.log(JSON.stringify(results, null, 2));
  } catch (e: any) {
    console.error("Test execution failed:", e.message);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

testSearchExciseDocs().catch(console.error);
