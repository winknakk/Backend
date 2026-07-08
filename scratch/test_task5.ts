import { fastify } from "../src/api/server";

async function main() {
  const { pool } = require("../src/adapters/postgres/PostgresAdapter");

  try {
    console.log("Seeding identity for Task 5...");
    await pool.query("INSERT INTO companies (id, name) VALUES (999, 'Task 5 Company') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO profiles (id, name, company_id) VALUES (999, 'Task 5 Profile', 999) ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO identities (id, profile_id, channel, channel_ref) VALUES ('task5-ident', 999, 'LINE', 'task5-ref') ON CONFLICT DO NOTHING");

    // Clean old conversations
    await pool.query("DELETE FROM conversations WHERE identity_id = 'task5-ident'");

    // 1. Create conversation with no project_id (V2 compatibility)
    console.log("\n1. Creating conversation 1 (No project)...");
    const c1 = await fastify.inject({
      method: "POST",
      url: "/api/v1/internal/conversations",
      payload: {
        identityId: "task5-ident",
        channel: "LINE",
        status: "open",
        handledBy: "ai",
      },
    });
    console.log("Status:", c1.statusCode);
    console.log("Response:", c1.json());
    const id1 = c1.json().id;

    // 2. Create conversation with project_id = 2 (V3 project scoping)
    console.log("\n2. Creating conversation 2 (Project ID = 2)...");
    const c2 = await fastify.inject({
      method: "POST",
      url: "/api/v1/internal/conversations",
      payload: {
        identityId: "task5-ident",
        channel: "LINE",
        status: "open",
        handledBy: "ai",
        projectId: "2",
      },
    });
    console.log("Status:", c2.statusCode);
    console.log("Response:", c2.json());
    const id2 = c2.json().id;

    // 3. Search conversations with no projectId (should return the latest, which is c2 since it was created last)
    console.log("\n3. Searching conversations (No project filter, expect latest conversation)...");
    const s1 = await fastify.inject({
      method: "GET",
      url: "/api/v1/internal/conversations/search?identityId=task5-ident&status=open",
    });
    console.log("Status:", s1.statusCode);
    const foundId1 = s1.json()[0]?.id;
    console.log("Found Conv ID:", foundId1);
    if (foundId1 === id2) {
      console.log("✅ Success: Found latest conversation.");
    } else {
      console.error("❌ Failure: Expected latest conversation ID", id2, "got", foundId1);
    }

    // 4. Search conversations with projectId=2 (should return c2)
    console.log("\n4. Searching conversations (?projectId=2)...");
    const s2 = await fastify.inject({
      method: "GET",
      url: "/api/v1/internal/conversations/search?identityId=task5-ident&status=open&projectId=2",
    });
    console.log("Status:", s2.statusCode);
    const foundId2 = s2.json()[0]?.id;
    console.log("Found Conv ID:", foundId2);
    if (foundId2 === id2) {
      console.log("✅ Success: Found correct project 2 conversation.");
    } else {
      console.error("❌ Failure: Expected conversation ID", id2, "got", foundId2);
    }

    // 5. Search conversations with header x-project-id: 2
    console.log("\n5. Searching conversations (Header x-project-id: 2)...");
    const s3 = await fastify.inject({
      method: "GET",
      url: "/api/v1/internal/conversations/search?identityId=task5-ident&status=open",
      headers: {
        "x-project-id": "2",
      },
    });
    console.log("Status:", s3.statusCode);
    const foundId3 = s3.json()[0]?.id;
    console.log("Found Conv ID:", foundId3);
    if (foundId3 === id2) {
      console.log("✅ Success: Found correct project 2 conversation via header.");
    } else {
      console.error("❌ Failure: Expected conversation ID", id2, "got", foundId3);
    }

    // 6. Search conversations with projectId=1 (should return empty since c1 has project_id = null and c2 has project_id = 2)
    console.log("\n6. Searching conversations (?projectId=1, expect none)...");
    const s4 = await fastify.inject({
      method: "GET",
      url: "/api/v1/internal/conversations/search?identityId=task5-ident&status=open&projectId=1",
    });
    console.log("Status:", s4.statusCode);
    console.log("Found List Length:", s4.json()?.length);
    if (s4.json()?.length === 0) {
      console.log("✅ Success: Correctly filtered out project 2 and projectless conversations.");
    } else {
      console.error("❌ Failure: Expected empty list, got", s4.json());
    }

  } catch (err: any) {
    console.error("Test failed with error:", err.message);
  } finally {
    const { pool } = require("../src/adapters/postgres/PostgresAdapter");
    await pool.end();
  }
}

main();
