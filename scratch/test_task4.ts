import { fastify } from "../src/api/server";

async function main() {
  try {
    const { pool } = require("../src/adapters/postgres/PostgresAdapter");

    // Seed test project 2 in DB
    console.log("Seeding project 2 prompts configuration...");
    await pool.query("INSERT INTO companies (id, name) VALUES (2, 'Task 4 Company') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO projects (id, company_id, name) VALUES (2, 2, 'Task 4 Project') ON CONFLICT DO NOTHING");
    await pool.query("DELETE FROM project_prompts WHERE project_id = 2");
    await pool.query(`
      INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens)
      VALUES (2, 'Project 2 Instruction: Resolve billing issues.', 'gemini-1.5-flash', 0.5, 1024)
    `);

    // Case 1: No query param, no header (expect project 1 defaults/fallback)
    console.log("\nCase 1: GET /api/v1/internal/config/prompts (No projectId / No headers)...");
    const res1 = await fastify.inject({
      method: "GET",
      url: "/api/v1/internal/config/prompts",
    });
    console.log("Status:", res1.statusCode);
    console.log("Response:", res1.json());

    // Case 2: Query param ?projectId=2
    console.log("\nCase 2: GET /api/v1/internal/config/prompts?projectId=2...");
    const res2 = await fastify.inject({
      method: "GET",
      url: "/api/v1/internal/config/prompts?projectId=2",
    });
    console.log("Status:", res2.statusCode);
    console.log("Response:", res2.json());

    // Case 3: Header x-project-id = 2
    console.log("\nCase 3: GET /api/v1/internal/config/prompts with header x-project-id: 2...");
    const res3 = await fastify.inject({
      method: "GET",
      url: "/api/v1/internal/config/prompts",
      headers: {
        "x-project-id": "2",
      },
    });
    console.log("Status:", res3.statusCode);
    console.log("Response:", res3.json());

  } catch (err: any) {
    console.error("Test failed with error:", err.message);
  } finally {
    const { pool } = require("../src/adapters/postgres/PostgresAdapter");
    await pool.end();
  }
}

main();
