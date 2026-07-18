import { handleGatewayRequest } from "./core.js";
import { JsonFetchTransport } from "./transport.js";
import {
  WorkerTelemetrySink,
  type WorkerAnalyticsEngine
} from "./worker-telemetry.js";

interface Env {
  ACOUSTID_API_KEY?: string;
  APP_USER_AGENT?: string;
  V2_ENABLED?: string;
  V1_SUNSET_DATE?: string;
  TELEMETRY?: WorkerAnalyticsEngine;
}

const transport = new JsonFetchTransport({ cloudflareCache: true });

export default {
  async fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const telemetry = env.TELEMETRY
      ? new WorkerTelemetrySink(env.TELEMETRY)
      : undefined;
    const url = new URL(request.url);
    const result = await handleGatewayRequest(
      {
        method: request.method,
        url: request.url,
        requestId: crypto.randomUUID(),
        signal: request.signal,
        traceparent: request.headers.get("traceparent") || undefined,
        tracestate: request.headers.get("tracestate") || undefined
      },
      {
        env: {
          acoustidApiKey: env.ACOUSTID_API_KEY,
          appUserAgent: env.APP_USER_AGENT
            || "Yukine-Metadata-Gateway/1.0 (https://github.com/ysyhlly/yukine-metadata-gateway)",
          runtime: "worker",
          cache: "cloudflare",
          v2Enabled: env.V2_ENABLED?.trim().toLowerCase() !== "false",
          v1SunsetDate: workerSunsetDate(env.V1_SUNSET_DATE)
        },
        transport,
        defer: (task) => execution.waitUntil(task),
        ready: () => true,
        telemetry
      }
    );
    telemetry?.recordGatewayRequest({
      route: url.pathname,
      status: result.status,
      durationMs: Date.now() - startedAt,
      runtime: "worker",
      cache: "cloudflare",
      trace: result.trace
    });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: result.headers
    });
  }
};

function workerSunsetDate(value: string | undefined): string | undefined {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toUTCString() : undefined;
}
