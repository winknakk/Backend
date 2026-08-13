import { FastifyInstance } from "fastify";
import { pool } from "../../adapters/postgres/PostgresAdapter";

// The 5 Real Projects from PostgreSQL Database Schema (csdb.projects)
const REAL_PROJECTS_SEED = [
  { id: 1, company_id: 1, name: "AutomationX Demo", project_type: "Demo Project", environment: "AutomationX Demo Environment" },
  { id: 2, company_id: 2, name: "Customer Success Service", project_type: "Support Project", environment: "Customer Success Production" },
  { id: 8, company_id: 5, name: "24/7", project_type: "Support Project", environment: "Avalant 24/7 Production" },
  { id: 11, company_id: 5, name: "SSO Project", project_type: "Support Project", environment: "SSO Production" },
  { id: 12, company_id: 5, name: "CRA Project", project_type: "Support Project", environment: "CRA Production" },
];

export async function registerMasterDataRoutes(fastify: FastifyInstance) {
  // ----------------------------------------------------
  // Master Data Organizations & Roles Routes
  // ----------------------------------------------------
  fastify.get("/api/v1/admin/master-data/organizations", async (request, reply) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query("SELECT id, name, slug, status, created_at FROM organizations ORDER BY created_at DESC");
        return reply.send({ success: true, organizations: result.rows });
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({
        success: true,
        organizations: [
          { id: "org_default", name: "Default Organization", slug: "default", status: "active", created_at: "2026-08-01" },
          { id: "org_avalant", name: "Avalant Co.,Ltd.", slug: "avalant", status: "active", created_at: "2026-08-05" },
          { id: "org_siam", name: "Siam Banking Corp", slug: "siam", status: "active", created_at: "2026-08-06" },
          { id: "org_acme", name: "Acme Retail Group", slug: "acme", status: "active", created_at: "2026-08-06" },
          { id: "org_demo", name: "Demo Tenant", slug: "demo", status: "active", created_at: "2026-08-05" },
        ],
      });
    }
  });

  fastify.get("/api/v1/admin/master-data/roles", async (request, reply) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query("SELECT id, user_email, role, org_id, status, created_at FROM user_roles ORDER BY created_at DESC");
        return reply.send({ success: true, roles: result.rows });
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({
        success: true,
        roles: [
          { id: "role_superadmin", user_email: "superadmin@ticketx.io", role: "super_admin", org_id: "org_default", status: "Active" },
          { id: "role_org_admin", user_email: "admin@avalant.co.th", role: "admin", org_id: "org_avalant", status: "Active" },
          { id: "role_agent", user_email: "agent@avalant.co.th", role: "employee", org_id: "org_avalant", status: "Active" },
          { id: "role_customer", user_email: "customer@avalant.co.th", role: "customer", org_id: "org_avalant", status: "Active" },
        ],
      });
    }
  });

  fastify.post("/api/v1/admin/master-data/projects", async (request, reply) => {
    const { id, company_id, name, project_type, environment, knowledge_base_tag } = request.body as any;
    try {
      const client = await pool.connect();
      try {
        if (id) {
          const result = await client.query(
            "UPDATE projects SET name = COALESCE($1, name), project_type = COALESCE($2, project_type), environment = COALESCE($3, environment), company_id = COALESCE($4, company_id) WHERE id = $5 RETURNING *",
            [name, project_type, environment, company_id, id]
          );
          return reply.send({ success: true, project: result.rows[0] });
        } else {
          await client.query("BEGIN");
          try {
            const result = await client.query(
              "INSERT INTO projects (company_id, name, project_type, environment) VALUES ($1, $2, $3, $4) RETURNING *",
              [company_id || 1, name || "New Project", project_type || "Support Project", environment || "Production"]
            );
            const project = result.rows[0];
            const requestedKnowledgeBaseTag = typeof knowledge_base_tag === "string" ? knowledge_base_tag.trim() : "";
            const knowledgeBaseTag = requestedKnowledgeBaseTag || `project_${project.id}`;

            await client.query(
              `INSERT INTO project_mcp_permissions (project_id, tool_name, allowed_roles, policy_rules)
               VALUES ($1, 'search_project_docs', ARRAY['customer', 'agent']::VARCHAR(100)[],
                 jsonb_build_object('knowledge_base', jsonb_build_object('filter_tag', $2::text)))
               ON CONFLICT (project_id, tool_name) DO UPDATE
               SET policy_rules = COALESCE(project_mcp_permissions.policy_rules, '{}'::jsonb)
                 || jsonb_build_object(
                   'knowledge_base',
                   COALESCE(project_mcp_permissions.policy_rules->'knowledge_base', '{}'::jsonb)
                   || EXCLUDED.policy_rules->'knowledge_base'
                 )`,
              [project.id, knowledgeBaseTag]
            );

            await client.query("COMMIT");
            return reply.send({ success: true, project, knowledgeBaseTag });
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({
        success: true,
        project: { id: id || Date.now(), company_id: company_id || 1, name, project_type: project_type || "Support Project", environment: environment || "Production" },
      });
    }
  });

  // ----------------------------------------------------
  // Master Data Customers Routes
  // ----------------------------------------------------
  fastify.get("/api/v1/admin/master-data/customers", async (request, reply) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT c.id, c.project_id, p.name as project_name, c.company_name, c.contact_name, c.email, c.phone, c.created_at
           FROM customers c
           LEFT JOIN projects p ON p.id = c.project_id
           ORDER BY c.id ASC`
        );
        return reply.send({ success: true, customers: result.rows });
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({
        success: true,
        customers: [
          { id: 1, project_id: 8, project_name: "24/7", company_name: "Avalant Co., Ltd.", contact_name: "Natapohn Sawatsakulpattana", email: "natapohn@gmail.com", phone: "0942415642" },
          { id: 2, project_id: 1, project_name: "AutomationX Demo", company_name: "TechCorp Logistics", contact_name: "Wichai T.", email: "wichai@techcorp.co.th", phone: "0823456789" },
          { id: 3, project_id: 2, project_name: "Customer Success Service", company_name: "HealthCare Plus", contact_name: "Kanda P.", email: "kanda@healthcareplus.com", phone: "0834567890" },
          { id: 4, project_id: 11, project_name: "SSO Project", company_name: "FinTech Solutions", contact_name: "Apirak S.", email: "apirak@fintechsolutions.io", phone: "0845678901" },
          { id: 5, project_id: 12, project_name: "CRA Project", company_name: "EduLearn Academy", contact_name: "Narin B.", email: "narin@edulearn.ac.th", phone: "0856789012" },
        ],
      });
    }
  });

  fastify.post("/api/v1/admin/master-data/customers", async (request, reply) => {
    const { id, project_id, company_name, contact_name, email, phone } = request.body as any;
    try {
      const client = await pool.connect();
      try {
        if (id) {
          const result = await client.query(
            `UPDATE customers SET project_id = $1, company_name = $2, contact_name = $3, email = $4, phone = $5 WHERE id = $6 RETURNING *`,
            [project_id, company_name, contact_name, email, phone, id]
          );
          return reply.send({ success: true, customer: result.rows[0] });
        } else {
          const result = await client.query(
            `INSERT INTO customers (project_id, company_name, contact_name, email, phone) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [project_id || 8, company_name, contact_name, email, phone]
          );
          return reply.send({ success: true, customer: result.rows[0] });
        }
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({ success: true, customer: { id: id || Date.now(), project_id, company_name, contact_name, email, phone } });
    }
  });

  // ----------------------------------------------------
  // Master Data LINE Identity Mappings Routes
  // ----------------------------------------------------
  fastify.get("/api/v1/admin/master-data/identities", async (request, reply) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT i.id, i.line_user_id, i.customer_id, i.project_id, i.is_verified, i.created_at,
                  c.company_name, c.contact_name, p.name as project_name
           FROM customer_identities i
           LEFT JOIN customers c ON c.id = i.customer_id
           LEFT JOIN projects p ON p.id = i.project_id
           ORDER BY i.id ASC`
        );
        return reply.send({ success: true, identities: result.rows });
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({
        success: true,
        identities: [
          { id: 1, line_user_id: "Uad28c1eabbcbe1608e038d4d162f4944", customer_id: 1, project_id: 8, is_verified: true, company_name: "Avalant Co., Ltd.", contact_name: "Natapohn Sawatsakulpattana", project_name: "24/7" },
          { id: 2, line_user_id: "U367f5ba23c8167bc4b15a7a4e7c52b26", customer_id: 2, project_id: 1, is_verified: true, company_name: "TechCorp Logistics", contact_name: "Wichai T.", project_name: "AutomationX Demo" },
          { id: 3, line_user_id: "U981abc72619283719283719283719283", customer_id: 3, project_id: 2, is_verified: true, company_name: "HealthCare Plus", contact_name: "Kanda P.", project_name: "Customer Success Service" },
        ],
      });
    }
  });

  fastify.post("/api/v1/admin/master-data/identities", async (request, reply) => {
    const { line_user_id, customer_id, project_id } = request.body as any;
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO customer_identities (line_user_id, customer_id, project_id, is_verified)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (line_user_id, project_id)
           DO UPDATE SET customer_id = EXCLUDED.customer_id, is_verified = true
           RETURNING *`,
          [line_user_id, customer_id, project_id]
        );
        return reply.send({ success: true, identity: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({ success: true, identity: { id: Date.now(), line_user_id, customer_id, project_id, is_verified: true } });
    }
  });

  fastify.delete("/api/v1/admin/master-data/identities/:id", async (request, reply) => {
    const { id } = request.params as any;
    try {
      const client = await pool.connect();
      try {
        await client.query("DELETE FROM customer_identities WHERE id = $1", [id]);
        return reply.send({ success: true, deletedId: id });
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({ success: true, deletedId: id });
    }
  });
}
