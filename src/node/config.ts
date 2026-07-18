import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import type { DashboardConfig } from "./dashboard.js";

export interface NodeGatewayConfig {
  host: string;
  port: number;
  cacheDbPath: string;
  cacheTtlSeconds: number;
  cacheStaleSeconds?: number;
  cacheMaxEntries: number;
  memoryCacheMaxEntries?: number;
  upstreamTimeoutMs: number;
  requestTimeoutMs: number;
  maxConcurrentRequests: number;
  maxRequestsPerSecond: number;
  appUserAgent: string;
  acoustidApiKey?: string;
  dashboard?: DashboardConfig;
  trustProxy?: boolean;
  stateBackend?: "sqlite" | "external";
  redisUrl?: string;
  databaseUrl?: string;
  otelEndpoint?: string;
  otelServiceName?: string;
  v2Enabled?: boolean;
  v1SunsetDate?: string;
  instanceId?: string;
  appVersion?: string;
  appRevision?: string;
}

export function loadNodeGatewayConfig(env: NodeJS.ProcessEnv = process.env): NodeGatewayConfig {
  const cacheDbPath = env.CACHE_DB_PATH?.trim() || resolve("data", "metadata-cache.sqlite");
  const dashboardEnabled = boolean(env.DASHBOARD_ENABLED, false);
  const stateBackend = env.STATE_BACKEND?.trim().toLowerCase() === "external"
    ? "external"
    : "sqlite";
  const redisUrl = env.REDIS_URL?.trim() || undefined;
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (stateBackend === "external" && (!redisUrl || !databaseUrl)) {
    throw new Error("external_state_requires_redis_and_database_urls");
  }
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: integer(env.PORT, 1, 65_535, 8_787),
    cacheDbPath,
    cacheTtlSeconds: integer(env.CACHE_TTL_SECONDS, 1, 31_536_000, 3_600),
    cacheStaleSeconds: integer(env.CACHE_STALE_SECONDS, 0, 31_536_000, 86_400),
    cacheMaxEntries: integer(env.CACHE_MAX_ENTRIES, 1, 1_000_000, 10_000),
    memoryCacheMaxEntries: integer(env.MEMORY_CACHE_MAX_ENTRIES, 0, 100_000, 1_000),
    upstreamTimeoutMs: integer(env.UPSTREAM_TIMEOUT_MS, 100, 60_000, 4_500),
    requestTimeoutMs: integer(env.REQUEST_TIMEOUT_MS, 100, 120_000, 10_000),
    maxConcurrentRequests: integer(env.MAX_CONCURRENT_REQUESTS, 1, 10_000, 500),
    maxRequestsPerSecond: integer(env.MAX_REQUESTS_PER_SECOND, 1, 100_000, 500),
    appUserAgent: env.APP_USER_AGENT?.trim()
      || "Yukine-Metadata-Gateway/1.0 (https://github.com/ysyhlly/yukine-metadata-gateway)",
    acoustidApiKey: env.ACOUSTID_API_KEY?.trim() || undefined,
    trustProxy: boolean(env.TRUST_PROXY, false),
    stateBackend,
    redisUrl,
    databaseUrl,
    otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
    otelServiceName: env.OTEL_SERVICE_NAME?.trim() || "yukine-metadata-gateway",
    v2Enabled: boolean(env.V2_ENABLED, true),
    v1SunsetDate: httpDate(env.V1_SUNSET_DATE),
    instanceId: env.INSTANCE_ID?.trim() || hostname(),
    appVersion: env.APP_VERSION?.trim() || "1.0.0",
    appRevision: env.APP_REVISION?.trim() || "unknown",
    dashboard: dashboardEnabled
      ? loadDashboardConfig(env, cacheDbPath, stateBackend, databaseUrl)
      : undefined
  };
}

function loadDashboardConfig(
  env: NodeJS.ProcessEnv,
  cacheDbPath: string,
  stateBackend: "sqlite" | "external",
  databaseUrl?: string
): DashboardConfig {
  const publicOrigin = parsePublicOrigin(
    env.DASHBOARD_PUBLIC_ORIGIN?.trim() || "https://metadata.ysyhly.cn"
  );
  const setupToken = env.DASHBOARD_SETUP_TOKEN?.trim() || undefined;
  if (setupToken && setupToken.length < 32) {
    throw new Error("dashboard_setup_token_too_short");
  }
  return {
    dbPath: env.DASHBOARD_DB_PATH?.trim()
      || resolve(dirname(cacheDbPath), "dashboard.sqlite"),
    publicOrigin,
    setupToken,
    assetsPath: env.DASHBOARD_ASSETS_PATH?.trim() || resolve("assets"),
    sessionIdleMs: integer(
      env.DASHBOARD_SESSION_IDLE_SECONDS,
      60,
      86_400,
      1_800
    ) * 1_000,
    sessionAbsoluteMs: integer(
      env.DASHBOARD_SESSION_ABSOLUTE_SECONDS,
      300,
      604_800,
      28_800
    ) * 1_000,
    retentionDays: integer(
      env.DASHBOARD_METRICS_RETENTION_DAYS,
      1,
      365,
      30
    ),
    backend: stateBackend,
    databaseUrl
  };
}

function parsePublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname))
  ) {
    throw new Error("invalid_dashboard_public_origin");
  }
  return url.origin;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function httpDate(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) throw new Error("invalid_v1_sunset_date");
  return new Date(timestamp).toUTCString();
}

function integer(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
