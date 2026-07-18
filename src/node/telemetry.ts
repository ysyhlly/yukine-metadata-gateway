import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import type {
  TelemetrySink,
  UpstreamAttempt
} from "../types.js";

export interface NodeTelemetryRuntime {
  sink?: TelemetrySink;
  run<T>(
    input: { route: string; traceparent?: string; tracestate?: string },
    operation: () => Promise<T>
  ): Promise<T>;
  shutdown(): Promise<void>;
}

export function startNodeTelemetry(
  endpoint: string | undefined,
  serviceName: string
): NodeTelemetryRuntime {
  if (!endpoint) {
    return {
      sink: undefined,
      run: (_input, operation) => operation(),
      shutdown: async () => {}
    };
  }
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: exporterUrl(endpoint, "traces") }),
    metricReaders: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: exporterUrl(endpoint, "metrics") }),
      exportIntervalMillis: 10_000
    })]
  });
  sdk.start();
  const sink = new OpenTelemetrySink();
  return {
    sink,
    run: (input, operation) => sink.run(input, operation),
    shutdown: () => sdk.shutdown()
  };
}

class OpenTelemetrySink implements TelemetrySink {
  private readonly tracer = trace.getTracer("yukine-metadata-gateway");
  private readonly meter = metrics.getMeter("yukine-metadata-gateway");
  private readonly gatewayRequests = this.meter.createCounter("gateway_requests_total");
  private readonly gatewayLatency = this.meter.createHistogram(
    "gateway_request_duration_ms",
    { unit: "ms" }
  );
  private readonly providerRequests = this.meter.createCounter("provider_requests_total");
  private readonly providerLatency = this.meter.createHistogram(
    "provider_request_duration_ms",
    { unit: "ms" }
  );
  private readonly cacheRequests = this.meter.createCounter("cache_requests_total");
  private readonly identityMerges = this.meter.createCounter("identity_merge_total");
  private readonly identityConfidence = this.meter.createHistogram("identity_confidence");

  run<T>(
    input: { route: string; traceparent?: string; tracestate?: string },
    operation: () => Promise<T>
  ): Promise<T> {
    const carrier: Record<string, string> = {};
    if (input.traceparent) carrier.traceparent = input.traceparent;
    if (input.tracestate) carrier.tracestate = input.tracestate;
    const parent = propagation.extract(ROOT_CONTEXT, carrier);
    return context.with(parent, () => this.tracer.startActiveSpan(
      "metadata.gateway",
      { attributes: { "http.route": input.route } },
      async (span) => {
        try {
          return await operation();
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      }
    ));
  }

  recordProviderAttempt(attempt: UpstreamAttempt): void {
    const attributes: Attributes = {
      "provider.name": attempt.provider || "unknown",
      "server.address": attempt.host,
      "gateway.outcome": attempt.outcome || statusOutcome(attempt.status),
      "cache.state": attempt.cacheState || "miss",
      "cache.layer": attempt.cacheLayer || "none",
      "http.response.status_code": attempt.status
    };
    this.providerRequests.add(1, attributes);
    this.providerLatency.record(attempt.durationMs || 0, attributes);
    this.cacheRequests.add(1, {
      "cache.state": attempt.cacheState || "miss",
      "cache.layer": attempt.cacheLayer || "none",
      "provider.name": attempt.provider || "unknown"
    });
    const endedAt = Date.now();
    const span = this.tracer.startSpan("metadata.provider", {
      startTime: endedAt - (attempt.durationMs || 0),
      attributes
    });
    if (attempt.outcome && !["success", "not_found"].includes(attempt.outcome)) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end(endedAt);
  }

  recordGatewayRequest(input: Parameters<TelemetrySink["recordGatewayRequest"]>[0]): void {
    const attributes: Attributes = {
      "http.route": input.route,
      "http.response.status_code": input.status,
      "gateway.runtime": input.runtime,
      "gateway.cache": input.cache,
      "gateway.status_class": `${Math.floor(input.status / 100)}xx`
    };
    this.gatewayRequests.add(1, attributes);
    this.gatewayLatency.record(input.durationMs, attributes);
  }

  recordIdentityDecision(
    input: Parameters<TelemetrySink["recordIdentityDecision"]>[0]
  ): void {
    const attributes = {
      "identity.entity": input.entity,
      "identity.decision": input.decision
    };
    this.identityMerges.add(1, attributes);
    this.identityConfidence.record(input.confidence, attributes);
  }
}

function exporterUrl(endpoint: string, signal: "traces" | "metrics"): string {
  const normalized = endpoint.replace(/\/+$/u, "");
  return normalized.endsWith(`/v1/${signal}`)
    ? normalized
    : `${normalized}/v1/${signal}`;
}

function statusOutcome(status: number): string {
  if (status === 404) return "not_found";
  if (status >= 200 && status < 400) return "success";
  return "failure";
}
