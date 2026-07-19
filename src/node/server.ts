import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { handleGatewayRequest } from "../core.js";
import { JsonFetchTransport } from "../transport.js";
import type { GatewayResult } from "../types.js";
import { loadNodeGatewayConfig, type NodeGatewayConfig } from "./config.js";
import { Dashboard, type DashboardResponse } from "./dashboard.js";
import { RedisJsonCache } from "./redis-cache.js";
import { SqliteJsonCache } from "./sqlite-cache.js";
import type { UpstreamJsonCache } from "../types.js";
import { startNodeTelemetry } from "./telemetry.js";
import type { NodeTelemetryRuntime } from "./telemetry.js";
import { PostgresReadiness } from "./postgres-readiness.js";
import type { RuntimeStatsProvider } from "./runtime-stats.js";
import {
  PostgresAuthorizationStore,
  SqliteAuthorizationStore
} from "./authorization-store.js";
import {
  GatewayAuthorizationError,
  GatewayAuthorizationService
} from "./gateway-authorization.js";

export function startNodeGateway(config: NodeGatewayConfig = loadNodeGatewayConfig()) {
  const sqliteCache = config.stateBackend !== "external"
    ? new SqliteJsonCache({
        path: config.cacheDbPath,
        ttlSeconds: config.cacheTtlSeconds,
        staleSeconds: config.cacheStaleSeconds,
        maxEntries: config.cacheMaxEntries
      })
    : undefined;
  const redisCache = config.stateBackend === "external"
    ? new RedisJsonCache({
        url: required(config.redisUrl, "redis_url_required"),
        ttlSeconds: config.cacheTtlSeconds,
        staleSeconds: config.cacheStaleSeconds ?? 86_400
      })
    : undefined;
  const cache: UpstreamJsonCache = redisCache || sqliteCache!;
  const transport = new JsonFetchTransport({
    timeoutMs: config.upstreamTimeoutMs,
    cache,
    memoryMaxEntries: config.memoryCacheMaxEntries,
    freshMs: config.cacheTtlSeconds * 1_000,
    staleMs: (config.cacheStaleSeconds ?? 86_400) * 1_000,
    coordinator: redisCache,
    cacheLayer: config.stateBackend === "external" ? "redis" : "sqlite"
  });
  const telemetry = startNodeTelemetry(
    config.otelEndpoint,
    config.otelServiceName || "yukine-metadata-gateway"
  );
  const postgres = config.stateBackend === "external"
    ? new PostgresReadiness(required(config.databaseUrl, "database_url_required"))
    : undefined;
  const concurrency = new RequestConcurrencyLimiter(config.maxConcurrentRequests);
  const requestRate = new RequestRateLimiter(config.maxRequestsPerSecond);
  const authorizationStore = config.authorization
    ? config.authorization.backend === "external"
      ? new PostgresAuthorizationStore({
          url: required(config.authorization.databaseUrl, "authorization_database_url_required")
        })
      : new SqliteAuthorizationStore({ path: config.authorization.dbPath })
    : undefined;
  const authorization = config.authorization && authorizationStore
    ? new GatewayAuthorizationService({
        issuerId: config.authorization.issuerId,
        keyId: config.authorization.keyId,
        privateKeyPem: config.authorization.privateKeyPem,
        credentialPepper: config.authorization.credentialPepper,
        publicOrigin: config.authorization.publicOrigin,
        store: authorizationStore
      })
    : undefined;
  const authorizationInitialization = authorization?.initialize();
  const startedAt = Date.now();
  let dashboard: Dashboard | undefined;
  const ready = async () => {
    const cacheReady = await cache.ready?.() ?? true;
    const postgresReady = await postgres?.ready() ?? true;
    const dashboardReady = await dashboard?.ready() ?? true;
    let authorizationReady = true;
    if (authorization) {
      try {
        await authorizationInitialization;
        authorizationReady = await authorization.ready();
      } catch {
        authorizationReady = false;
      }
    }
    return cacheReady && postgresReady && dashboardReady && authorizationReady;
  };
  const runtimeStats: RuntimeStatsProvider = {
    snapshot: async () => {
      const now = Date.now();
      const transportStats = transport.runtimeStats();
      const l2Connected = await cache.ready?.() ?? true;
      const sqliteStats = sqliteCache?.stats();
      return {
        instanceId: config.instanceId || "unknown",
        version: config.appVersion || "1.0.0",
        revision: config.appRevision || "unknown",
        runtime: "node",
        stateBackend: config.stateBackend === "external" ? "external" : "sqlite",
        ready: await ready(),
        heartbeatAt: now,
        startedAt,
        uptimeSeconds: Math.max(0, Math.floor((now - startedAt) / 1_000)),
        cache: {
          l1: {
            layer: "memory",
            entries: transportStats.memory.entries,
            maxEntries: transportStats.memory.maxEntries,
            connected: true
          },
          l2: {
            layer: config.stateBackend === "external" ? "redis" : "sqlite",
            entries: sqliteStats?.entries ?? null,
            maxEntries: sqliteStats?.maxEntries ?? null,
            connected: l2Connected
          }
        },
        singleflight: transportStats.singleflight,
        ingress: {
          active: concurrency.activeRequests,
          limit: concurrency.maximum,
          requestsThisSecond: requestRate.requestsInCurrentWindow,
          rateLimit: requestRate.maximumPerSecond
        },
        providers: transportStats.providers
      };
    }
  };
  try {
    dashboard = config.dashboard
      ? new Dashboard(config.dashboard, runtimeStats, authorization)
      : undefined;
  } catch (error) {
    void cache.close();
    throw error;
  }
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
        await serveRequest(
          request,
          response,
          config,
          transport,
          dashboard,
          authorization,
          ready,
          telemetry
        );
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
      void (async () => {
        await dashboard?.close();
        await authorization?.close();
        await cache.close();
        await postgres?.close();
        await telemetry.shutdown();
      })().finally(() => {
        process.exitCode = 0;
      });
    });
    setTimeout(() => {
      server.closeAllConnections();
    }, Math.min(5_000, config.requestTimeoutMs)).unref();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return {
    server,
    close,
    cache,
    dashboard,
    authorization,
    concurrency,
    requestRate,
    ready,
    transport,
    telemetry
  };
}

