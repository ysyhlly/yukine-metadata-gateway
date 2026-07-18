import type { ProviderRuntimeStats } from "../transport.js";

export interface RuntimeCacheStats {
  l1: {
    layer: "memory";
    entries: number;
    maxEntries: number;
    connected: true;
  };
  l2: {
    layer: "sqlite" | "redis";
    entries: number | null;
    maxEntries: number | null;
    connected: boolean;
  };
}

export interface RuntimeStatsSnapshot {
  instanceId: string;
  version: string;
  revision: string;
  runtime: "node";
  stateBackend: "sqlite" | "external";
  ready: boolean;
  heartbeatAt: number;
  startedAt: number;
  uptimeSeconds: number;
  cache: RuntimeCacheStats;
  singleflight: {
    flights: number;
    waiters: number;
  };
  ingress: {
    active: number;
    limit: number;
    requestsThisSecond: number;
    rateLimit: number;
  };
  providers: ProviderRuntimeStats[];
}

export interface RuntimeStatsProvider {
  snapshot(): RuntimeStatsSnapshot | Promise<RuntimeStatsSnapshot>;
}
