import assert from "assert";
import { PostgresAdapter, pool } from "./adapters/postgres/PostgresAdapter";
import { PlaneWebhookService } from "./services/planeWebhookService";

const ticketNumber = "TCK-TEST-PLANE-DELETE";
const planeIssueId = "00000000-0000-0000-0000-000000000224";

async function cleanup(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ticketx.skip_plane_delete = 'on'");
    await client.query("DELETE FROM tickets WHERE ticket_number = $1", [ticketNumber]);
    await client.query("DELETE FROM outbox_events WHERE aggregate_id = $1", [ticketNumber]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function run(): Promise<void> {
  await cleanup();
  await pool.query(
    `INSERT INTO tickets (
      conversation_id, ticket_number, subject, summary, status,
      priority, severity, plane_issue_id, created_at, updated_at
    )
    VALUES (67, $1, 'Plane delete integration test', 'synthetic row', 'open',
            'P4', 'Low', $2, NOW(), NOW())`,
    [ticketNumber, planeIssueId]
  );

  const result = await new PlaneWebhookService(new PostgresAdapter()).sync({
    event: "issue",
    action: "delete",
    data: { id: planeIssueId },
  });
  assert.strictEqual(result.deleted, true);

  const ticket = await pool.query("SELECT id FROM tickets WHERE ticket_number = $1", [ticketNumber]);
  assert.strictEqual(ticket.rowCount, 0);

  const outboundDelete = await pool.query(
    "SELECT id FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'PlaneWorkItemDeleteRequested'",
    [ticketNumber]
  );
  assert.strictEqual(outboundDelete.rowCount, 0);

  console.log("Plane-to-PostgreSQL delete integration test passed");
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await pool.end();
  });
