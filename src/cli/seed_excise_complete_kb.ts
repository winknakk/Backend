import { pool } from "../adapters/postgres/PostgresAdapter";
import { randomUUID } from "crypto";

async function seedCompleteExciseKnowledge() {
  console.log("=== Seeding Complete EXC03 Knowledge Base & Error Resolution Guides ===");

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
    // Delete existing old Excise embeddings to avoid duplicates
    await client!.query(
      `DELETE FROM document_embeddings WHERE metadata->>'projectId' = '101' OR metadata->>'project_id' = '101'`
    );
    console.log("Cleared old Project 101 embeddings.");

    const kbEntries = [
      {
        title: "EXC03 System Architecture & Main Modules Overview",
        content: `โครงสร้างสถาปัตยกรรมและโมดูลหลักของระบบ EXC03 (Excise Department System):
1. ExciseService / Exci-Core: โฟลเดอร์หลักและบริการบริการแกนกลางระบบสรรพสามิต
2. GenerateReportService / Report: ระบบสร้างรายงาน JasperReports (.jrxml)
3. ServiceImportFile / Exci-Import: โมดูลนำเข้าไฟล์ข้อมูลสรรพสามิตและประมวลผลไฟล์ใหญ่
4. Scheduler / Quartz Scheduler: โมดูลประมวลผลงานอัตโนมัติ (Batch Jobs & Timers)
5. Exci-License / Exci-Tax: ระบบใบอนุญาตและการคำนวณภาษี
6. oneweb-config/: โฟลเดอร์เก็บไฟล์คอนฟิกูเรชันหลักของระบบ OneWeb Framework
   - oneweb-config/app-config.yml: คอนฟิกหลักของแอปพลิเคชันและ System Properties
   - oneweb-config/oneweb-framework.xml: คอนฟิกการทำงานของ OneWeb Enterprise Engine
   - oneweb-config/datasource-ds.xml: คอนฟิก Database Connection Pool (Oracle JDBC)
   - oneweb-config/web.xml & security-roles.xml: คอนฟิก Context Path และระบบรักษาความปลอดภัย

ตำแหน่งไฟล์คอนฟิกหลักทั้งหมดสถิตอยู่ที่โฟลเดอร์ 'oneweb-config/' และ 'oneweb-config/app-config.yml'`,
        metadata: {
          orgId: "org_excise",
          projectId: "101",
          project_id: "101",
          source: "excise_system_architecture",
          title: "EXC03 Main Modules & Config Directory",
          keywords: ["โมดูล", "ไฟล์คอนฟิก", "app-config.yml", "ExciseService", "GenerateReportService", "oneweb-config"]
        }
      },
      {
        title: "EXC03 Report Technology & Template Storage Folder",
        content: `เทคโนโลยีการออกรายงานและโฟลเดอร์เก็บแม่แบบรายงานในระบบ EXC03:
- เทคโนโลยีการออกรายงาน: ใช้เทคโนโลยี JasperReports Framework (ไฟล์แม่แบบนามสกุล .jrxml)
- โฟลเดอร์ที่ใช้เก็บไฟล์แม่แบบรายงาน (.jrxml): เก็บไว้ในโฟลเดอร์ 'Report/' (หรือ 'src/main/resources/reports/' และ 'Report/templates/')
- การทำงาน: คลาส GenerateReportService จะทำการดึงแม่แบบไฟล์ .jrxml จากโฟลเดอร์ Report/ มาคอมไพล์ (Compile) และฉีดข้อมูล (Parameter Injection) เพื่อส่งออกรายงานเป็นไฟล์ PDF หรือ Excel
- หากไฟล์แม่แบบในโฟลเดอร์ Report/ หายไปหรือไม่ถูกรวมใน build package จะเกิดข้อผิดพลาด net.sf.jasperreports.engine.JRException: Resource not found`,
        metadata: {
          orgId: "org_excise",
          projectId: "101",
          project_id: "101",
          source: "excise_report_spec",
          title: "EXC03 Report Technology & Template Directory",
          keywords: ["รายงาน", "JasperReports", "jrxml", "Report/", "GenerateReportService", "แม่แบบรายงาน"]
        }
      },
      {
        title: "EXC03 Scheduler System & Processing Classes",
        content: `การทำงานของระบบ Scheduler และคลาสประมวลผลในระบบ EXC03:
- เทคโนโลยี Scheduler: ใช้ Quartz Scheduler Framework ภายใต้โมดูล 'Scheduler/'
- คลาสหลักที่ทำหน้าที่ตั้งเวลาประมวลผลอัตโนมัติ:
  1. SchedulerDAOImpl (คลาสจัดการคิวงานและอ่านคอนฟิก Scheduler จากฐานข้อมูล)
  2. SchedulerTransactionM (คลาสจัดการ Transaction ของงานประมวลผลตามรอบเวลา)
  3. ExciseSchedulerJob (คลาสสแกนรอบเวลาและเรียกใช้ Batch Job อัตโนมัติ)
- โฟลเดอร์ที่เก็บคลาสตั้งเวลา: สถิตภายใต้โฟลเดอร์ 'Scheduler/' และโมดูล Exci-Batch`,
        metadata: {
          orgId: "org_excise",
          projectId: "101",
          project_id: "101",
          source: "excise_scheduler_spec",
          title: "EXC03 Quartz Scheduler & Processing Classes",
          keywords: ["Scheduler", "Quartz Scheduler", "SchedulerDAOImpl", "SchedulerTransactionM", "ตั้งเวลา", "ประมวลผล"]
        }
      },
      {
        title: "EXC03 Error Resolution Guide: JasperReport Resource Not Found",
        content: `แนวทางแก้ไขปัญหาข้อผิดพลาดออกรายงาน JasperReport ไม่ได้:
- รหัสข้อผิดพลาด: net.sf.jasperreports.engine.JRException: Resource not found
- สาเหตุของปัญหา: เกิดจากคลาส GenerateReportService ไม่พบไฟล์แม่แบบรายงานนามสกุล .jrxml ในโฟลเดอร์ 'Report/' หรือไฟล์แม่แบบรายงานถูกตั้งชื่อไม่ตรง หรือไม่ได้แนบไปพร้อมกับแพ็กเกจ deployment
- วิธีแก้ไขเบื้องต้น:
  1. ตรวจสอบว่าไฟล์แม่แบบ .jrxml มีอยู่อยู่ในโฟลเดอร์ 'Report/' หรือไม่
  2. ตรวจสอบการตั้งชื่อไฟล์แม่แบบใน GenerateReportService ให้ตรงกับชื่อไฟล์จริง
  3. หากสแกนแล้วยังพบปัญหา ให้ดำเนินการเปิด Ticket (ตั๋วงาน) ให้ทีมพัฒนาเข้าดำเนินการแก้ไขแม่แบบในโฟลเดอร์ Report/`,
        metadata: {
          orgId: "org_excise",
          projectId: "101",
          project_id: "101",
          source: "excise_error_guide_jasper",
          title: "JasperReport Resource Not Found Guide",
          keywords: ["JRException", "Resource not found", "JasperReport", "GenerateReportService", "Report/"]
        }
      },
      {
        title: "EXC03 Error Resolution Guide: ServiceImportFile Freeze & Large File Handling",
        content: `แนวทางแก้ไขปัญหาโมดูล ServiceImportFile ค้าง และการนำเข้าไฟล์ขนาดใหญ่ (เช่น 50MB):
- สาเหตุของปัญหาค้าง: โมดูล ServiceImportFile เกิดการค้างเนื่องจาก:
  1. ไฟล์มีขนาดใหญ่ (เช่น 50MB) ทำให้หน่วยความจำ Heap Memory หรือ Connection Pool ใน 'oneweb-config/datasource-ds.xml' ไม่เพียงพอ หรือเกิด Lock ในคลาส UploadMarketYield
  2. การอ่านไฟล์ขนาดใหญ่โดยไม่ได้แบ่ง Batch Chunk ทำให้เธรดการประมวลผลถูกบล็อก
- การดำเนินการ: หากผู้ใช้แจ้งปัญหานำเข้าไฟล์ค้าง หรือขอบันทึกรายละเอียดไฟล์ขนาดใหญ่ 50MB ให้ระบบเปิด Ticket รับเรื่องทันที และอัปเดตข้อมูลไฟล์ 50MB ลงใน Ticket เดิมโดยไม่ต้องเปิด Ticket ซ้ำ`,
        metadata: {
          orgId: "org_excise",
          projectId: "101",
          project_id: "101",
          source: "excise_error_guide_import",
          title: "ServiceImportFile Freeze & 50MB File Guide",
          keywords: ["ServiceImportFile", "ค้าง", "50MB", "นำเข้าไฟล์", "UploadMarketYield", "datasource-ds.xml"]
        }
      }
    ];

    for (const doc of kbEntries) {
      const id = randomUUID();
      await client!.query(
        `INSERT INTO document_embeddings (doc_id, content, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [id, doc.content, JSON.stringify(doc.metadata)]
      );
      console.log(`Inserted KB chunk: ${doc.title}`);
    }

    console.log("=== Successfully Seeded All 5 Comprehensive KB Chunks for Project 101 ===");
  } catch (err: any) {
    console.error("Error seeding knowledge:", err.message);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

seedCompleteExciseKnowledge().catch(console.error);
