/**
 * RequestContext defines the shape of execution-scoped thread metadata.
 */
export interface RequestContext {
  /** The unique correlation ID for tracking request flows across bounded contexts */
  readonly correlationId?: string;
  /** The unique request ID representing a single HTTP request lifecycle */
  readonly requestId?: string;
  /** The identifier for the current scoped project */
  readonly projectId?: string;
  /** The tenant identifier boundary */
  readonly tenantId?: string;
  /** The channel type of the current input gateway (e.g., 'line', 'whatsapp') */
  readonly clientChannel?: string;
  /** The raw unique reference ID on the source channel */
  readonly channelRef?: string;
}
