import * as dotenv from "dotenv";
import { Client } from "pg";
import { SessionTokenService } from "./infrastructure/security/SessionTokenService";
dotenv.config({ path: __dirname + "/../.env", quiet: true } as any);
(async () => {
  const [path, action, bodyJson, checkSql] = process.argv.slice(2);
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const u = new URL(process.env.DATABASE_URL!); if (u.hostname !== "localhost" || !u.pathname.includes("test")) throw new Error("not test db");
  const [p] = (await db.query("SELECT id FROM projects WHERE name LIKE 'Audit Project %' ORDER BY id DESC LIMIT 1")).rows;
  const tok = new SessionTokenService(process.env.SESSION_SECRET!, 1).issue({ kind: "operator", subject: "admin-probe", role: "super_admin", orgId: null, projectIds: null } as any).token;
  const res = await fetch(`http://127.0.0.1:3101/api/v1/admin/projects/${p.id}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: Buffer.from(bodyJson, "base64").toString("utf8") });
  const body = await res.text();
  const persisted = (await db.query(checkSql.split("PID").join(String(Number(p.id))))).rows[0].n;
  const aud = (await db.query("SELECT entity_type, entity_id FROM admin_audit_logs WHERE action = $2 AND project_id = $1 ORDER BY id DESC LIMIT 1", [p.id, action])).rows[0] || null;
  console.log(JSON.stringify({ route: path, status: res.status, body: body.slice(0, 150), businessRowsPersisted: persisted, lastAudit: aud }));
  await db.end();
})().catch((e) => { console.error("probe error", e.message); process.exit(1); });
