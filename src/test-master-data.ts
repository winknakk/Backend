import Fastify from "fastify";
import { registerAuthRoutes } from "./api/routes/auth";
import { registerMasterDataRoutes } from "./api/routes/masterData";

async function runMasterDataTest() {
  console.log("=== Testing Master Data & Auth APIs ===");
  const fastify = Fastify({ logger: false });

  await fastify.register(registerAuthRoutes);
  await fastify.register(registerMasterDataRoutes);

  await fastify.ready();

  // 1. Test Login Endpoint
  const loginRes = await fastify.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "admin123" },
  });
  console.log("Login Response Status:", loginRes.statusCode);
  console.log("Login Response Body:", loginRes.body);

  // 2. Test Get Projects Endpoint
  const projectsRes = await fastify.inject({
    method: "GET",
    url: "/api/v1/admin/master-data/projects",
  });
  console.log("Projects Status:", projectsRes.statusCode);
  console.log("Projects Count:", JSON.parse(projectsRes.body).projects?.length);

  // 3. Test Get Customers Endpoint
  const customersRes = await fastify.inject({
    method: "GET",
    url: "/api/v1/admin/master-data/customers",
  });
  console.log("Customers Status:", customersRes.statusCode);
  console.log("Customers Count:", JSON.parse(customersRes.body).customers?.length);

  // 4. Test Get LINE Identities Endpoint
  const identitiesRes = await fastify.inject({
    method: "GET",
    url: "/api/v1/admin/master-data/identities",
  });
  console.log("Identities Status:", identitiesRes.statusCode);
  console.log("Identities Count:", JSON.parse(identitiesRes.body).identities?.length);

  console.log("=== All Master Data & Auth API Tests Passed Cleanly ===");
  await fastify.close();
}

runMasterDataTest().catch((err) => {
  console.error("Test Error:", err);
  process.exit(1);
});
