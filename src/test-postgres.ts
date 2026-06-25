async function runPostgresTests() {
  console.log("=========================================");
  console.log("  AutomationX V2 PostgreSQL Adapter Test  ");
  console.log("=========================================\n");

  const databaseUrl = process.env.DATABASE_URL || "postgresql://automationx:changeme@localhost:5432/automationx";
  process.env.DATABASE_URL = databaseUrl;
  console.log(`Connecting to: ${databaseUrl}`);

  // Dynamically import after setting process.env.DATABASE_URL
  const { PostgresAdapter, pool } = await import("./adapters/postgres/PostgresAdapter");
  const { runMigrations } = await import("./adapters/postgres/migrations");

  // Ensure migrations are run first
  console.log("Running migrations...");
  await runMigrations(pool);
  console.log("Migrations check completed.\n");

  const adapter = new PostgresAdapter();

  try {
    // 1. Seed a test company and a project
    console.log("Seeding test company and project...");
    
    // Clear any existing test data to ensure clean run
    await pool.query("DELETE FROM traces");
    await pool.query("DELETE FROM tickets");
    await pool.query("DELETE FROM messages");
    await pool.query("DELETE FROM conversations");
    await pool.query("DELETE FROM identities");
    await pool.query("DELETE FROM profiles");
    await pool.query("DELETE FROM projects");
    await pool.query("DELETE FROM companies");

    const companyRes = await pool.query(
      "INSERT INTO companies (name) VALUES ($1) RETURNING id, name",
      ["Test Corporate Co"]
    );
    const companyId = companyRes.rows[0].id.toString();
    console.log(`- Seeded Company ID: ${companyId}`);

    const projectRes = await pool.query(
      "INSERT INTO projects (company_id, name, project_type) VALUES ($1, $2, $3) RETURNING id, name",
      [companyRes.rows[0].id, "Orbit Support Project", "IT"]
    );
    const projectId = projectRes.rows[0].id.toString();
    console.log(`- Seeded Project ID: ${projectId}`);

    // 2. Test ensureConversation (creation case)
    console.log("\nTesting ensureConversation (creation)...");
    const senderId = "LINE_USER_123456";
    const channel = "LINE";
    const conversationId = await adapter.ensureConversation(senderId, companyId, channel);
    console.log(`- Generated Conversation ID: ${conversationId}`);
    if (!conversationId) throw new Error("ensureConversation failed to return conversationId");

    // Associate conversation with project so search logic can filter on it
    await pool.query("UPDATE conversations SET project_id = $1 WHERE id = $2", [projectId, conversationId]);

    // 3. Test loadSessionContext
    console.log("\nTesting loadSessionContext...");
    const context = await adapter.loadSessionContext(senderId, channel);
    console.log("- Hydrated Session Context:");
    console.log(`  Session ID: ${context.sessionId}`);
    console.log(`  Company: ${context.companyContext.companyName} (${context.companyContext.companyId})`);
    console.log(`  Conversation ID: ${context.conversationId}`);
    console.log(`  Project Count: ${context.companyContext.projects.length}`);
    if (context.companyId !== companyId) throw new Error("Company ID mismatch");
    if (context.conversationId !== conversationId) throw new Error("Conversation ID mismatch");

    // 4. Test saveMessage
    console.log("\nTesting saveMessage...");
    const msg1 = await adapter.saveMessage(conversationId, "customer", "My Orbit login token is expired");
    const msg2 = await adapter.saveMessage(conversationId, "ai", "Please reset your session key");
    console.log(`- Msg 1 ID: ${msg1.id}, Role: ${msg1.role}, Content: "${msg1.content}"`);
    console.log(`- Msg 2 ID: ${msg2.id}, Role: ${msg2.role}, Content: "${msg2.content}"`);

    // 5. Test getConversationHistory
    console.log("\nTesting getConversationHistory...");
    const history = await adapter.getConversationHistory(conversationId);
    console.log(`- History message count: ${history.length} (Expected: 2)`);
    if (history.length !== 2) throw new Error("Conversation history count mismatch");

    // 6. Test updateHandoffState
    console.log("\nTesting updateHandoffState...");
    await adapter.updateHandoffState(conversationId, "human");
    const convRow = await adapter.getConversation(conversationId);
    console.log(`- Handled by: ${convRow.handled_by} (Expected: human)`);
    if (convRow.handled_by !== "human") throw new Error("Handoff status not updated in DB");

    // 7. Test createTicket
    console.log("\nTesting createTicket...");
    const ticketInput = {
      conversationId,
      subject: "Orbit App login failure",
      summary: "User gets session expired error",
      priority: "P2" as const,
      severity: "High" as const,
      projectId
    };
    const ticketRes = await adapter.createTicket(ticketInput, new Date().toISOString(), "TKT-100001");
    console.log(`- Ticket creation success: ${ticketRes.success}`);
    console.log(`- Source: ${ticketRes.source}`);
    console.log(`- Ticket Number: ${ticketRes.data.ticket_id}`);
    if (!ticketRes.success) throw new Error("Failed to create ticket: " + ticketRes.error);

    // 8. Test saveTrace & getTrace & listTraces
    console.log("\nTesting trace logging...");
    const traceId = "a2c3d4e5-6f7a-8b9c-0d1e-2f3a4b5c6d7e";
    const auditLog = {
      traceId,
      sessionId: `sess_${conversationId}`,
      toolName: "search_project_docs",
      calledAt: new Date().toISOString(),
      reason: "Initial troubleshooting lookup",
      arguments: { query: "Orbit App" },
      result: { resultsCount: 2 },
      status: "COMPLETED" as const,
      requestId: "req-99999",
      conversationId,
      parentTraceId: "req-99999"
    };

    console.log("- Saving trace...");
    await adapter.saveTrace(auditLog);

    console.log("- Retrieving trace...");
    const fetchedTrace = await adapter.getTrace(traceId);
    if (!fetchedTrace) throw new Error("Failed to retrieve trace");
    console.log(`  Retrieved Tool: ${fetchedTrace.toolName}`);
    console.log(`  Retrieved Status: ${fetchedTrace.status}`);

    console.log("- Listing traces...");
    const traces = await adapter.listTraces(`sess_${conversationId}`);
    console.log(`  Traces count: ${traces.length} (Expected: 1)`);
    if (traces.length !== 1) throw new Error("Traces list mismatch");

    // 9. Test searchKnowledge
    console.log("\nTesting searchKnowledge...");
    // A. Search by content match in messages
    const knowledgeResults1 = await adapter.searchKnowledge("expired");
    console.log(`- Search 'expired' count: ${knowledgeResults1.length}`);
    if (knowledgeResults1.length === 0) throw new Error("Knowledge search did not find message with 'expired'");

    // B. Search by content match in tickets
    const knowledgeResults2 = await adapter.searchKnowledge("failure", { projectId });
    console.log(`- Search 'failure' with projectId filter count: ${knowledgeResults2.length}`);
    if (knowledgeResults2.length === 0) throw new Error("Knowledge search did not find ticket with 'failure'");

    console.log("\n✅ All PostgreSQL Adapter tests PASSED successfully!");

  } catch (err: any) {
    console.error("\n❌ PostgreSQL Adapter Test FAILED:");
    console.error(err.message);
    process.exit(1);
  } finally {
    // End pool connections
    await pool.end();
    console.log("PostgreSQL connection pool closed.");
  }
}

runPostgresTests().catch(err => {
  console.error(err);
  process.exit(1);
});
