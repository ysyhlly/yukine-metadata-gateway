import { resolve } from "node:path";

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
}

export function loadNodeGatewayConfig(env: NodeJS.ProcessEnv = process.env): NodeGatewayConfig {
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    port: integer(env.PORT, 1, 65_535, 8_787),
    cacheDbPath: env.CACHE_DB_PATH?.trim() || resolve("data", "metadata-cache.sqlite"),
    cacheTtlSeconds: integer(env.CACHE_TTL_SECONDS, 1, 31_536_000, 3_600),
    cacheMaxEntries: integer(env.CACHE_MAX_ENTRIES, 1, 1_000_000, 10_000),
    upstreamTimeoutMs: integer(env.UPSTREAM_TIMEOUT_MS, 100, 60_000, 4_500),
    requestTimeoutMs: integer(env.REQUEST_TIMEOUT_MS, 100, 120_000, 10_000),
    appUserAgent: env.APP_USER_AGENT?.trim()
      || "Yukine-Metadata-Gateway/1.0 (https://github.com/ysyhlly/yukine-metadata-gateway)",
    acoustidApiKey: env.ACOUSTID_API_KEY?.trim() || undefined
  };
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
