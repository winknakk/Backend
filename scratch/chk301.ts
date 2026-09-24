import { Pool } from "pg"; import * as dotenv from "dotenv"; import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  const r = await p.query(
    `select id, org_id, project_id, workspace_slug, enabled, archived_at is null as active
       from cs_tickets.plane_workspace_mappings where project_id = 301`);
  console.log(r.rows.length ? "  mapping(s): " + JSON.stringify(r.rows) : "  NO Plane mapping for project 301");
  await p.end();
})().catch(e => console.log("  db unavailable:", e.message));
