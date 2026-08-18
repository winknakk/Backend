/**
 * Diagnostic Slot Contract & Progressive Question Engine (P6.1 & P6.2)
 *
 * Implements deterministic slot completeness calculation, sufficiency states,
 * and next-question selection for the TicketX Technical Triage Agent.
 */

export type EvidenceConfidence = 'CONFIRMED' | 'LIKELY' | 'UNKNOWN' | 'NOT_FOUND_IN_KNOWLEDGE_BASE';

export type SufficiencyState = 'READY_FOR_TRIAGE' | 'INSUFFICIENT_BUT_URGENT' | 'NEEDS_INFO';

export interface DiagnosticSlots {
  // Category 1: Overview (System-known slots - NEVER ASK)
  project_id?: string | number;
  project_name?: string;
  customer_identity?: string;
  channel?: string;
  impact_scope?: string;

  // Category 2: Issue Details
  feature_screen_report?: string; // Required
  symptom?: string;              // Required
  actual_behavior?: string;       // Required
  reproduction_steps?: string[];  // Min 1 step required
  expected_behavior?: string;     // Optional

  // Category 3: SLA & Priority
  severity?: string;
  priority?: string;
  sla_hours?: number;
  due_date?: string;

  // Category 4: Technical & Evidence
  suspected_layer?: string;
  suspected_component?: string;
  error_code?: string;
  attachment_urls?: string[];
  raw_customer_report?: string;
  code_evidence?: Array<{
    file: string;
    symbol?: string;
    lines?: string;
    snippet?: string;
  }>;
  evidence_status?: Record<string, EvidenceConfidence>;
}

export interface CompletenessResult {
  score: number; // 0.0 to 1.0
  filled_slots: string[];
  missing_required_slots: string[];
  missing_optional_slots: string[];
  state: SufficiencyState;
  next_question_target?: string;
  recommended_question_th?: string;
}

export interface CanonicalDiagnosticObject {
  overview: {
    ticket_id?: string;
    project_id?: string | number;
    project_name?: string;
    channel?: string;
    notifier?: string;
    impact_scope?: string;
  };
  issue_details: {
    feature_screen_report?: string;
    symptom?: string;
    actual_behavior?: string;
    expected_behavior?: string;
    reproduction_steps?: string[];
  };
  sla: {
    severity?: string;
    priority?: string;
    sla_hours?: number;
    due_date?: string;
  };
  technical_evidence: {
    layer?: string;
    suspected_component?: string;
    error_code?: string;
    attachment_urls?: string[];
    raw_customer_report?: string;
    code_evidence?: Array<{
      file: string;
      symbol?: string;
      lines?: string;
      snippet?: string;
    }>;
    evidence_status: Record<string, EvidenceConfidence>;
  };
  completeness: {
    score: number;
    status: SufficiencyState;
    question_turns_used?: number;
  };
}

export class DiagnosticSlotEngine {
  /**
   * Required slots for standard Technical Triage
   */
  private static readonly MANDATORY_SLOTS = [
    'feature_screen_report',
    'symptom',
    'actual_behavior'
  ];

  /**
   * System-known slots that must NEVER be asked to the customer
   */
  public static readonly SYSTEM_KNOWN_SLOTS = new Set([
    'project_id',
    'project_name',
    'customer_identity',
    'channel',
    'conversation_id',
    'ticket_history'
  ]);

