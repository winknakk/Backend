import { pool } from '../adapters/postgres/PostgresAdapter';

async function main() {
  console.log('Seeding real demo Customer profile and tickets in Database...');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Create or update Company 1
    await client.query(`
      INSERT INTO companies (id, name)
      VALUES (1, 'Avalant Co., Ltd.')
      ON CONFLICT (id) DO UPDATE SET name = 'Avalant Co., Ltd.'
    `);

    // 2. Create or update Project 1
    await client.query(`
      INSERT INTO projects (id, company_id, name, org_id)
      VALUES (1, 1, 'TicketX Customer Support', 'org_avalant')
      ON CONFLICT (id) DO UPDATE SET name = 'TicketX Customer Support', org_id = 'org_avalant'
    `);

    // 3. Create or update Customer Profile (คุณวิน)
    const profRes = await client.query(`
      INSERT INTO profiles (id, company_id, name, email, phone)
      VALUES (101, 1, 'คุณวิน (ลูกค้า)', 'customer.win@ticketx.local', '0633628242')
      ON CONFLICT (id) DO UPDATE
        SET name = 'คุณวิน (ลูกค้า)',
            email = 'customer.win@ticketx.local',
            phone = '0633628242'
      RETURNING id, name, email
    `);
    const profile = profRes.rows[0];
    console.log(`  Profile: ID=${profile.id}, Name=${profile.name}, Email=${profile.email}`);

    // 4. Create or update Identity
    await client.query(`
      INSERT INTO identities (id, profile_id, channel, channel_ref)
      VALUES (101, 101, 'WebChat', 'cust_win_01')
      ON CONFLICT (id) DO UPDATE
        SET profile_id = '101',
            channel = 'WebChat',
            channel_ref = 'cust_win_01'
    `);
    console.log(`  Identity mapped: channelRef=cust_win_01 -> profile_id=101`);

    // 5. Grant project access
    await client.query(`
      INSERT INTO profile_projects (profile_id, project_id)
      VALUES (101, 1)
      ON CONFLICT (profile_id, project_id) DO NOTHING
    `);

    // 6. Create conversation for Customer
    await client.query(`
      INSERT INTO conversations (id, identity_id, project_id, channel, status, handled_by)
      VALUES (101, 101, 1, 'WebChat', 'open', 'ai')
      ON CONFLICT (id) DO UPDATE SET status = 'open'
    `);

    // 7. Seed initial demo tickets for this customer
    const existingTickets = await client.query('SELECT ticket_id FROM tickets WHERE conversation_id = 101');
    const existingIds = existingTickets.rows.map(r => r.ticket_id);

    if (!existingIds.includes('TCK-2026-10101')) {
      await client.query(`
        INSERT INTO tickets (ticket_id, conversation_id, project_id, org_id, subject, summary, status, priority, severity)
        VALUES ('TCK-2026-10101', 101, 1, 'org_avalant', 'สอบถามการตั้งค่าการเชื่อมต่อ API', 'ต้องการคำแนะนำเกี่ยวกับ Authentication Header สำหรับ Webhook', 'IN_PROGRESS', 'P2', 'medium')
      `);
    }

    if (!existingIds.includes('TCK-2026-10102')) {
      await client.query(`
        INSERT INTO tickets (ticket_id, conversation_id, project_id, org_id, subject, summary, status, priority, severity)
        VALUES ('TCK-2026-10102', 101, 1, 'org_avalant', 'ขอเพิ่มจำนวนสิทธิ์การใช้งานระบบ', 'ขอเพิ่มผู้ใช้งานในแผนกบริการลูกค้าจำนวน 5 สิทธิ์ ดำเนินการเรียบร้อยแล้ว', 'RESOLVED', 'P3', 'low')
      `);
    }

    if (!existingIds.includes('TCK-2026-10103')) {
      await client.query(`
        INSERT INTO tickets (ticket_id, conversation_id, project_id, org_id, subject, summary, status, priority, severity)
        VALUES ('TCK-2026-10103', 101, 1, 'org_avalant', 'ตรวจสอบปัญหาการแจ้งเตือนผ่านอีเมล', 'แก้ไขการส่งอีเมลแจ้งเตือนเรียบร้อยและได้รับการยืนยันแล้ว', 'CUSTOMER_CONFIRMED', 'P3', 'low')
      `);
    }

    console.log(`  Tickets ready for customer คุณวิน: TCK-2026-10101, TCK-2026-10102, TCK-2026-10103`);

    await client.query('COMMIT');
    console.log('\n✅ Customer profile & demo tickets seeded successfully!');
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Failed to seed customer:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
