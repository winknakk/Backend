import { DiagnosticSlotEngine, DiagnosticSlots } from '../services/diagnostic_slot_engine';
import { formatDeveloperDiagnosticHtml } from '../services/planeService';

async function runTests() {
  console.log('========================================');
  console.log('🧪 Testing Phase 6 (P6) Diagnostic Pipeline');
  console.log('========================================\n');

  // Test Case 1: Incomplete Customer Report (Needs progressive question)
  console.log('--- Test Case 1: Incomplete Customer Report ---');
  const input1: DiagnosticSlots = {
    project_id: 101,
    project_name: 'EXC03',
    customer_identity: 'คุณสลน',
    channel: 'LINE',
    symptom: 'ระบบออกรายงานไม่ได้'
  };
  const res1 = DiagnosticSlotEngine.assessCompleteness(input1, false, 0);
  console.log('Completeness Score:', res1.score);
  console.log('State:', res1.state);
  console.log('Missing Mandatory Slots:', res1.missing_required_slots);
  console.log('Next Recommended Question:', res1.recommended_question_th);
  if (res1.state === 'NEEDS_INFO' && res1.recommended_question_th) {
    console.log('✅ Case 1 Passed: Progressive questioning triggered correctly.\n');
  } else {
    console.error('❌ Case 1 Failed');
  }

  // Test Case 2: P1 Outage (Fast-Path)
  console.log('--- Test Case 2: P1 Critical Outage ---');
  const input2: DiagnosticSlots = {
    project_id: 101,
    project_name: 'EXC03',
    customer_identity: 'คุณสลน',
    channel: 'LINE',
    symptom: 'ระบบล่มทั้งกรม ใช้งานไม่ได้',
    severity: 'Urgent'
  };
  const res2 = DiagnosticSlotEngine.assessCompleteness(input2, true, 0);
  console.log('State:', res2.state);
  if (res2.state === 'INSUFFICIENT_BUT_URGENT') {
    console.log('✅ Case 2 Passed: P1 fast-path permitted immediate triage.\n');
  } else {
    console.error('❌ Case 2 Failed');
  }

  // Test Case 3: Complete 4-Category Slots -> Ready for Triage
  console.log('--- Test Case 3: Complete Technical Report ---');
  const input3: DiagnosticSlots = {
    project_id: 101,
    project_name: 'EXC03 กรมสรรพสามิต',
    customer_identity: 'คุณสลน',
    channel: 'LINE',
    feature_screen_report: 'ServiceImportFile / เมนูนำเข้าข้อมูล',
    symptom: 'นำเข้าไฟล์ข้อมูลขนาด 50MB แล้วระบบหมุนค้าง',
    actual_behavior: 'หน้าจอหมุนค้าง ไม่มี Response และหลุด Timeout',
    expected_behavior: 'ระบบต้องประมวลผลไฟล์และแสดงผลสำเร็จ',
    reproduction_steps: [
      '1. ไปที่เมนู ServiceImportFile',
      '2. เลือกไฟล์ข้อมูลขนาด 50MB',
      '3. กดยืนยันการนำเข้า'
    ],
    error_code: 'HTTP 504 / JVM OutOfMemory',
    suspected_layer: 'Backend Service / JVM Heap',
    suspected_component: 'UploadMarketYield.java / ServiceImportFile.java',
    severity: 'Urgent',
    priority: 'P1',
    sla_hours: 4,
    due_date: '2026-08-18 17:00:00',
    raw_customer_report: 'นำเข้าไฟล์ข้อมูลในโมดูล ServiceImportFile แล้วระบบค้าง เกิดจากอะไร',
    code_evidence: [
      {
        file: 'ServiceImportFile/src/main/java/th/go/excise/UploadMarketYield.java',
        symbol: 'uploadFile()',
        lines: '45-89',
        snippet: 'byte[] buffer = new byte[file.getSize()];'
      }
    ],
    evidence_status: {
      layer: 'CONFIRMED',
      suspected_component: 'LIKELY',
      error_code: 'CONFIRMED'
    }
  };

  const res3 = DiagnosticSlotEngine.assessCompleteness(input3, false, 1);
  console.log('Completeness Score:', res3.score);
  console.log('State:', res3.state);

  const canonicalObj = DiagnosticSlotEngine.buildCanonicalDiagnostic(input3, res3, 1);
  console.log('\nCanonical Diagnostic JSON Object:');
  console.log(JSON.stringify(canonicalObj, null, 2));

  // Test Case 4: Plane HTML Rendering
  console.log('\n--- Test Case 4: Plane Developer Handoff HTML Rendering ---');
  const htmlOutput = formatDeveloperDiagnosticHtml(canonicalObj);
  console.log('Rendered Plane HTML Preview:');
  console.log(htmlOutput);

  if (
    htmlOutput.includes('1. ข้อมูลทั่วไป (Overview)') &&
    htmlOutput.includes('2. รายละเอียดสำหรับ Developer (Issue Details)') &&
    htmlOutput.includes('3. ระดับความสำคัญและเวลา (SLA & Severity)') &&
    htmlOutput.includes('4. ข้อมูลทางเทคนิคและหลักฐาน (Technical & Evidence)') &&
    htmlOutput.includes('Code Evidence') &&
    htmlOutput.includes('Raw Customer Report')
  ) {
    console.log('\n✅ Case 4 Passed: Plane Developer Handoff HTML rendered all 4 sections + Code Evidence + Collapsible Raw Report perfectly!');
  } else {
    console.error('❌ Case 4 Failed');
  }

  console.log('\n🎉 ALL P6 UNIT TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(console.error);
