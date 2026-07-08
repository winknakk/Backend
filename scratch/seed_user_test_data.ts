import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log("Connected to database. Executing updates...");

  try {
    // 1. Company
    await client.query(`
      INSERT INTO companies (id, name)
      VALUES (5, 'Avalant Co.,Ltd.')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
    `);
    console.log("Seeded Company 5");

    // 2. Profile
    await client.query(`
      INSERT INTO profiles (id, company_id, name)
      VALUES (5, 5, 'Akkharin Laksana')
      ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id, name = EXCLUDED.name;
    `);
    console.log("Seeded Profile 5");

    // 3. Project
    await client.query(`
      INSERT INTO projects (id, company_id, name)
      VALUES (8, 5, '24/7')
      ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id, name = EXCLUDED.name;
    `);
    console.log("Seeded Project 8");

    // 4. Profile-Project Junction
    await client.query(`
      INSERT INTO profile_projects (profile_id, project_id)
      VALUES (5, 8)
      ON CONFLICT (profile_id, project_id) DO NOTHING;
    `);
    console.log("Seeded Profile-Project link (5, 8)");

    // 5. Identity (LINE channel identity matching your user request)
    await client.query(`
      INSERT INTO identities (id, profile_id, channel, channel_ref)
      VALUES (7, 5, 'line', 'Uad28c1eabbcbe1608e038d4d162f4944')
      ON CONFLICT (id) DO UPDATE SET 
        profile_id = EXCLUDED.profile_id, 
        channel = EXCLUDED.channel, 
        channel_ref = EXCLUDED.channel_ref;
    `);
    console.log("Seeded Identity 7 (LINE)");

    // 6. Conversation (Link it to identity 7 and project 8, and channel 'line')
    // Note: promptx_conversation_id column is omitted as it does not exist in the Postgres schema.
    await client.query(`
      INSERT INTO conversations (id, identity_id, project_id, channel, status, handled_by, assigned_pm)
      VALUES (5, 7, 8, 'line', 'open', 'ai', NULL)
      ON CONFLICT (id) DO UPDATE SET 
        identity_id = EXCLUDED.identity_id, 
        project_id = EXCLUDED.project_id, 
        channel = EXCLUDED.channel, 
        status = EXCLUDED.status, 
        handled_by = EXCLUDED.handled_by;
    `);
    console.log("Seeded Conversation 5");

    // 7. Message (Link it to conversation 5)
    // Note: query column is omitted as it does not exist in the messages schema.
    await client.query(`
      INSERT INTO messages (conversation_id, role, content, created_at)
      VALUES (5, 'customer', 'ระบบล่ม ขึ้น Error 404 Server เข้าไม่ได้เลย รีบด่วน', '2026-06-30T21:09:23.730Z')
      ON CONFLICT DO NOTHING;
    `);
    console.log("Seeded Message");

    // 8. Project 8 prompts config (for v3 config loader validation)
    await client.query(`
      INSERT INTO project_prompts (project_id, system_instruction, model_name, temperature, max_tokens)
      VALUES (8, 'คุณคือ Support Agent AI สำหรับช่วยเหลือผู้ใช้ระบบ 24/7 ของ Avalant', 'gemini-1.5-pro', 0.00, 2048)
      ON CONFLICT DO NOTHING;
    `);
    console.log("Seeded Project 8 Prompt Settings");

    // 9. Project 8 SLA policies
    await client.query(`
      INSERT INTO project_sla_policies (project_id, priority, resolve_hours) VALUES
        (8, 'P1', 4),
        (8, 'P2', 24),
        (8, 'P3', 72),
        (8, 'P4', 168)
      ON CONFLICT (project_id, priority) DO NOTHING;
    `);
    console.log("Seeded Project 8 SLA Policies");

    // 10. Project 8 AI settings
    await client.query(`
      INSERT INTO project_ai_settings (project_id, confidence_threshold, max_handoff_depth, vector_match_threshold)
      VALUES (8, 0.70, 5, 0.60)
      ON CONFLICT (project_id) DO NOTHING;
    `);
    console.log("Seeded Project 8 AI Settings");

    // 11. Project 8 Feature Flags
    await client.query(`
      INSERT INTO project_feature_flags (project_id, flag_name, is_enabled) VALUES
        (8, 'enable_auto_escalation', true),
        (8, 'enable_rag_search', true)
      ON CONFLICT (project_id, flag_name) DO NOTHING;
    `);
    console.log("Seeded Project 8 Feature Flags");

    console.log("Successfully seeded all data!");
  } catch (err: any) {
    console.error("Error executing queries:", err.message);
  } finally {
    await client.end();
  }
}

run();
