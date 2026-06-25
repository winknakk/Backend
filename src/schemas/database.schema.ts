import { z } from "zod";

export const DbCompanySchema = z.object({
  id1: z.string().nullish(),
  name: z.string().nullish(),
  company: z.string().nullish(),
  Profiles: z.string().nullish(),
});
export type DbCompany = z.infer<typeof DbCompanySchema>;

export const DbIdentitySchema = z.object({
  id1: z.string().nullish(),
  profile_id: z.string().nullish(),
  channel: z.string().nullish(),
  channel_ref: z.string().nullish(),
  profile: z.string().nullish(),
  Conversations: z.string().nullish(),
});
export type DbIdentity = z.infer<typeof DbIdentitySchema>;

export const DbProfileSchema = z.object({
  id1: z.string().nullish(),
  company_id: z.string().nullish(),
  name: z.string().nullish(),
  company: z.string().nullish(),
  projects: z.string().nullish(),
  Identities: z.string().nullish(),
  Profile_Projects: z.string().nullish(),
});
export type DbProfile = z.infer<typeof DbProfileSchema>;

export const DbProjectSchema = z.object({
  id1: z.string().nullish(),
  company_id: z.string().nullish(),
  name: z.string().nullish(),
  Companies: z.string().nullish(),
  Companies1: z.string().nullish(),
  Profiles: z.string().nullish(),
  Conversations: z.string().nullish(),
  Profile_Projects: z.string().nullish(),
});
export type DbProject = z.infer<typeof DbProjectSchema>;

export const DbConversationSchema = z.object({
  id1: z.string().nullish(),
  identity_id: z.string().nullish(),
  project_id: z.string().nullish(),
  channel: z.string().nullish(),
  status: z.string().nullish(),
  handled_by: z.string().nullish(),
  assigned_pm: z.string().nullish(),
  updated_at: z.string().nullish(),
  identity: z.string().nullish(),
  project: z.string().nullish(),
  Messages: z.string().nullish(),
  Tickets: z.string().nullish(),
});
export type DbConversation = z.infer<typeof DbConversationSchema>;

export const DbMessageSchema = z.object({
  id1: z.string().nullish(),
  conversation_id: z.string().nullish(),
  role: z.string().nullish(),
  content: z.string().nullish(),
  created_at: z.string().nullish(),
  conversation: z.string().nullish(),
});
export type DbMessage = z.infer<typeof DbMessageSchema>;

export const DbTicketSchema = z.object({
  id1: z.string().nullish(),
  conversation_id: z.string().nullish(),
  subject: z.string().nullish(),
  summary: z.string().nullish(),
  status: z.string().nullish(),
  priority: z.string().nullish(),
  assigned_pm: z.string().nullish(),
  created_via: z.string().nullish(),
  plane_issue_id: z.string().nullish(),
  conversation: z.string().nullish(),
  severity: z.string().nullish(),
  due_date: z.string().nullish(),
});
export type DbTicket = z.infer<typeof DbTicketSchema>;
