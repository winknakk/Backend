import { pool } from "../adapters/postgres/PostgresAdapter";
import { randomUUID } from "crypto";

async function seedExciseKnowledge() {
  console.log("=== Seeding Knowledge Embeddings for Project 101 (EXC03) ===");
  
  let client;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      client = await pool.connect();
      break;
    } catch (err: any) {
      console.warn(`Connection attempt ${attempt} failed: ${err.message}`);
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  try {
    const existing = await client!.query(
      `SELECT count(*) FROM document_embeddings WHERE metadata->>'projectId' = '101' OR metadata->>'project_id' = '101'`
    );
    console.log(`Found ${existing.rows[0].count} existing docs/code embeddings for Project 101`);

    const docs = [
      {
        title: "EXC03 System Overview & Module Architecture",
        content: `ระบบ EXC03 (ระบบสารสนเทศกรมสรรพสามิต / Excise Department System) ประกอบด้วย 14 โมดูลหลัก ได้แก่:
1. Exci-Core: ระบบบริหารจัดการหลักและแกนกลางระบบสรรพสามิต
2. Exci-License: ระบบใบอนุญาตสรรพสามิตและการอนุมัติ
3. Exci-Tax: ระบบคำนวณและประเมินภาษีสรรพสามิต
4. Exci-Payment: ระบบรับชำระเงินและออกใบเสร็จรับเงิน
5. Exci-Report: ระบบรายงานสถิติและรายงาน JasperReports
6. Exci-Audit: ระบบตรวจสอบการชำระภาษีและตรวจบัญชี
7. Exci-Batch: ระบบงานประมวลผล Quartz Scheduler Batch Jobs
8. Exci-Security: ระบบบริหารจัดการสิทธิ์ผู้ใช้งาน OneWeb Security Roles
9. Exci-Master: ระบบข้อมูลหลักและตารางอ้างอิงกรมสรรพสามิต
10. Exci-Integration: ระบบเชื่อมโยงข้อมูลหน่วยงานภายนอก (G-Net, Revenue)
11. Exci-Notification: ระบบแจ้งเตือนและส่งข้อความ SMS/Email
12. Exci-Workflow: ระบบอนุมัติคำขอและผังงานเอกสาร
13. Exci-Config: ระบบจัดการค่าคอนฟิกูเรชัน OneWeb Enterprise
14. Exci-API: ระบบ REST/SOAP API Gateway กรมสรรพสามิต

GitLab Repository: http://192.168.0.136/HCMProductV4/exc03_excise.git`,
        type: "document",
        metadata: {
          orgId: "org_excise",
          projectId: "101",
          project_id: "101",
          source: "excise_system_doc",
          title: "EXC03 Modules & Architecture",
        }
      },
      {
        title: "EXC03 Configuration & Architecture Specification",
        content: `โครงสร้างคอนฟิกูเรชันของระบบ EXC03 (oneweb-config/):
- ตำแหน่งไฟล์คอนฟิกหลัก: อยู่ในโฟลเดอร์ 'oneweb-config/' ของโปรเจกต์
- คอนฟิกของ OneWeb Enterprise Framework: ตั้งค่าที่ oneweb-config/oneweb-framework.xml
- Database Connection Pool: ตั้งค่าการเชื่อมต่อ Oracle Database (Oracle JDBC Driver) ที่ oneweb-config/datasource-ds.xml
- Context Path & Security Roles: ตั้งค่า URL Context Path และ Role-based Access Control (RBAC) ที่ oneweb-config/web.xml และ oneweb-config/security-roles.xml
- Dependencies & Build Metadata:
  * pom.xml: จัดการ Maven Dependencies ได้แก่ JasperReports (สำหรับออกรายงาน pdf/excel), Quartz Scheduler (สำหรับ Batch jobs), และ Oracle JDBC Driver (ojdbc8)
  * .classpath: Eclipse project classpath configuration`,
        type: "document",
        metadata: {
          orgId: "org_excise",
          projectId: "101",
          project_id: "101",
          source: "excise_config_doc",
          title: "EXC03 Configuration Specs",
        }
      },
      {
        title: "EXC03 Codebase File Index & Symbol Search",
        content: `ไฟล์คอนฟิกหลักและโค้ดของระบบ EXC03:
- oneweb-config/oneweb-framework.xml: สถาปัตยกรรม OneWeb Enterprise Framework
- oneweb-config/datasource-ds.xml: Oracle JDBC Connection Pool
- oneweb-config/web.xml: Context Path และ Security Filter
- oneweb-config/security-roles.xml: Security Roles & Role Mapping
- pom.xml: Library versions (JasperReports, Quartz Scheduler, Oracle JDBC Driver)
- .classpath: Java build path reference`,
        type: "code_symbol",
        metadata: {
          orgId: "org_excise",
          projectId: "101",
          project_id: "101",
          type: "code_symbol",
          filePath: "oneweb-config/oneweb-framework.xml",
          language: "xml",
          repositoryId: "exc03_excise",
          branch: "master"
        }
      }
    ];

    for (const doc of docs) {
      const id = randomUUID();
      await client!.query(
        `INSERT INTO document_embeddings (doc_id, content, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [id, doc.content, JSON.stringify(doc.metadata)]
      );
      console.log(`Inserted embedding: ${doc.title}`);
    }

    console.log("=== Successfully Seeded Knowledge for Project 101 (EXC03) ===");
  } catch (err: any) {
    console.error("Error seeding knowledge:", err.message);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

seedExciseKnowledge().catch(console.error);
