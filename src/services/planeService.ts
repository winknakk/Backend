import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { randomUUID } from "crypto";
import { DatabaseAdapter } from "../adapters/types";
import { pool } from "../adapters/postgres/PostgresAdapter";
import { config } from "../config/env";
import { mapTicketPriorityToPlanePriority } from "./planeWebhookService";
import { parseSummaryHistory } from "../shared/summaryHistory";

export interface PlaneStateSummary {
  id?: string;
  name?: string;
  group?: string;
}

export interface PlaneTicketClosureResult {
  synced: boolean;
  reason?: "not_linked";
  planeIssueId?: string;
  stateId?: string;
  stateName?: string;
  stateGroup?: string;
}

export interface PlaneTicketSummaryResult {
  synced: boolean;
  reason?: "not_linked";
  planeIssueId?: string;
}

export interface PlaneTicketReopenResult {
  synced: boolean;
  reason?: "not_linked";
  planeIssueId?: string;
  stateId?: string;
  stateName?: string;
  stateGroup?: string;
}

export type PlaneTicketMergeResult = PlaneTicketReopenResult;

export interface PlaneWorkItemPayload {
  name: string;
  description_html: string;
  priority: string;
  external_source: "TicketX";
  external_id: string;
  target_date?: string;
}

function escapePlaneHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePlaneTargetDate(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  const datePrefix = raw.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (datePrefix) return datePrefix;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

import { sanitizeSensitiveData } from "../domain/diagnostic/DeveloperDiagnostic";

export function formatDeveloperDiagnosticHtml(diag: any): string {
  if (!diag) return "";

  const getFieldValue = (
    field: any,
    defaultVal = "UNKNOWN"
  ): { value: string; source: string; confidence: number; isHypothesis: boolean } => {
    if (!field) return { value: defaultVal, source: "UNKNOWN", confidence: 0, isHypothesis: true };
    if (typeof field === "string") {
      return { value: field, source: "AI_INFERENCE", confidence: 50, isHypothesis: true };
    }
    return {
      value: field.value || defaultVal,
      source: field.source || "AI_INFERENCE",
      confidence: typeof field.confidence === "number" ? field.confidence : 0,
      isHypothesis: field.isHypothesis !== false,
    };
  };

  const projectField = getFieldValue(diag.project);
  const moduleField = getFieldValue(diag.module);
  const featureField = getFieldValue(diag.feature);
  const layerField = getFieldValue(diag.suspected_layer);
  const componentField = getFieldValue(diag.suspected_component);
  const apiField = getFieldValue(diag.suspected_api, "NOT_FOUND_IN_KNOWLEDGE_BASE");
  const dbField = getFieldValue(diag.suspected_database_object, "NOT_FOUND_IN_KNOWLEDGE_BASE");
  const rootCauseField = getFieldValue(diag.root_cause_hypothesis);

  const customerReport = sanitizeSensitiveData(diag.customer_report || "");
  const expectedBehavior = sanitizeSensitiveData(
    diag.expected_behavior || "System should function normally without errors"
  );
  const actualBehavior = sanitizeSensitiveData(diag.actual_behavior || customerReport);
  const overallConfidence =
    typeof diag.confidence === "number" ? diag.confidence : rootCauseField.confidence;
  const nextAction = sanitizeSensitiveData(
    diag.recommended_next_action || "Review customer logs and reproduce in staging environment"
  );

  const evidenceList: any[] = Array.isArray(diag.customer_evidence) ? diag.customer_evidence : [];
  const evidenceHtml =
    evidenceList.length > 0
      ? `<h3>🔎 Customer Evidence</h3><ul>` +
        evidenceList
          .map((e) => {
            const type = escapePlaneHtml(e.type || "Evidence");
            const val = escapePlaneHtml(sanitizeSensitiveData(e.value || ""));
            const src = escapePlaneHtml(e.source || "CUSTOMER_REPORTED");
            return `<li><strong>[${src}] ${type}:</strong> <code>${val}</code></li>`;
          })
          .join("") +
        `</ul>`
      : "";

  const reproSteps: string[] = Array.isArray(diag.reproduction_steps) ? diag.reproduction_steps : [];
  const reproHtml =
    reproSteps.length > 0
      ? `<h3>🧪 Steps to Reproduce</h3><ol>` +
        reproSteps
          .map((step) => `<li>${escapePlaneHtml(sanitizeSensitiveData(step))}</li>`)
          .join("") +
        `</ol>`
      : "";

  const kbSources: any[] = Array.isArray(diag.knowledge_sources) ? diag.knowledge_sources : [];
  const kbHtml =
    kbSources.length > 0
      ? `<h3>📚 Evidence Sources (Knowledge Base)</h3><ul>` +
        kbSources
          .map((kb) => {
            const title = escapePlaneHtml(kb.title || "Project Documentation");
            const score =
              typeof kb.score === "number" ? ` (Score: ${(kb.score * 100).toFixed(0)}%)` : "";
            const snippet = kb.snippet
              ? `<br><em>${escapePlaneHtml(sanitizeSensitiveData(kb.snippet))}</em>`
              : "";
            return `<li><strong>${title}</strong>${score}${snippet}</li>`;
          })
          .join("") +
        `</ul>`
      : "";

  const unknownsList: string[] = Array.isArray(diag.unknowns) ? diag.unknowns : [];
  const unknownsHtml =
    unknownsList.length > 0
      ? `<h3>❓ Unknown Information</h3><ul>` +
        unknownsList
          .map((u) => `<li>${escapePlaneHtml(sanitizeSensitiveData(u))}</li>`)
          .join("") +
        `</ul>`
      : "";

  return [
    `<h3>🎯 Customer Report</h3><p>${escapePlaneHtml(customerReport).replace(/\r?\n/g, "<br>")}</p>`,
    evidenceHtml,
    reproHtml,
    `<h3>🔍 Expected vs Actual</h3><ul>`,
    `<li><strong>Expected:</strong> ${escapePlaneHtml(expectedBehavior)}</li>`,
    `<li><strong>Actual:</strong> ${escapePlaneHtml(actualBehavior)}</li>`,
    `</ul>`,
    `<h3>🛠️ Developer Diagnostics</h3><ul>`,
    `<li><strong>Project:</strong> ${escapePlaneHtml(projectField.value)} <em>[${escapePlaneHtml(projectField.source)}]</em></li>`,
    `<li><strong>Module:</strong> ${escapePlaneHtml(moduleField.value)} <em>[${escapePlaneHtml(moduleField.source)}]</em></li>`,
    `<li><strong>Feature:</strong> ${escapePlaneHtml(featureField.value)} <em>[${escapePlaneHtml(featureField.source)}]</em></li>`,
    `<li><strong>Suspected Layer:</strong> ${escapePlaneHtml(layerField.value)} <em>[${escapePlaneHtml(layerField.source)}]</em></li>`,
    `<li><strong>Suspected Component:</strong> ${escapePlaneHtml(componentField.value)} <em>[${escapePlaneHtml(componentField.source)}]</em></li>`,
    `<li><strong>Suspected API:</strong> <code>${escapePlaneHtml(apiField.value)}</code> <em>[${escapePlaneHtml(apiField.source)}]</em></li>`,
    `<li><strong>Suspected Database Object:</strong> <code>${escapePlaneHtml(dbField.value)}</code> <em>[${escapePlaneHtml(dbField.source)}]</em></li>`,
    `<li><strong>Root Cause Hypothesis:</strong> ${escapePlaneHtml(rootCauseField.value)} <strong style="color:#d97706;">[AI HYPOTHESIS - Confidence: ${overallConfidence}%]</strong></li>`,
    `</ul>`,
    kbHtml,
    unknownsHtml,
    `<h3>🚀 Recommended Next Investigation</h3><p>${escapePlaneHtml(nextAction)}</p>`,
  ].join("");
}

export function buildPlaneWorkItemPayload(
  ticket: Record<string, any>,
  companyName = "Unknown"
): PlaneWorkItemPayload {
  const ticketNumber = String(
    ticket.ticket_number || ticket.ticket_id || ticket.id1 || ticket.id || "UNKNOWN"
  ).trim();
  const subject = String(ticket.subject || ticket.title || "No Subject").trim();
  const visibleTitle = subject.includes(ticketNumber) ? subject : `[${ticketNumber}] ${subject}`;
  const source = String(ticket.channel || ticket.created_via || "TicketX").trim();
  const conversationId = String(ticket.conversation_id || "").trim();
  const severity = String(ticket.severity || "").trim();
  const priority = mapTicketPriorityToPlanePriority(ticket.priority) || "none";
  const dueDate = normalizePlaneTargetDate(ticket.due_date || ticket.dueDate);
  const summary = String(ticket.summary || "No Summary").trim();
  const runningSummary = String(ticket.running_summary || ticket.runningSummary || "").trim();
  const lastAiSummary = String(ticket.last_ai_summary || ticket.lastAiSummary || "").trim();
  const httpStatus = `${subject} ${summary}`.match(/\b[1-5]\d{2}\b/)?.[0];

  const rawCreatorType = String(
    ticket.created_by_type || ticket.createdByType || (ticket as any).createdBy || "CUSTOMER"
  ).toUpperCase();
  const creatorName = String(ticket.created_by_name || ticket.createdByName || "").trim();

  let creatorLabel = "👤 Customer";
  if (rawCreatorType.includes("AI")) {
    creatorLabel = `🤖 AI Bot${creatorName ? ` (${creatorName})` : ""}`;
  } else if (rawCreatorType.includes("HUMAN") || rawCreatorType.includes("AGENT")) {
    creatorLabel = `🎧 Human Agent${creatorName ? ` (${creatorName})` : ""}`;
  } else if (rawCreatorType.includes("PLANE")) {
    creatorLabel = `✈️ Plane.io User${creatorName ? ` (${creatorName})` : ""}`;
  } else if (creatorName) {
    creatorLabel = `👤 Customer (${creatorName})`;
  }

  const metadata = [
    ["TicketX ID", ticketNumber],
    ["Conversation", conversationId ? `#${conversationId}` : ""],
    ["Source", source],
    ["Creator", creatorLabel],
    ["Customer / Company", companyName === "Unknown" ? "" : companyName],
    ["Severity", severity],
    ["Priority", String(ticket.priority || priority)],
    ["HTTP status", httpStatus || ""],
    ["SLA target", dueDate || ""],
  ].filter(([, value]) => value);

  const metadataHtml = metadata
    .map(
      ([label, value]) =>
        `<li><strong>${escapePlaneHtml(label)}:</strong> ${escapePlaneHtml(value)}</li>`
    )
    .join("");

  const runningSummaryItems = parseSummaryHistory(runningSummary);
  const runningSummaryHtml = runningSummaryItems
    .map((item) => `<li>${escapePlaneHtml(item)}</li>`)
    .join("");

  // Check if ticket carries structured diagnostic
  let diagnosticData = ticket.diagnostic;
  if (!diagnosticData && typeof summary === "string" && summary.startsWith("{") && summary.includes('"customer_report"')) {
    try {
      diagnosticData = JSON.parse(summary);
    } catch {
      // Not JSON, fallback to plain summary
    }
  }

  let mainReportContent = `<h3>Customer report</h3><p>${escapePlaneHtml(sanitizeSensitiveData(summary)).replace(/\r?\n/g, "<br>")}</p>`;
  if (diagnosticData) {
    try {
      mainReportContent = formatDeveloperDiagnosticHtml(diagnosticData);
    } catch (err: any) {
      console.warn("[PlaneService] Failed to format diagnostic HTML, falling back to summary:", err.message);
    }
  }

  const summarySections = [
    mainReportContent,
    runningSummary
      ? `<h3>Customer update history</h3><ul>${runningSummaryHtml}</ul>`
      : "",
    lastAiSummary
      ? `<h3>Latest customer update</h3><p>${escapePlaneHtml(sanitizeSensitiveData(lastAiSummary)).replace(/\r?\n/g, "<br>")}</p>`
      : "",
  ].join("");

  return {
    name: visibleTitle,
    description_html:
      `<h3>TicketX support incident</h3>` +
      `<ul>${metadataHtml}</ul>` +
      summarySections,
    priority,
    external_source: "TicketX",
    external_id: ticketNumber,
    ...(dueDate ? { target_date: dueDate } : {}),
  };
}

export function selectPlaneTerminalState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const byGroup = (group: string) =>
    states.filter((state) => state.group?.trim().toLowerCase() === group && state.id);
  const completed = byGroup("completed");
  const cancelled = byGroup("cancelled");

  const pickPreferred = (candidates: PlaneStateSummary[], names: string[]) => {
    for (const name of names) {
      const match = candidates.find((state) => state.name?.trim().toLowerCase() === name);
      if (match) return match;
    }
    return candidates[0];
  };

  return (
    pickPreferred(completed, ["done", "completed", "closed", "resolved"]) ||
    pickPreferred(cancelled, ["cancelled", "canceled"])
  );
}

