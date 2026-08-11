import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { LineProjectOnboardingService } from "../services/LineProjectOnboardingService";
import fs from "fs";
import path from "path";

async function seedAndGenerate(): Promise<void> {
  console.log("Starting DB seeding for Excise Project (101)...");
  
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    attempts++;
    console.log(`Connection attempt ${attempts}/${maxAttempts}...`);
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // 1. Insert Organization
        await client.query(`
          INSERT INTO organizations (id, name, slug)
          VALUES ('org_excise', 'กรมสรรพสามิต (Excise Department)', 'excise')
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug;
        `);

        // 2. Insert Company
        await client.query(`
          INSERT INTO companies (id, name)
          VALUES (101, 'กรมสรรพสามิต')
          ON CONFLICT (id) DO NOTHING;
        `);

        // 3. Insert Project
        await client.query(`
          INSERT INTO projects (id, company_id, name, project_type, environment, org_id)
          VALUES (101, 101, 'EXC03 - ระบบสารสนเทศกรมสรรพสามิต', 'Enterprise Application', 'Production', 'org_excise')
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, org_id = EXCLUDED.org_id;
        `);

        // 4. Insert User Roles
        await client.query(`
          CREATE TABLE IF NOT EXISTS user_roles (
            id VARCHAR(64) PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL UNIQUE,
            role VARCHAR(32) NOT NULL,
            org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id),
            status VARCHAR(32) NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          INSERT INTO user_roles (id, user_email, role, org_id, status)
          VALUES ('usr_excise_001', 'somchai.excise@excise.go.th', 'customer', 'org_excise', 'active')
          ON CONFLICT (user_email) DO UPDATE SET role = EXCLUDED.role, org_id = EXCLUDED.org_id;
        `);

        // 5. Insert Project Channel Mapping for LINE (Both default and actual LINE Destination ID U48cb9897ca17cda31f68856063ecd999)
        await client.query(`
          CREATE TABLE IF NOT EXISTS project_channels (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE CASCADE,
            channel_type VARCHAR(32) NOT NULL,
            channel_id VARCHAR(255),
            is_enabled BOOLEAN DEFAULT TRUE,
            active BOOLEAN DEFAULT TRUE
          );
          
          INSERT INTO project_channels (project_id, channel_type, channel_id, is_enabled, active)
          VALUES 
            (101, 'line', 'default', true, true),
            (101, 'line', 'U48cb9897ca17cda31f68856063ecd999', true, true)
          ON CONFLICT DO NOTHING;
        `);

        // 6. Insert Git Repository Mapping
        await client.query(`
          CREATE TABLE IF NOT EXISTS project_git_repositories (
            id VARCHAR(64) PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            provider VARCHAR(32) NOT NULL DEFAULT 'custom',
            repo_url TEXT NOT NULL,
            default_branch VARCHAR(128) NOT NULL DEFAULT 'master',
            auth_type VARCHAR(32) NOT NULL DEFAULT 'none',
            status VARCHAR(32) NOT NULL DEFAULT 'active',
            org_id VARCHAR(64) NOT NULL DEFAULT 'org_default' REFERENCES organizations(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          INSERT INTO project_git_repositories (
            id, project_id, provider, repo_url, default_branch, auth_type, status, org_id
          )
          VALUES (
            'repo_excise_001', 101, 'gitlab', 'http://192.168.0.136/HCMProductV4/exc03_excise.git', 'master', 'none', 'active', 'org_excise'
          )
          ON CONFLICT (id) DO UPDATE SET repo_url = EXCLUDED.repo_url, provider = EXCLUDED.provider;
        `);

        // 7. Insert Customers & Multi-Project Identities
        await client.query(`
          CREATE TABLE IF NOT EXISTS customers (
            id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(id) ON DELETE SET NULL,
            company_name VARCHAR(255) NOT NULL,
            contact_name VARCHAR(255),
            email VARCHAR(255),
            phone VARCHAR(64),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );

          CREATE TABLE IF NOT EXISTS customer_identities (
            id SERIAL PRIMARY KEY,
            line_user_id VARCHAR(255) NOT NULL,
            customer_id INT REFERENCES customers(id) ON DELETE CASCADE,
            project_id INT REFERENCES projects(id) ON DELETE CASCADE,
            is_verified BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            CONSTRAINT uq_line_customer_project UNIQUE (line_user_id, project_id)
          );

          INSERT INTO customers (id, project_id, company_name, contact_name, email, phone)
          VALUES
            (1, 1, 'AutomationX Demo Company', 'User LINE Main', 'user.line@automationx.io', '0812345678'),
            (101, 101, 'กรมสรรพสามิต (Excise Department)', 'สมชาย สรรพสามิต', 'somchai.excise@excise.go.th', '0899999999')
          ON CONFLICT (id) DO UPDATE SET company_name = EXCLUDED.company_name, contact_name = EXCLUDED.contact_name;

          INSERT INTO customer_identities (line_user_id, customer_id, project_id, is_verified)
          VALUES
            ('U367f5ba23c8167bc4b15a7a4e7c52b26', 1, 1, true),
            ('U367f5ba23c8167bc4b15a7a4e7c52b26', 101, 101, true)
          ON CONFLICT (line_user_id, project_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, is_verified = true;
        `);

        await client.query("COMMIT");
        console.log("Database seeded successfully.");

        // 8. Generate Active LINE Join Code via LineProjectOnboardingService
        const pepper = config.PROJECT_JOIN_CODE_PEPPER || config.LINE_CHANNEL_ACCESS_TOKEN || "automationx_default_pepper_key_2026";
        const service = new LineProjectOnboardingService(pool, pepper, config.LINE_ONBOARDING_MODE);

        const result = await service.rotateJoinCode({
          projectId: 101,
          orgId: "org_excise",
          createdBy: "seed_and_generate_excise_code",
        });

        console.log("\n=======================================================");
        console.log(`Project: ${result.projectName} (${result.projectId})`);
        console.log(`VALID LINE JOIN CODE: ${result.code}`);
        console.log("=======================================================\n");

        // Write to LINE-Project-Codes.txt
        const codeFilePath = path.resolve(__dirname, "../../data/LINE-Project-Codes.txt");
        let content = fs.readFileSync(codeFilePath, "utf8");
        if (!content.includes(`Project ID: 101`)) {
          content += `\nProject ID: 101\nProject: EXC03 - ระบบสารสนเทศกรมสรรพสามิต\nJoin Code: ${result.code}\n`;
          fs.writeFileSync(codeFilePath, content, "utf8");
        } else {
          content = content.replace(/Project ID: 101\nProject: EXC03 - ระบบสารสนเทศกรมสรรพสามิต\nJoin Code: .*/, `Project ID: 101\nProject: EXC03 - ระบบสารสนเทศกรมสรรพสามิต\nJoin Code: ${result.code}`);
          fs.writeFileSync(codeFilePath, content, "utf8");
        }
        client.release();
        break;
      } catch (err) {
        await client.query("ROLLBACK");
        client.release();
        throw err;
      }
    } catch (err: any) {
      console.error(`Attempt ${attempts} failed: ${err.message}`);
      if (attempts >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  await pool.end();
}

seedAndGenerate();
