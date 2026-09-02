import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function cleanSingleCustomer() {
  const target = process.argv[2];

  console.log("=================================================================");
  console.log("  TicketX Database: Clean Single Customer Data");
  console.log("=================================================================");

  if (!target) {
    console.log("❌ กรุณาระบุชื่อลูกค้า, LINE User ID (U...), หรือ Conversation ID");
    console.log("ตัวอย่างการใช้งาน:");
    console.log('  npx tsx src/cli/clean-single-customer.ts "Natapohn"');
    console.log('  npx tsx src/cli/clean-single-customer.ts "U1029384756abcdef..."');
    console.log('  npx tsx src/cli/clean-single-customer.ts 67\n');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL is not defined in .env");
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15000,
  });

  try {
    await client.connect();
    console.log(`🔍 ค้นหาข้อมูลของลูกค้าเป้าหมาย: "${target}"...\n`);

    // 1. Find identity, profile, and conversations
    let identitiesQuery = `
      SELECT i.id as identity_id, i.channel, i.channel_ref, p.id as profile_id, p.name as customer_name
      FROM identities i
      LEFT JOIN profiles p ON i.profile_id = p.id
      WHERE i.channel_ref = $1
         OR i.channel_ref ILIKE $2
         OR p.name ILIKE $2
    `;
    let queryParams: any[] = [target, `%${target}%`];

    const isNumeric = /^\d+$/.test(target);
    if (isNumeric) {
      identitiesQuery = `
        SELECT i.id as identity_id, i.channel, i.channel_ref, p.id as profile_id, p.name as customer_name
        FROM identities i
        LEFT JOIN profiles p ON i.profile_id = p.id
        LEFT JOIN conversations c ON c.identity_id = i.id
        WHERE i.id = $1::integer OR c.id = $1::integer OR i.channel_ref = $2
      `;
      queryParams = [parseInt(target, 10), target];
    }

    const idRes = await client.query(identitiesQuery, queryParams);
    if (idRes.rows.length === 0) {
      console.log(`⚠️  ไม่พบข้อมูลลูกค้าที่ตรงกับ "${target}"`);
      process.exit(0);
    }

    console.log(`📋 พบข้อมูลลูกค้า ${idRes.rows.length} รายการ:`);
    for (const row of idRes.rows) {
      console.log(`  - Identity ID: ${row.identity_id} | Channel: ${row.channel} | Ref: ${row.channel_ref} | Name: ${row.customer_name || 'N/A'}`);
    }

    const identityIds = idRes.rows.map((r: any) => r.identity_id);
    const channelRefs = idRes.rows.map((r: any) => r.channel_ref).filter(Boolean);

    // Find all conversations
    const convRes = await client.query(
      `SELECT id FROM conversations WHERE identity_id = ANY($1::int[])`,
      [identityIds]
    );
    const convIds = convRes.rows.map((r: any) => r.id);
    console.log(`  - Conversations ที่เกี่ยวข้อง: [${convIds.join(", ")}]`);

    console.log("\n🧹 กำลังลบข้อมูลทั้งหมดของลูกค้ารายนี้...");

    if (convIds.length > 0) {
      // Clear queue and state
      await client.query(`DELETE FROM agent_session_state WHERE conversation_id = ANY($1::int[])`, [convIds]);
      await client.query(`DELETE FROM agent_session_queue WHERE conversation_id = ANY($1::int[])`, [convIds]);
      
      // Clear tickets & attachments
      await client.query(`DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ANY($1::int[]))`, [convIds]);
      await client.query(`DELETE FROM messages WHERE conversation_id = ANY($1::int[])`, [convIds]);
      await client.query(`DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE conversation_id = ANY($1::int[]))`, [convIds]);
      await client.query(`DELETE FROM ticket_summaries WHERE ticket_id IN (SELECT id FROM tickets WHERE conversation_id = ANY($1::int[]))`, [convIds]);
      await client.query(`DELETE FROM tickets WHERE conversation_id = ANY($1::int[])`, [convIds]);
      await client.query(`DELETE FROM conversations WHERE id = ANY($1::int[])`, [convIds]);
      console.log(`  ✅ ลบประวัติแชท, ข้อความ, และ Tickets ของห้อง [${convIds.join(", ")}] เรียบร้อย`);
    }

    // Clear onboarding sessions & memberships
    if (channelRefs.length > 0) {
      await client.query(`DELETE FROM line_onboarding_sessions WHERE line_user_id = ANY($1::varchar[])`, [channelRefs]);
      await client.query(`DELETE FROM customer_project_memberships WHERE line_user_id = ANY($1::varchar[])`, [channelRefs]);
      console.log(`  ✅ ลบสถานะ LINE Onboarding & Membership เรียบร้อย`);
    }

    // Clear identities
    await client.query(`DELETE FROM identities WHERE id = ANY($1::int[])`, [identityIds]);
    console.log(`  ✅ ลบ Identity [${identityIds.join(", ")}] เรียบร้อย`);

    console.log("\n=================================================================");
    console.log(`🎉 ลบข้อมูลของ "${target}" เรียบร้อยแล้ว!`);
    console.log("   ลูกค้ารายนี้สามารถเริ่มทักเข้ามาเพื่อทดสอบ Flow ใหม่ได้ทันที");
    console.log("=================================================================");
  } catch (err: any) {
    console.error("\n❌ Error:", err.message);
  } finally {
    await client.end().catch(() => {});
  }
}

cleanSingleCustomer();