  /**
   * Assess the completeness of the collected diagnostic slots
   */
  public static assessCompleteness(
    slots: DiagnosticSlots,
    isUrgentOutage: boolean = false,
    questionTurnsUsed: number = 0
  ): CompletenessResult {
    const filled: string[] = [];
    const missingRequired: string[] = [];
    const missingOptional: string[] = [];

    // Check mandatory slots
    for (const slotKey of this.MANDATORY_SLOTS) {
      const val = (slots as Record<string, any>)[slotKey];
      if (val && String(val).trim().length > 0) {
        filled.push(slotKey);
      } else {
        missingRequired.push(slotKey);
      }
    }

    // Check reproduction step
    if (slots.reproduction_steps && slots.reproduction_steps.length > 0) {
      filled.push('reproduction_steps');
    } else {
      missingOptional.push('reproduction_steps');
    }

    // Check error code / attachment / expected behavior
    if (slots.error_code && String(slots.error_code).trim().length > 0) filled.push('error_code');
    if (slots.expected_behavior && String(slots.expected_behavior).trim().length > 0) filled.push('expected_behavior');
    if (slots.attachment_urls && slots.attachment_urls.length > 0) filled.push('attachment_urls');

    // Calculate score (out of 6 core operational slots)
    const totalEvaluationSlots = 6;
    const score = Number((filled.length / totalEvaluationSlots).toFixed(2));

    // Determine state
    let state: SufficiencyState = 'NEEDS_INFO';

    if (isUrgentOutage || (slots.severity && slots.severity.toLowerCase() === 'urgent')) {
      state = score >= 0.6 ? 'READY_FOR_TRIAGE' : 'INSUFFICIENT_BUT_URGENT';
    } else if (missingRequired.length === 0 && (score >= 0.6 || questionTurnsUsed >= 3)) {
      state = 'READY_FOR_TRIAGE';
    }

    // Determine next single question if info is still needed
    let nextTarget: string | undefined;
    let nextQuestionTh: string | undefined;

    if (state === 'NEEDS_INFO' && missingRequired.length > 0) {
      nextTarget = missingRequired[0];
      switch (nextTarget) {
        case 'feature_screen_report':
          nextQuestionTh = 'ขอทราบชื่อหน้าจอ เมนู หรือชื่อรายงานที่กดแล้วพบปัญหาหน่อยนะคะ';
          break;
        case 'symptom':
        case 'actual_behavior':
          nextQuestionTh = 'ตอนที่กดใช้งาน ระบบแสดงอาการอย่างไร หรือมีข้อความ Error อะไรปรากฏขึ้นไหมคะ?';
          break;
        default:
          nextQuestionTh = 'รบกวนขอทราบขั้นตอนที่กดก่อนเกิดปัญหาเพิ่มเติมอีกสักนิดนะคะ';
      }
    }

    return {
      score,
      filled_slots: filled,
      missing_required_slots: missingRequired,
      missing_optional_slots: missingOptional,
      state,
      next_question_target: nextTarget,
      recommended_question_th: nextQuestionTh
    };
  }

  /**
   * Build the canonical structured diagnostic object ready for DB and Plane
   */
  public static buildCanonicalDiagnostic(
    slots: DiagnosticSlots,
    completeness: CompletenessResult,
    questionTurnsUsed: number = 0
  ): CanonicalDiagnosticObject {
    return {
      overview: {
        ticket_id: (slots as any).ticket_id || undefined,
        project_id: slots.project_id || undefined,
        project_name: slots.project_name || 'EXC03',
        channel: slots.channel || 'LINE',
        notifier: slots.customer_identity || 'Customer',
        impact_scope: slots.impact_scope || 'ยังไม่ได้ระบุ'
      },
      issue_details: {
        feature_screen_report: slots.feature_screen_report || 'ยังไม่ได้ระบุ',
        symptom: slots.symptom || 'ยังไม่ได้ระบุ',
        actual_behavior: slots.actual_behavior || slots.symptom || 'ยังไม่ได้ระบุ',
        expected_behavior: slots.expected_behavior || 'ระบบต้องทำงานได้ถูกต้องตามปกติ',
        reproduction_steps: slots.reproduction_steps && slots.reproduction_steps.length > 0
          ? slots.reproduction_steps
          : ['1. เข้าสู่ระบบและใช้งานเมนูที่เกี่ยวข้อง']
      },
      sla: {
        severity: slots.severity || 'Medium',
        priority: slots.priority || 'P3',
        sla_hours: slots.sla_hours || 72,
        due_date: slots.due_date || undefined
      },
      technical_evidence: {
        layer: slots.suspected_layer || 'Application Layer',
        suspected_component: slots.suspected_component || 'UNKNOWN',
        error_code: slots.error_code || 'ไม่มี Error Code ระบุ',
        attachment_urls: slots.attachment_urls || [],
        raw_customer_report: slots.raw_customer_report || '',
        code_evidence: slots.code_evidence || [],
        evidence_status: slots.evidence_status || {
          layer: slots.suspected_layer ? 'CONFIRMED' : 'UNKNOWN',
          suspected_component: slots.suspected_component ? 'LIKELY' : 'UNKNOWN',
          error_code: slots.error_code ? 'CONFIRMED' : 'UNKNOWN'
        }
      },
      completeness: {
        score: completeness.score,
        status: completeness.state,
        question_turns_used: questionTurnsUsed
      }
    };
  }
}
