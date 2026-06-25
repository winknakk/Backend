export class MetricsService {
  private static instance: MetricsService;

  private requestCount = 0;
  private errorCount = 0;
  private latencies: number[] = [];
  private agentCalls = new Map<string, number>();
  private toolCalls = new Map<string, number>();
  private routingDecisions = new Map<string, number>();

  static getInstance(): MetricsService {
    if (!MetricsService.instance) {
      MetricsService.instance = new MetricsService();
    }
    return MetricsService.instance;
  }

  recordRequest(): void {
    this.requestCount++;
  }

  recordError(): void {
    this.errorCount++;
  }

  recordLatency(ms: number): void {
    this.latencies.push(ms);
  }

  recordAgentCall(agentName: string): void {
    this.agentCalls.set(agentName, (this.agentCalls.get(agentName) || 0) + 1);
  }

  recordToolCall(toolName: string): void {
    this.toolCalls.set(toolName, (this.toolCalls.get(toolName) || 0) + 1);
  }

  recordRoutingDecision(decision: string): void {
    this.routingDecisions.set(decision, (this.routingDecisions.get(decision) || 0) + 1);
  }

  getMetrics(): any {
    const count = this.latencies.length;
    const sum = this.latencies.reduce((acc, val) => acc + val, 0);
    const min = count > 0 ? Math.min(...this.latencies) : 0;
    const max = count > 0 ? Math.max(...this.latencies) : 0;
    const average = count > 0 ? sum / count : 0;

    return {
      requestCount: this.requestCount,
      errors: this.errorCount,
      latency: {
        average,
        min,
        max,
        sum,
        count,
      },
      agentCalls: Object.fromEntries(this.agentCalls),
      toolCalls: Object.fromEntries(this.toolCalls),
      routingDecisions: Object.fromEntries(this.routingDecisions),
    };
  }
}