export function selectPlaneBacklogState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const candidates = states.filter((state) => state.id);
  return (
    candidates.find((state) => state.name?.trim().toLowerCase() === "backlog") ||
    candidates.find((state) => state.group?.trim().toLowerCase() === "backlog") ||
    candidates.find((state) => state.group?.trim().toLowerCase() === "unstarted")
  );
}

export function selectPlaneCancelledState(states: PlaneStateSummary[]): PlaneStateSummary | undefined {
  const candidates = states.filter((state) => state.id);
  return (
    candidates.find((state) => ["cancelled", "canceled"].includes(state.name?.trim().toLowerCase() || "")) ||
    candidates.find((state) => state.group?.trim().toLowerCase() === "cancelled")
  );
}

export function findMatchingPlaneWorkItem(
  subject: string,
  workItems: Array<{ id?: string; name?: string }>
): { id?: string; name?: string } | undefined {
  const normalizedSubject = subject.trim().toLowerCase().replace(/\s+/g, " ");
  const exactMatches = workItems.filter(
    (workItem) =>
      workItem.id && String(workItem.name || "").trim().toLowerCase().replace(/\s+/g, " ") === normalizedSubject
  );
  if (exactMatches.length === 1) return exactMatches[0];

  // Ticket titles commonly include an HTTP status code while the Plane creation
  // flow may shorten surrounding Thai wording. A unique code is a safer repair
  // key than broad fuzzy matching.
  const httpCode = normalizedSubject.match(/\b[1-5]\d{2}\b/)?.[0];
  if (!httpCode) return undefined;
  const codeMatches = workItems.filter(
    (workItem) => workItem.id && String(workItem.name || "").match(/\b[1-5]\d{2}\b/)?.[0] === httpCode
  );
  return codeMatches.length === 1 ? codeMatches[0] : undefined;
}

