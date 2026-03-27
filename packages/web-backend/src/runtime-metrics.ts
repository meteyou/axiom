export class RuntimeMetrics {
  private activeRequests = 0

  startRequest(): void {
    this.activeRequests++
  }

  endRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1)
  }

  getQueueDepth(): number {
    return this.activeRequests
  }
}
