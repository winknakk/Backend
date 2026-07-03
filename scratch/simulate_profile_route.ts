import { pool } from "../src/adapters/postgres/PostgresAdapter";
import { PostgresAdapter } from "../src/adapters/postgres/PostgresAdapter";

async function run() {
  const conversationId = "12";
  const adapter = new PostgresAdapter();

  try {
    const conv = await adapter.getConversation(conversationId);
    if (!conv) {
      console.log("Conversation not found");
      return;
    }
    const messages = await adapter.getMessages(conversationId);

    let previousConversations: any[] = [];
    let ticketHistory: any[] = [];
    let customerActivitySummary = {
      total_conversations: 1,
      total_tickets: 0,
      resolved_tickets: 0,
      pending_tickets: 0,
      total_messages: messages.length,
    };

    try {
      console.log("Querying previous conversations...");
      const convRes = await pool.query(
        `SELECT id, channel, status, handled_by, created_at FROM conversations
         WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
           AND id != $1::integer
         ORDER BY created_at DESC LIMIT 100`,
        [conversationId]
      );
      previousConversations = convRes.rows.map((c: any) => ({
        id: String(c.id),
        channel: c.channel || "line",
        status: c.status || "open",
        handled_by: c.handled_by || "ai",
        created_at: c.created_at instanceof Date ? c.created_at.toISOString() : c.created_at || new Date().toISOString(),
      }));
      console.log("Previous conversations query success. Count:", previousConversations.length);
    } catch (e: any) {
      console.error("Previous conversations query failed:", e.message);
    }

    try {
      console.log("Querying tickets...");
      const tixRes = await pool.query(
        `SELECT t.id, t.subject, t.summary, t.status, t.priority
         FROM tickets t
         WHERE t.conversation_id IN (
           SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
         )`,
        [conversationId]
      );
      ticketHistory = tixRes.rows.map((t: any) => {
        const priorityMap: Record<string, string> = { P1: "Critical", P2: "High", P3: "Medium", P4: "Low" };
        const severity = priorityMap[t.priority] || "Low";
        const baseDate = new Date();
        const resolveHoursMap: Record<string, number> = { Critical: 4, High: 12, Medium: 48, Low: 120 };
        const resolveHours = resolveHoursMap[severity] || 120;
        const dueDate = new Date(baseDate.getTime() + resolveHours * 60 * 60 * 1000).toISOString();

        return {
          id: String(t.id),
          id1: String(t.id),
          ticketId: String(t.id),
          conversationId: String(conversationId),
          subject: t.subject,
          summary: t.summary,
          status: t.status,
          priority: t.priority,
          severity,
          dueDate,
          createdAt: baseDate.toISOString(),
        };
      });
      console.log("Tickets query success. Count:", ticketHistory.length);
    } catch (e: any) {
      console.error("Tickets query failed:", e.message);
    }

    try {
      console.log("Querying messages count...");
      const msgsCountRes = await pool.query(
        `SELECT COUNT(*)::integer AS count FROM messages
         WHERE conversation_id IN (
           SELECT id FROM conversations WHERE identity_id = (SELECT identity_id FROM conversations WHERE id = $1::integer)
         )`,
        [conversationId]
      );
      customerActivitySummary = {
        total_conversations: previousConversations.length + 1,
        total_tickets: ticketHistory.length,
        resolved_tickets: ticketHistory.filter((t: any) => t.status === 'Resolved' || t.status === 'Closed' || t.status === 'Done').length,
        pending_tickets: ticketHistory.filter((t: any) => t.status !== 'Resolved' && t.status !== 'Closed' && t.status !== 'Done').length,
        total_messages: msgsCountRes.rows[0]?.count || messages.length,
      };
      console.log("Messages count query success. Summary:", customerActivitySummary);
    } catch (e: any) {
      console.error("Messages count query failed:", e.message);
    }

  } catch (err: any) {
    console.error("Outer simulation failed:", err.message);
  } finally {
    await pool.end();
  }
}

run();