export class PlaneService {
  private dbAdapter: DatabaseAdapter;
  private httpClient: typeof axios;

  constructor(dbAdapter: DatabaseAdapter, httpClient: typeof axios = axios) {
    this.dbAdapter = dbAdapter;
    this.httpClient = httpClient;
  }

  private getProjectBaseUrl(): string {
    return `${config.PLANE_API_URL}/api/v1/workspaces/${encodeURIComponent(config.PLANE_WORKSPACE_SLUG)}/projects/${encodeURIComponent(config.PLANE_PROJECT_ID)}`;
  }

  private getPlaneRequestConfig() {
    return {
      headers: { "X-API-Key": config.PLANE_API_KEY },
      timeout: 5000,
    };
  }

  private assertPlaneConfigured(): void {
    if (
      !config.PLANE_API_KEY ||
      config.PLANE_API_KEY === "plane_mock_key" ||
      !config.PLANE_PROJECT_ID ||
      config.PLANE_PROJECT_ID === "proj_id" ||
      !config.PLANE_WORKSPACE_SLUG ||
      config.PLANE_WORKSPACE_SLUG === "ws_id"
    ) {
      throw new Error("Plane API credentials are not configured");
    }
  }

  async resolvePlaneWorkItemId(ticketId: string, candidateId: string): Promise<string> {
    this.assertPlaneConfigured();
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const projectBaseUrl = this.getProjectBaseUrl();
    const requestConfig = this.getPlaneRequestConfig();
    try {
      await this.httpClient.get(
        `${projectBaseUrl}/work-items/${encodeURIComponent(String(candidateId))}/`,
        requestConfig
      );
      return String(candidateId);
    } catch (error: any) {
      const status = error?.response?.status;
      if (status !== 403 && status !== 404) throw error;
    }

    const listResponse = await this.httpClient.get(`${projectBaseUrl}/work-items/`, {
      ...requestConfig,
      params: { per_page: 100, fields: "id,name,sequence_id" },
    });
    const workItems = Array.isArray(listResponse.data)
      ? listResponse.data
      : Array.isArray(listResponse.data?.results)
        ? listResponse.data.results
        : [];
    const subject = String(ticket.subject || "").trim();
    const matchingWorkItem = findMatchingPlaneWorkItem(subject, workItems);
    if (!matchingWorkItem?.id) {
      throw new Error(
        `Cannot repair Plane link for ticket ${ticketId}: no unique matching work item was found`
      );
    }
    return String(matchingWorkItem.id);
  }