export async function startNodeGatewayReady(
  config: NodeGatewayConfig = loadNodeGatewayConfig()
) {
  const runtime = startNodeGateway(config);
  if (!await runtime.ready()) {
    runtime.close();
    throw new Error("metadata_gateway_not_ready");
  }
  return runtime;
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
  dashboard: Dashboard | undefined,
  authorization: GatewayAuthorizationService | undefined,
  ready: () => Promise<boolean>,
  telemetry: NodeTelemetryRuntime
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
  const authorizationResult = await serveAuthorizationRequest(
    request,
    url,
    requestId,
    authorization
  );
  if (authorizationResult) {
    clearTimeout(timeout);
    response.writeHead(authorizationResult.status, authorizationResult.headers);
    response.end(JSON.stringify(authorizationResult.body));
    const route = safeLogRoute(url.pathname);
    const durationMs = Date.now() - startedAt;
    dashboard?.record(route, authorizationResult.status, durationMs, authorizationResult.trace);
    telemetry.sink?.recordGatewayRequest({
      route,
      status: authorizationResult.status,
      durationMs,
      runtime: "node",
      cache: config.stateBackend === "external" ? "redis" : "sqlite",
      trace: authorizationResult.trace
    });
    writeLog(requestId, route, authorizationResult.status, startedAt, authorizationResult.trace);
    return;
  }
  let gatewayResult: GatewayResult;
  try {
    gatewayResult = await telemetry.run({
      route: url.pathname,
      traceparent: singleHeader(request.headers.traceparent),
      tracestate: singleHeader(request.headers.tracestate)
    }, () => handleGatewayRequest(
      {
        method: request.method || "GET",
        url: url.toString(),
        requestId,
        signal: controller.signal,
        traceparent: singleHeader(request.headers.traceparent),
        tracestate: singleHeader(request.headers.tracestate)
      },
      {
        env: {
          acoustidApiKey: config.acoustidApiKey,
          appUserAgent: config.appUserAgent,
          runtime: "node",
          cache: config.stateBackend === "external" ? "redis" : "sqlite",
          v2Enabled: config.v2Enabled,
          v1SunsetDate: config.v1SunsetDate
        },
        transport,
        defer: (task) => {
          void task.catch(() => {});
        },
        ready,
        telemetry: telemetry.sink
      }
    ));
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
  telemetry.sink?.recordGatewayRequest({
    route: url.pathname,
    status: gatewayResult.status,
    durationMs,
    runtime: "node",
    cache: config.stateBackend === "external" ? "redis" : "sqlite",
    trace: gatewayResult.trace
  });
  writeLog(requestId, safeLogRoute(url.pathname), gatewayResult.status, startedAt, gatewayResult.trace);
}

async function serveAuthorizationRequest(
  request: IncomingMessage,
  url: URL,
  requestId: string,
  authorization: GatewayAuthorizationService | undefined
): Promise<GatewayResult | null> {
  const method = request.method || "GET";
  const isMetadata = method === "GET"
    && /^\/v[12]\/(recordings|artists|albums|lyrics)\/search$/.test(url.pathname);
  const isAuthorizationPath = url.pathname === "/v1/authorization/verify"
    || url.pathname === "/v1/authorization/activate"
    || url.pathname.startsWith("/v1/authorization/redeem/");
  if (!authorization) {
    return isAuthorizationPath
      ? authorizationJson(404, { error: "not_found", requestId })
      : null;
  }
  try {
    if (isMetadata) {
      await authorization.authorizeMetadata(singleHeader(request.headers.authorization));
      return null;
    }
    if (!isAuthorizationPath) return null;
    if (method !== "POST") {
      request.resume();
      return authorizationJson(405, { error: "method_not_allowed", requestId });
    }
    const parsed = await readBoundedJson(request, requestId);
    if ("result" in parsed) return parsed.result;
    if (url.pathname === "/v1/authorization/verify") {
      const signed = await authorization.verify(
        singleHeader(request.headers.authorization),
        parsed.body
      );
      return authorizationJson(200, signed);
    }
    if (url.pathname === "/v1/authorization/activate") {
      const signed = await authorization.activate(
        singleHeader(request.headers.authorization),
        parsed.body
      );
      return authorizationJson(200, signed);
    }
    const token = url.pathname.slice("/v1/authorization/redeem/".length);
    if (!token || token.includes("/")) {
      return authorizationJson(404, { error: "not_found", requestId });
    }
    const redeemed = await authorization.redeem(token, parsed.body);
    return authorizationJson(200, redeemed);
  } catch (error) {
    if (error instanceof GatewayAuthorizationError) {
      const result = authorizationJson(error.status, {
        error: error.code,
        requestId
      });
      if (error.status === 401) {
        result.headers["WWW-Authenticate"] = "Bearer";
      }
      return result;
    }
    return authorizationJson(503, {
      error: "authorization_unavailable",
      requestId
    });
  }
}

async function readBoundedJson(
  request: IncomingMessage,
  requestId: string
): Promise<{ body: Record<string, unknown> } | { result: GatewayResult }> {
  const contentType = singleHeader(request.headers["content-type"]) || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    request.resume();
    return {
      result: authorizationJson(415, { error: "unsupported_media_type", requestId })
    };
  }
  const declared = Number.parseInt(
    singleHeader(request.headers["content-length"]) || "0",
    10
  );
  if (Number.isFinite(declared) && declared > 16 * 1024) {
    request.resume();
    return {
      result: authorizationJson(413, { error: "payload_too_large", requestId })
    };
  }
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 16 * 1024) {
        request.resume();
        return {
          result: authorizationJson(413, { error: "payload_too_large", requestId })
        };
      }
      chunks.push(buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {
        result: authorizationJson(400, { error: "invalid_request", requestId })
      };
    }
    return { body: body as Record<string, unknown> };
  } catch {
    return {
      result: authorizationJson(400, { error: "invalid_request", requestId })
    };
  }
}

function authorizationJson(status: number, body: unknown): GatewayResult {
  return {
    status,
    body,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    },
    trace: { cacheHit: false, upstream: [] }
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
  const route = safeLogRoute(safeRoute(request.url));
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
  const route = safeLogRoute(safeRoute(request.url));
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

function safeLogRoute(pathname: string): string {
  return pathname.startsWith("/v1/authorization/redeem/")
    ? "/v1/authorization/redeem/[redacted]"
    : pathname;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startNodeGatewayReady().catch(() => {
    process.stderr.write("metadata-gateway: initialization_failed\n");
    process.exitCode = 1;
  });
}

function required(value: string | undefined, error: string): string {
  if (!value) throw new Error(error);
  return value;
}
