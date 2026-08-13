import fs from "fs";
import { pool } from "./adapters/postgres/PostgresAdapter";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      fs.readFileSync("./database/migrations/033_configure_project_knowledge_scopes.sql", "utf8")
    );

    const configured = await client.query(
      `SELECT policy_rules #>> '{knowledge_base,filter_tag}' AS filter_tag
       FROM project_mcp_permissions
       WHERE project_id = 101 AND tool_name = 'search_project_docs'`
    );
    if (configured.rows[0]?.filter_tag !== "Excise") {
      throw new Error("Project 101 scope was not configured");
    }

    await client.query(
      fs.readFileSync("./database/migrations/033_configure_project_knowledge_scopes_down.sql", "utf8")
    );
    const rolledBack = await client.query(
      `SELECT policy_rules #>> '{knowledge_base,filter_tag}' AS filter_tag
       FROM project_mcp_permissions
       WHERE project_id = 101 AND tool_name = 'search_project_docs'`
    );
    if (rolledBack.rows[0]?.filter_tag) {
      throw new Error("Down migration did not remove the filter tag");
    }

    await client.query("ROLLBACK");
    console.log("Migration up/down transaction verification: PASS");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
