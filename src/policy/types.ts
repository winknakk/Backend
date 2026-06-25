import { z } from "zod";
import { PolicyRule } from "../schemas/validation";

export const PolicyContextSchema = z.object({
  companyId: z.string(),
  sessionId: z.string(),
  userRole: z.string().default("customer"),
  ipAddress: z.string().optional(),
});
export type PolicyContext = z.infer<typeof PolicyContextSchema>;

export const PolicyAuthorizationResponseSchema = z.object({
  isAllowed: z.boolean(),
  reason: z.string().optional(),
  sanitizedParams: z.record(z.any()).optional(), // Mutated inputs (e.g., stripped PII)
});
export type PolicyAuthorizationResponse = z.infer<typeof PolicyAuthorizationResponseSchema>;

export interface IPolicyEngine {
  /**
   * Evaluates an incoming tool call against the security policies and input validations before execution.
   */
  authorizeToolCall(
    toolName: string,
    params: Record<string, any>,
    context: PolicyContext
  ): Promise<PolicyAuthorizationResponse>;

  /**
   * Sanitizes unstructured text to filter out malicious payloads, prompt injection, or sensitive PII.
   */
  sanitizeInputText(text: string): Promise<string>;

  /**
   * Sanitizes unstructured text from the LLM before sending it to the user.
   */
  sanitizeOutputText(text: string): Promise<string>;

  /**
   * Adds a new policy rule (validation, rate limit, or security guardrail) to the engine.
   */
  registerRule(rule: PolicyRule): void;
}
