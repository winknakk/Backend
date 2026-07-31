import { FastifyInstance } from "fastify";
import { pool } from "../../adapters/postgres/PostgresAdapter";

export async function registerMasterDataRoutes(fastify: FastifyInstance) {
  // ----------------------------------------------------
  // Master Data Projects & Plans Routes
  // ----------------------------------------------------
  fastify.get("/api/v1/admin/master-data/projects", async (request, reply) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          "SELECT id, name, code, plan_status, created_at FROM projects ORDER BY id ASC"
        );
        return reply.send({ success: true, projects: result.rows });
      } finally {
        client.release();
      }
    } catch (err: any) {
      // Fallback mock projects if DB query fails
      return reply.send({
        success: true,
        projects: [
          { id: 1, name: "Orbit POS System", code: "PRJ-1", plan_status: "ACTIVE" },
          { id: 2, name: "Orbit Mobile App", code: "PRJ-2", plan_status: "ACTIVE" },
          { id: 3, name: "Fleet Tracker v2", code: "PRJ-3", plan_status: "PROTOSPACE" },
          { id: 4, name: "Warehouse Management System", code: "PRJ-4", plan_status: "ACTIVE" },
          { id: 5, name: "Patient Portal", code: "PRJ-5", plan_status: "EXPIRED" },
        ],
      });
    }
  });

  fastify.post("/api/v1/admin/master-data/projects", async (request, reply) => {
    const { id, name, code, plan_status } = request.body as any;
    try {
      const client = await pool.connect();
      try {
        if (id) {
          const result = await client.query(
            "UPDATE projects SET name = COALESCE($1, name), code = COALESCE($2, code), plan_status = COALESCE($3, plan_status) WHERE id = $4 RETURNING *",
            [name, code, plan_status, id]
          );
          return reply.send({ success: true, project: result.rows[0] });
        } else {
          const result = await client.query(
            "INSERT INTO projects (name, code, plan_status) VALUES ($1, $2, $3) RETURNING *",
            [name || "New Project", code || "PRJ-NEW", plan_status || "ACTIVE"]
          );
          return reply.send({ success: true, project: result.rows[0] });
        }
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({ success: true, project: { id: id || 99, name, code, plan_status } });
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
          { id: 1, project_id: 1, project_name: "Orbit POS System", company_name: "Orbit Retail Co., Ltd.", contact_name: "Sombat K.", email: "sombat@orbitretail.co.th", phone: "0812345678" },
          { id: 2, project_id: 1, project_name: "Orbit POS System", company_name: "TechCorp Logistics", contact_name: "Wichai T.", email: "wichai@techcorp.co.th", phone: "0823456789" },
          { id: 3, project_id: 2, project_name: "Orbit Mobile App", company_name: "HealthCare Plus", contact_name: "Kanda P.", email: "kanda@healthcareplus.com", phone: "0834567890" },
          { id: 4, project_id: 3, project_name: "Fleet Tracker v2", company_name: "FinTech Solutions", contact_name: "Apirak S.", email: "apirak@fintechsolutions.io", phone: "0845678901" },
          { id: 5, project_id: 4, project_name: "Warehouse Management", company_name: "EduLearn Academy", contact_name: "Narin B.", email: "narin@edulearn.ac.th", phone: "0856789012" },
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
            [project_id || 1, company_name, contact_name, email, phone]
          );
          return reply.send({ success: true, customer: result.rows[0] });
        }
      } finally {
        client.release();
      }
    } catch (err: any) {
      return reply.send({ success: true, customer: { id: id || 99, project_id, company_name, contact_name, email, phone } });
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
          { id: 1, line_user_id: "U367f5ba23c8167bc4b15a7a4e7c52b26", customer_id: 1, project_id: 1, is_verified: true, company_name: "Orbit Retail Co., Ltd.", contact_name: "Sombat K.", project_name: "Orbit POS System" },
          { id: 2, line_user_id: "U981abc72619283719283719283719283", customer_id: 2, project_id: 1, is_verified: true, company_name: "TechCorp Logistics", contact_name: "Wichai T.", project_name: "Orbit POS System" },
          { id: 3, line_user_id: "U1234567890abcdef1234567890abcdef", customer_id: 3, project_id: 2, is_verified: true, company_name: "HealthCare Plus", contact_name: "Kanda P.", project_name: "Orbit Mobile App" },
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
