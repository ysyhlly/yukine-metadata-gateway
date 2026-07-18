import type { TelemetrySink, UpstreamAttempt } from "./types.js";

export interface WorkerAnalyticsEngine {
  writeDataPoint(event: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export class WorkerTelemetrySink implements TelemetrySink {
  constructor(private readonly dataset: WorkerAnalyticsEngine) {}

  recordProviderAttempt(attempt: UpstreamAttempt): void {
    this.dataset.writeDataPoint({
      indexes: ["provider"],
      blobs: [
        attempt.provider || "unknown",
        attempt.host,
        attempt.outcome || "unknown",
        attempt.cacheState || "miss",
        attempt.cacheLayer || "none",
        statusClass(attempt.status)
      ],
      doubles: [1, attempt.durationMs || 0]
    });
  }

  recordGatewayRequest(input: Parameters<TelemetrySink["recordGatewayRequest"]>[0]): void {
    this.dataset.writeDataPoint({
      indexes: ["gateway"],
      blobs: [input.route, statusClass(input.status), input.cache],
      doubles: [1, input.durationMs]
    });
  }

  recordIdentityDecision(
    input: Parameters<TelemetrySink["recordIdentityDecision"]>[0]
  ): void {
    this.dataset.writeDataPoint({
      indexes: ["identity"],
      blobs: [input.entity, input.decision],
      doubles: [1, input.confidence]
    });
  }
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}
