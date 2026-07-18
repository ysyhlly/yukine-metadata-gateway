import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { handleGatewayRequest } from "../core.js";
import { JsonFetchTransport } from "../transport.js";
import type { GatewayResult } from "../types.js";
import { loadNodeGatewayConfig, type NodeGatewayConfig } from "./config.js";
import { Dashboard, type DashboardResponse } from "./dashboard.js";
import { SqliteJsonCache } from "./sqlite-cache.js";

export function startNodeGateway(config: NodeGatewayConfig = loadNodeGatewayConfig()) {
  const cache = new SqliteJsonCache({
    path: config.cacheDbPath,
    ttlSeconds: config.cacheTtlSeconds,
    maxEntries: config.cacheMaxEntries
  });
  const transport = new JsonFetchTransport({
    timeoutMs: config.upstreamTimeoutMs,
    cache
  });
  let dashboard: Dashboard | undefined;
  try {
    dashboard = config.dashboard
      ? new Dashboard(config.dashboard, () => cache.stats())
      : undefined;
  } catch (error) {
    cache.close();
    throw error;
  }
  const concurrency = new RequestConcurrencyLimiter(config.maxConcurrentRequests);
  const requestRate = new RequestRateLimiter(config.maxRequestsPerSecond);
  const server = createServer(
    {
      maxHeaderSize: 64 * 1024,
      requestTimeout: config.requestTimeoutMs
    },
    async (request, response) => {
      if (!requestRate.tryAcquire()) {
        serveRateLimited(request, response);
        return;
      }
      if (!concurrency.tryAcquire()) {
        serveBusy(request, response);
        return;
      }
      try {
        await serveRequest(request, response, config, transport, dashboard);
      } finally {
        concurrency.release();
      }
    }
  );
  server.headersTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.listen(config.port, config.host);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      dashboard?.close();
      cache.close();
      process.exitCode = 0;
    });
    setTimeout(() => {
      server.closeAllConnections();
    }, Math.min(5_000, config.requestTimeoutMs)).unref();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return { server, close, cache, dashboard, concurrency, requestRate };
}

export class RequestConcurrencyLimiter {
  private active = 0;

  constructor(readonly maximum: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.maximum) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  get activeRequests(): number {
    return this.active;
  }
}

export class RequestRateLimiter {
  private windowStartedAt = 0;
  private requests = 0;

  constructor(readonly maximumPerSecond: number) {}

  tryAcquire(now = Date.now()): boolean {
    const windowStartedAt = Math.floor(now / 1_000) * 1_000;
    if (windowStartedAt !== this.windowStartedAt) {
      this.windowStartedAt = windowStartedAt;
      this.requests = 0;
    }
    if (this.requests >= this.maximumPerSecond) return false;
    this.requests += 1;
    return true;
  }

  get requestsInCurrentWindow(): number {
    return this.requests;
  }
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: NodeGatewayConfig,
  transport: JsonFetchTransport,
  dashboard?: Dashboard
): Promise<void> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const origin = `http://${request.headers.host || `${config.host}:${config.port}`}`;
  const url = new URL(request.url || "/", origin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  request.once("aborted", () => controller.abort());
  if (dashboard) {
    try {
      const dashboardResult = await dashboard.handle(
        request,
        url,
        requestId,
        clientAddress(request, Boolean(config.trustProxy))
      );
      if (dashboardResult) {
        clearTimeout(timeout);
        writeDashboardResponse(response, dashboardResult);
        writeLog(requestId, url.pathname, dashboardResult.status, startedAt, dashboardResult.trace);
        return;
      }
    } catch {
      clearTimeout(timeout);
      const failure: DashboardResponse = {
        status: 500,
        body: JSON.stringify({ error: "internal_error", requestId }),
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        },
        trace: { cacheHit: false, upstream: [] }
      };
      writeDashboardResponse(response, failure);
      writeLog(requestId, url.pathname, failure.status, startedAt, failure.trace);
      return;
    }
  }
  let gatewayResult: GatewayResult;
  try {
    gatewayResult = await handleGatewayRequest(
      {
        method: request.method || "GET",
        url: url.toString(),
        requestId,
        signal: controller.signal
      },
      {
        env: {
          acoustidApiKey: config.acoustidApiKey,
          appUserAgent: config.appUserAgent,
          runtime: "node",
          cache: "sqlite"
        },
        transport
      }
    );
  } catch {
    gatewayResult = {
      status: 502,
      body: { error: "upstream_failure", requestId },
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      },
      trace: { cacheHit: false, upstream: [] }
    };
  } finally {
    clearTimeout(timeout);
  }
  response.writeHead(gatewayResult.status, gatewayResult.headers);
  response.end(JSON.stringify(gatewayResult.body));
  const durationMs = Date.now() - startedAt;
  dashboard?.record(url.pathname, gatewayResult.status, durationMs, gatewayResult.trace);
  writeLog(requestId, url.pathname, gatewayResult.status, startedAt, gatewayResult.trace);
}

function writeDashboardResponse(
  response: ServerResponse,
  result: DashboardResponse
): void {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

function serveBusy(request: IncomingMessage, response: ServerResponse): void {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const route = safeRoute(request.url);
  request.resume();
  response.writeHead(503, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": "1",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify({ error: "server_busy", requestId }));
  writeLog(
    requestId,
    route,
    503,
    startedAt,
    { cacheHit: false, upstream: [] }
  );
}

function serveRateLimited(request: IncomingMessage, response: ServerResponse): void {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const route = safeRoute(request.url);
  request.resume();
  response.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": "1",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify({ error: "server_rate_limited", requestId }));
  writeLog(
    requestId,
    route,
    429,
    startedAt,
    { cacheHit: false, upstream: [] }
  );
}

function writeLog(
  requestId: string,
  route: string,
  status: number,
  startedAt: number,
  trace: GatewayResult["trace"]
): void {
  process.stdout.write(`${JSON.stringify({
    requestId,
    route,
    status,
    durationMs: Date.now() - startedAt,
    cacheHit: trace.cacheHit,
    upstream: trace.upstream
  })}\n`);
}

function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  const remoteAddress = request.socket.remoteAddress || "unknown";
  if (
    trustProxy
    && (remoteAddress === "127.0.0.1"
      || remoteAddress === "::1"
      || remoteAddress === "::ffff:127.0.0.1")
  ) {
    const proxied = request.headers["x-real-ip"];
    if (typeof proxied === "string" && proxied.length <= 64 && isIP(proxied)) return proxied;
  }
  return remoteAddress;
}

function safeRoute(value: string | undefined): string {
  try {
    return new URL(value || "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startNodeGateway();
  } catch {
    process.stderr.write("metadata-gateway: initialization_failed\n");
    process.exitCode = 1;
  }
}
