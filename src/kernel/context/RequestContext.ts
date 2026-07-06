/**
 * RequestContext holds the execution scoping details for the thread context.
 * Implements core tracing, scoping, and future tenancy boundaries.
 */
export interface RequestContext {
  /** Trace correlation identifier */
  correlationId: string;
  
  /** Current Project scope */
  projectId: string;
  
  /** Messaging Gateway channel (e.g. 'line', 'whatsapp') */
  clientChannel: string;
  
  /** Raw channel references (e.g. user account ID) */
  channelRef: string;
  
  /** Active Conversation ID in PostgreSQL (optional during setup) */
  conversationId?: string;
  
  /** Active Identity ID in PostgreSQL (optional during setup) */
  identityId?: string;
  
  /** Future tenant boundary */
  tenantId?: string;
}