  async syncTicketClosureToPlane(ticketId: string): Promise<PlaneTicketClosureResult> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    this.assertPlaneConfigured();

    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));
    if (resolvedPlaneIssueId !== String(planeIssueId)) {
      await this.dbAdapter.updateTicketPlaneIssue(ticketId, resolvedPlaneIssueId);
    }

    const projectBaseUrl = this.getProjectBaseUrl();
    const requestConfig = this.getPlaneRequestConfig();
    const statesResponse = await this.httpClient.get(`${projectBaseUrl}/states/`, requestConfig);
    const states = Array.isArray(statesResponse.data)
      ? statesResponse.data
      : Array.isArray(statesResponse.data?.results)
        ? statesResponse.data.results
        : [];
    const terminalState = selectPlaneTerminalState(states);
    if (!terminalState?.id) {
      throw new Error("Cannot close linked Plane work item: project has no completed or cancelled state");
    }

    await this.httpClient.patch(
      `${projectBaseUrl}/work-items/${encodeURIComponent(resolvedPlaneIssueId)}/`,
      { state: terminalState.id },
      requestConfig
    );

    return {
      synced: true,
      planeIssueId: resolvedPlaneIssueId,
      stateId: terminalState.id,
      stateName: terminalState.name,
      stateGroup: terminalState.group,
    };
  }

  async syncTicketReopenToPlane(ticketId: string): Promise<PlaneTicketReopenResult> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    this.assertPlaneConfigured();
    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));
    if (resolvedPlaneIssueId !== String(planeIssueId)) {
      await this.dbAdapter.updateTicketPlaneIssue(ticketId, resolvedPlaneIssueId);
    }

    const projectBaseUrl = this.getProjectBaseUrl();
    const requestConfig = this.getPlaneRequestConfig();
    const statesResponse = await this.httpClient.get(`${projectBaseUrl}/states/`, requestConfig);
    const states = Array.isArray(statesResponse.data)
      ? statesResponse.data
      : Array.isArray(statesResponse.data?.results)
        ? statesResponse.data.results
        : [];
    const backlogState = selectPlaneBacklogState(states);
    if (!backlogState?.id) throw new Error("Cannot reopen linked Plane work item: project has no Backlog state");

    await this.httpClient.patch(
      `${projectBaseUrl}/work-items/${encodeURIComponent(resolvedPlaneIssueId)}/`,
      { state: backlogState.id },
      requestConfig
    );

    return {
      synced: true,
      planeIssueId: resolvedPlaneIssueId,
      stateId: backlogState.id,
      stateName: backlogState.name,
      stateGroup: backlogState.group,
    };
  }

  async syncMergedTicketToPlane(ticketId: string): Promise<PlaneTicketMergeResult> {
    const { ticket } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    this.assertPlaneConfigured();
    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));
    const projectBaseUrl = this.getProjectBaseUrl();
    const requestConfig = this.getPlaneRequestConfig();
    const statesResponse = await this.httpClient.get(`${projectBaseUrl}/states/`, requestConfig);
    const states = Array.isArray(statesResponse.data)
      ? statesResponse.data
      : Array.isArray(statesResponse.data?.results)
        ? statesResponse.data.results
        : [];
    const cancelledState = selectPlaneCancelledState(states);
    if (!cancelledState?.id) throw new Error("Cannot synchronize merged Plane work item: project has no Cancelled state");
    await this.httpClient.patch(
      `${projectBaseUrl}/work-items/${encodeURIComponent(resolvedPlaneIssueId)}/`,
      { state: cancelledState.id },
      requestConfig
    );
    return {
      synced: true,
      planeIssueId: resolvedPlaneIssueId,
      stateId: cancelledState.id,
      stateName: cancelledState.name,
      stateGroup: cancelledState.group,
    };
  }

  async syncTicketSummaryToPlane(ticketId: string): Promise<PlaneTicketSummaryResult> {
    const { ticket, companyName } = await this.dbAdapter.getTicketCompanyContext(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const planeIssueId = ticket.planeIssueId || ticket.plane_issue_id;
    if (!planeIssueId || String(planeIssueId).startsWith("mock-")) {
      return { synced: false, reason: "not_linked" };
    }

    this.assertPlaneConfigured();

    const resolvedPlaneIssueId = await this.resolvePlaneWorkItemId(ticketId, String(planeIssueId));
    if (resolvedPlaneIssueId !== String(planeIssueId)) {
      await this.dbAdapter.updateTicketPlaneIssue(ticketId, resolvedPlaneIssueId);
    }

    let ticketWithSource = ticket;
    if (ticket.conversation_id) {
      try {
        const identity = await this.dbAdapter.getConversationIdent(String(ticket.conversation_id));
        ticketWithSource = { ...ticket, channel: identity?.channel || ticket.channel };
      } catch {
        // Channel enrichment is optional for older tickets.
      }
    }

    const payload = buildPlaneWorkItemPayload(ticketWithSource, companyName);
    await this.httpClient.patch(
      `${this.getProjectBaseUrl()}/work-items/${encodeURIComponent(resolvedPlaneIssueId)}/`,
      payload,
      this.getPlaneRequestConfig()
    );

    return { synced: true, planeIssueId: resolvedPlaneIssueId };
  }

  private getFilePath(tableName: string): string {
    const candidates = [
      path.resolve(__dirname, "../../../data"),
      path.resolve(process.cwd(), "data"),
      path.resolve(process.cwd(), "ticket_codebase/data"),
    ];

    let dataDir = candidates[0];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const files = fs.readdirSync(cand);
        const hasData = files.some(
          (f) =>
            f.endsWith(".json") &&
            (f.includes("Tickets") || f.includes("Messages") || f.includes("Projects"))
        );
        if (hasData) {
          dataDir = cand;
          break;
        }
      }
    }

    const files = fs.readdirSync(dataDir);
    const match =
      files.find((f) => f.includes(`(${tableName})`) && f.endsWith(".json")) ||
      files.find((f) => f.includes(tableName) && f.endsWith(".json"));
    if (!match) {
      const defaultFilename = `Ticket V.2 - ${tableName} (${tableName}).json`;
      return path.join(dataDir, defaultFilename);
    }
    return path.join(dataDir, match);
  }

  private readTable<T>(tableName: string): T[] {
    const filePath = this.getFilePath(tableName);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T[];
  }

  private writeTable<T>(tableName: string, data: T[]): void {
    const filePath = this.getFilePath(tableName);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async promoteTicketToPlane(ticketId: string): Promise<any> {
    // 1. Fetch ticket and company details using adapter
    const { ticket, companyName } = await this.dbAdapter.getTicketCompanyContext(ticketId);

    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }

    let ticketWithSource = ticket;
    if (ticket.conversation_id) {
      try {
        const identity = await this.dbAdapter.getConversationIdent(String(ticket.conversation_id));
        ticketWithSource = {
          ...ticket,
          channel: identity?.channel || ticket.channel,
        };
      } catch {
        // Source enrichment is optional; Ticket creation must not fail when
        // an older record has no resolvable conversation identity.
      }
    }

    let planeIssueId = `mock-issue-${randomUUID()}`;
    let webhookTriggered = false;

    const useDirectPlaneApi =
      config.PLANE_API_KEY &&
      config.PLANE_API_KEY !== "plane_mock_key" &&
      config.PLANE_PROJECT_ID &&
      config.PLANE_PROJECT_ID !== "proj_id";

    if (useDirectPlaneApi) {
      try {
        console.log(`[PlaneService] Promoting ticket ${ticketId} directly to Plane API...`);
        const url = `${this.getProjectBaseUrl()}/work-items/`;
        const payload = buildPlaneWorkItemPayload(ticketWithSource, companyName);
        const res = await this.httpClient.post(
          url,
          payload,
          {
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": config.PLANE_API_KEY,
            },
            timeout: 8000,
          }
        );
        if (res.data && res.data.id) {
          planeIssueId = res.data.id;
          webhookTriggered = true;
          console.log(`[PlaneService] Direct Plane issue created successfully with ID: ${planeIssueId}`);
        }
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || err.message;
        console.error(`[PlaneService] Direct Plane API promotion failed:`, errorMsg);
      }
    }

    const webhookUrl = config.ACTIVEPIECES_WORKFLOW_PROVIDER === "postgres_v2"
      ? config.ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL_V2
      : config.ACTIVEPIECES_PROMOTE_TICKET_WEBHOOK_URL;

    if (!webhookTriggered && webhookUrl) {
      try {
        console.log(`[PlaneService] Triggering Activepieces Promote webhook at ${webhookUrl}...`);
        const tenantOrgId = (ticket as any)?.org_id || (ticket as any)?.orgId || "org_default";
        await this.httpClient.post(
          webhookUrl,
          {
            ticket_internal_id: Number(ticketId) || ticketId,
            org_id: tenantOrgId,
          },
          {
            headers: {
              "Content-Type": "application/json",
              "X-Org-Id": tenantOrgId,
            },
            timeout: 5000,
          }
        );
        console.log(`[PlaneService] Activepieces webhook called successfully.`);
        planeIssueId = "Promoted via Activepieces webhook";
        webhookTriggered = true;
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || err.message;
        console.error(`[PlaneService] Failed to trigger Activepieces promote webhook:`, errorMsg);
      }
    }

    // Update plane_issue_id and status in database directly
    await this.dbAdapter.updateTicketPlaneIssue(ticketId, planeIssueId);

    return {
      success: true,
      plane_issue_id: planeIssueId,
      ticket_id: ticket.ticket_id || ticket.id1,
      status: "In Progress",
    };
  }
}

