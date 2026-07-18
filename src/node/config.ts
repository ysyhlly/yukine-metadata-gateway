import { dirname, resolve } from "node:path";
import type { DashboardConfig } from "./dashboard.js";

export interface NodeGatewayConfig {
  host: string;
  port: number;
  cacheDbPath: string;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  upstreamTimeoutMs: number;
  requestTimeoutMs: number;
  appUserAgent: string;
  acoustidApiKey?: string;
  dashboard?: DashboardConfig;
  trustProxy?: boolean;
}

export function loadNodeGatewayConfig(env: NodeJS.ProcessEnv = process.env): NodeGatewayConfig {
  const cacheDbPath = env.CACHE_DB_PATH?.trim() || resolve("data", "metadata-cache.sqlite");
  const dashboardEnabled = boolean(env.DASHBOARD_ENABLED, false);
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: integer(env.PORT, 1, 65_535, 8_787),
    cacheDbPath,
    cacheTtlSeconds: integer(env.CACHE_TTL_SECONDS, 1, 31_536_000, 3_600),
    cacheMaxEntries: integer(env.CACHE_MAX_ENTRIES, 1, 1_000_000, 10_000),
    upstreamTimeoutMs: integer(env.UPSTREAM_TIMEOUT_MS, 100, 60_000, 4_500),
    requestTimeoutMs: integer(env.REQUEST_TIMEOUT_MS, 100, 120_000, 10_000),
    appUserAgent: env.APP_USER_AGENT?.trim()
      || "Yukine-Metadata-Gateway/1.0 (https://github.com/ysyhlly/yukine-metadata-gateway)",
    acoustidApiKey: env.ACOUSTID_API_KEY?.trim() || undefined,
    trustProxy: boolean(env.TRUST_PROXY, false),
    dashboard: dashboardEnabled
      ? loadDashboardConfig(env, cacheDbPath)
      : undefined
  };
}

function loadDashboardConfig(
  env: NodeJS.ProcessEnv,
  cacheDbPath: string
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
    )
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

function integer(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
