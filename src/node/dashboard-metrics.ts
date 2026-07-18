import type {
  CacheLayer,
  CacheState,
  RequestTrace,
  UpstreamOutcome
} from "../types.js";
import type {
  ProviderHealthSampleRow,
  ProviderMetricRow,
  RequestMetricRow,
  RuntimeSampleRow,
  StoredProviderMetric,
  UpstreamMetricRow
} from "./dashboard-store.js";
import type { DashboardStoreAdapter } from "./dashboard-store-adapter.js";
import type {
  RuntimeStatsProvider,
  RuntimeStatsSnapshot
} from "./runtime-stats.js";

const MINUTE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const ONLINE_THRESHOLD_MS = 45_000;
const LATENCY_THRESHOLDS = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const WINDOWS = {
  "15m": 15 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
  "24h": 24 * 60 * MINUTE_MS
} as const;

export type DashboardWindow = keyof typeof WINDOWS;

export interface DashboardMetricsOptions {
  retentionDays: number;
  runtimeStats?: RuntimeStatsProvider;
  cacheStats?: () => { entries: number; maxEntries: number };
}

interface Aggregate {
  requests: number;
  errors: number;
  clientErrors: number;
  cacheHits: number;
  upstreamRequests: number;
  upstreamAttempts: number;
  durationSumMs: number;
  durationMaxMs: number;
  latencyBuckets: number[];
}

interface ProviderAggregate {
  attempts: number;
  durationSumMs: number;
  durationMaxMs: number;
  latencyBuckets: number[];
  outcomes: Record<string, number>;
  cacheStates: Record<string, number>;
  cacheLayers: Record<string, number>;
  hosts: Set<string>;
}

export class DashboardMetrics {
  private readonly requestRows = new Map<string, RequestMetricRow>();
  private readonly upstreamRows = new Map<string, UpstreamMetricRow>();
  private readonly providerRows = new Map<string, ProviderMetricRow>();
  private readonly startedAt = Date.now();
  private readonly timer: NodeJS.Timeout;
  private readonly heartbeatTimer: NodeJS.Timeout;
  private lastCleanupAt = 0;
  private currentInstanceId: string | undefined;
  private flushTail: Promise<void> = Promise.resolve();
  private heartbeatTail: Promise<void> = Promise.resolve();
  private readonly runtimeStats: RuntimeStatsProvider;

  constructor(
    private readonly store: DashboardStoreAdapter,
    private readonly options: DashboardMetricsOptions
  ) {
    this.runtimeStats = options.runtimeStats ?? legacyRuntimeStats(options.cacheStats);
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, 1_000);
    this.timer.unref();
    this.heartbeatTimer = setInterval(() => {
      void this.captureRuntime().catch(() => {});
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref();
    setTimeout(() => {
      void this.captureRuntime().catch(() => {});
    }, 0).unref();
  }

  record(
    route: string,
    status: number,
    durationMs: number,
    trace: RequestTrace,
    now = Date.now()
  ): void {
    if (!route.startsWith("/v1/") && !route.startsWith("/v2/")) return;
    const bucketStartMs = minuteBucket(now);
    const requestKey = [bucketStartMs, route, status].join("\u0000");
    let requestRow = this.requestRows.get(requestKey);
    if (!requestRow) {
      requestRow = {
        bucketStartMs,
        route,
        status,
        requests: 0,
        cacheHits: 0,
        upstreamRequests: 0,
        upstreamAttempts: 0,
        durationSumMs: 0,
        durationMaxMs: 0,
        latencyBuckets: emptyLatencyBuckets()
      };
      this.requestRows.set(requestKey, requestRow);
    }
    const boundedDuration = boundedMs(durationMs);
    requestRow.requests += 1;
    requestRow.cacheHits += trace.cacheHit ? 1 : 0;
    requestRow.upstreamRequests += trace.upstream.length > 0 ? 1 : 0;
    requestRow.upstreamAttempts += trace.upstream.length;
    requestRow.durationSumMs += boundedDuration;
    requestRow.durationMaxMs = Math.max(requestRow.durationMaxMs, boundedDuration);
    addLatency(requestRow.latencyBuckets, boundedDuration);

    for (const attempt of trace.upstream) {
      const legacyOutcome = upstreamOutcome(attempt.status, attempt.outcome);
      const upstreamKey = [bucketStartMs, route, attempt.host, legacyOutcome].join("\u0000");
      let upstreamRow = this.upstreamRows.get(upstreamKey);
      if (!upstreamRow) {
        upstreamRow = {
          bucketStartMs,
          route,
          host: attempt.host,
          outcome: legacyOutcome,
          attempts: 0
        };
        this.upstreamRows.set(upstreamKey, upstreamRow);
      }
      upstreamRow.attempts += 1;

      const detailedOutcome = attempt.outcome ?? detailedOutcomeForStatus(attempt.status);
      const cacheState = attempt.cacheState ?? "unknown";
      const cacheLayer = attempt.cacheLayer ?? "unknown";
      const provider = attempt.provider || "unknown";
      const providerKey = [
        bucketStartMs,
        route,
        provider,
        attempt.host,
        detailedOutcome,
        cacheState,
        cacheLayer
      ].join("\u0000");
      let providerRow = this.providerRows.get(providerKey);
      if (!providerRow) {
        providerRow = {
          bucketStartMs,
          route,
          provider,
          host: attempt.host,
          outcome: detailedOutcome,
          cacheState,
          cacheLayer,
          attempts: 0,
          durationSumMs: 0,
          durationMaxMs: 0,
          latencyBuckets: emptyLatencyBuckets()
        };
        this.providerRows.set(providerKey, providerRow);
      }
      const attemptDuration = boundedMs(attempt.durationMs || 0);
      providerRow.attempts += 1;
      providerRow.durationSumMs += attemptDuration;
      providerRow.durationMaxMs = Math.max(providerRow.durationMaxMs, attemptDuration);
      addLatency(providerRow.latencyBuckets, attemptDuration);
    }

    if (this.requestRows.size + this.upstreamRows.size + this.providerRows.size >= 100) {
      void this.flush(now).catch(() => {});
    }
  }

  async snapshot(window: DashboardWindow, now = Date.now()) {
    await this.flush(now);
    await this.captureRuntime(now);
    const windowMs = WINDOWS[window];
    const since = minuteBucket(now - windowMs);
    const [
      requestRows,
      upstreamRows,
      providerRows,
      runtimeRows,
      providerHealthRows
    ] = await Promise.all([
      this.store.readRequestMetrics(since),
      this.store.readUpstreamSummary(since),
      this.store.readProviderMetrics(since),
      this.store.readRuntimeSamples(since),
      this.store.readProviderHealth(since)
    ]);
    const overall = emptyAggregate();
    const routeAggregates = new Map<string, Aggregate>();
    const statusCounts = new Map<number, number>();
    const trendSize = window === "24h" ? 15 * MINUTE_MS : MINUTE_MS;
    const trendAggregates = new Map<number, Aggregate>();

    for (const row of requestRows) {
      addRow(overall, row);
      const routeAggregate = routeAggregates.get(row.route) || emptyAggregate();
      addRow(routeAggregate, row);
      routeAggregates.set(row.route, routeAggregate);
      statusCounts.set(row.status, (statusCounts.get(row.status) || 0) + row.requests);
      const trendBucket = Math.floor(row.bucketStartMs / trendSize) * trendSize;
      const trendAggregate = trendAggregates.get(trendBucket) || emptyAggregate();
      addRow(trendAggregate, row);
      trendAggregates.set(trendBucket, trendAggregate);
    }

    const upstreamByHost = new Map<string, {
      success: number;
      notFound: number;
      failure: number;
    }>();
    let upstreamAttempts = 0;
    let upstreamFailures = 0;
    for (const row of upstreamRows) {
      const host = upstreamByHost.get(row.host) || {
        success: 0,
        notFound: 0,
        failure: 0
      };
      if (row.outcome === "success") host.success += row.attempts;
      else if (row.outcome === "not_found") host.notFound += row.attempts;
      else {
        host.failure += row.attempts;
        upstreamFailures += row.attempts;
      }
      upstreamAttempts += row.attempts;
      upstreamByHost.set(row.host, host);
    }

    const providerAggregates = aggregateProviders(providerRows);
    const cacheAggregate = aggregateCache(providerRows, trendSize);
    const latestRuntime = latestBy(runtimeRows, (row) => row.instanceId);
    const latestHealth = latestBy(
      providerHealthRows,
      (row) => `${row.instanceId}\u0000${row.provider}`
    );
    const instances = [...latestRuntime.values()]
      .map((row) => ({
        instanceId: row.instanceId,
        version: row.version,
        revision: row.revision,
        runtime: row.runtime,
        stateBackend: row.stateBackend,
        ready: row.ready,
        online: now - row.heartbeatAt <= ONLINE_THRESHOLD_MS,
        heartbeatAt: row.heartbeatAt,
        startedAt: row.startedAt,
        uptimeSeconds: row.uptimeSeconds,
        cache: {
          l1: {
            layer: "memory",
            entries: row.l1Entries,
            maxEntries: row.l1MaxEntries,
            connected: true
          },
          l2: {
            layer: row.l2Layer,
            entries: row.l2Entries,
            maxEntries: row.l2MaxEntries,
            connected: row.l2Connected
          }
        },
        singleflight: {
          flights: row.singleflightFlights,
          waiters: row.singleflightWaiters
        },
        ingress: {
          active: row.ingressActive,
          limit: row.ingressLimit,
          requestsThisSecond: row.requestsThisSecond,
          rateLimit: row.rateLimit
        }
      }))
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    const providerNames = new Set([
      ...providerAggregates.keys(),
      ...[...latestHealth.values()].map((row) => row.provider)
    ]);
    const providers = [...providerNames].map((provider) => {
      const aggregate = providerAggregates.get(provider) || emptyProviderAggregate();
      const health = [...latestHealth.values()].filter((row) => row.provider === provider);
      const failures = Object.entries(aggregate.outcomes)
        .filter(([outcome]) => !["success", "not_found", "aborted"].includes(outcome))
        .reduce((total, [, count]) => total + count, 0);
      return {
        provider,
        hosts: [...aggregate.hosts].sort(),
        metricsKnown: aggregate.attempts > 0,
        attempts: aggregate.attempts,
        availability: aggregate.attempts > 0
          ? 1 - failures / aggregate.attempts
          : null,
        latencyP95Ms: providerPercentile(aggregate, 0.95),
        latencyAverageMs: divide(aggregate.durationSumMs, aggregate.attempts),
        outcomes: aggregate.outcomes,
        cacheStates: aggregate.cacheStates,
        cacheLayers: aggregate.cacheLayers,
        health: {
          state: worstState(health.map((row) => row.state)),
          recentFailures: health.reduce((total, row) => total + row.recentFailures, 0),
          openedAt: nullableMax(health.map((row) => row.openedAt)),
          active: health.reduce((total, row) => total + row.active, 0),
          queued: health.reduce((total, row) => total + row.queued, 0),
          limit: health.reduce((total, row) => total + row.limit, 0)
        }
      };
    }).sort((left, right) => right.attempts - left.attempts || left.provider.localeCompare(right.provider));
    const currentInstance = instances.find(
      (instance) => instance.instanceId === this.currentInstanceId
    ) || instances.find((instance) => instance.online) || instances[0];

    return {
      schemaVersion: 2,
      generatedAt: now,
      window,
      windowMs,
      retentionDays: this.options.retentionDays,
      summary: {
        requests: overall.requests,
        rps: divide(overall.requests, windowMs / 1_000),
        availability: overall.requests > 0 ? 1 - overall.errors / overall.requests : null,
        errorRate: divide(overall.errors, overall.requests),
        clientErrorRate: divide(overall.clientErrors, overall.requests),
        latencyP50Ms: percentile(overall, 0.5),
        latencyP95Ms: percentile(overall, 0.95),
        latencyP99Ms: percentile(overall, 0.99),
        latencyAverageMs: divide(overall.durationSumMs, overall.requests),
        latencyMaxMs: overall.requests > 0 ? overall.durationMaxMs : null,
        cacheHitRate: divide(overall.cacheHits, overall.upstreamRequests),
        upstreamAvailability: upstreamAttempts > 0
          ? 1 - upstreamFailures / upstreamAttempts
          : null,
        upstreamAttempts,
        fanOut: divide(overall.upstreamAttempts, overall.requests),
        readyInstances: instances.filter((instance) => instance.online && instance.ready).length,
        totalInstances: instances.length
      },
      trend: [...trendAggregates.entries()]
        .map(([bucketStartMs, aggregate]) => ({
          bucketStartMs,
          requests: aggregate.requests,
          errors: aggregate.errors,
          cacheHitRate: divide(aggregate.cacheHits, aggregate.upstreamRequests),
          latencyP95Ms: percentile(aggregate, 0.95)
        }))
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs),
      performance: {
        trend: [...trendAggregates.entries()]
          .map(([bucketStartMs, aggregate]) => ({
            bucketStartMs,
            requests: aggregate.requests,
            rps: divide(aggregate.requests, trendSize / 1_000),
            latencyP50Ms: percentile(aggregate, 0.5),
            latencyP95Ms: percentile(aggregate, 0.95),
            latencyP99Ms: percentile(aggregate, 0.99),
            latencyMaxMs: aggregate.requests > 0 ? aggregate.durationMaxMs : null,
            cacheHitRate: divide(aggregate.cacheHits, aggregate.upstreamRequests)
          }))
          .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
      },
      cache: {
        metricsKnown: cacheAggregate.knownAttempts > 0,
        attempts: cacheAggregate.attempts,
        knownAttempts: cacheAggregate.knownAttempts,
        states: cacheAggregate.states,
        layers: cacheAggregate.layers,
        freshRate: divide(cacheAggregate.states.fresh || 0, cacheAggregate.knownAttempts),
        staleRate: divide(cacheAggregate.states.stale || 0, cacheAggregate.knownAttempts),
        missRate: divide(cacheAggregate.states.miss || 0, cacheAggregate.knownAttempts),
        trend: [...cacheAggregate.trend.entries()]
          .map(([bucketStartMs, value]) => ({
            bucketStartMs,
            fresh: value.fresh,
            stale: value.stale,
            miss: value.miss
          }))
          .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
      },
      statuses: [...statusCounts.entries()]
        .map(([status, requests]) => ({ status, requests }))
        .sort((left, right) => left.status - right.status),
      routes: [...routeAggregates.entries()]
        .map(([route, aggregate]) => ({
          route,
          requests: aggregate.requests,
          availability: aggregate.requests > 0
            ? 1 - aggregate.errors / aggregate.requests
            : null,
          errorRate: divide(aggregate.errors, aggregate.requests),
          clientErrorRate: divide(aggregate.clientErrors, aggregate.requests),
          latencyAverageMs: divide(aggregate.durationSumMs, aggregate.requests),
          latencyP95Ms: percentile(aggregate, 0.95),
          cacheHitRate: divide(aggregate.cacheHits, aggregate.upstreamRequests),
          fanOut: divide(aggregate.upstreamAttempts, aggregate.requests)
        }))
        .sort((left, right) => right.requests - left.requests),
      upstream: [...upstreamByHost.entries()]
        .map(([host, counts]) => {
          const attempts = counts.success + counts.notFound + counts.failure;
          return {
            host,
            attempts,
            success: counts.success,
            notFound: counts.notFound,
            failure: counts.failure,
            availability: attempts > 0 ? 1 - counts.failure / attempts : null
          };
        })
        .sort((left, right) => right.attempts - left.attempts),
      providers,
      instances,
      runtime: {
        startedAt: currentInstance?.startedAt ?? this.startedAt,
        uptimeSeconds: currentInstance?.uptimeSeconds
          ?? Math.max(0, Math.floor((now - this.startedAt) / 1_000)),
        cacheEntries: currentInstance?.cache.l2.entries
          ?? currentInstance?.cache.l1.entries
          ?? 0,
        cacheMaxEntries: currentInstance?.cache.l2.maxEntries
          ?? currentInstance?.cache.l1.maxEntries
          ?? 0
      },
      definitions: {
        scope: "仅统计 Node 运行时的 /v1/* 与 /v2/* 业务请求；健康探针和面板流量已排除。",
        availability: "1 − 5xx 请求数 ÷ 总请求数。",
        cacheHitRate: "至少一次上游读取命中缓存的请求 ÷ 存在上游尝试的请求。",
        upstreamAvailability: "1 − 上游失败尝试数 ÷ 上游总尝试数；已知 404 视为可达。",
        latency: "Node 处理请求的端到端耗时；分位数由固定直方图区间近似。",
        freshness: "Provider 缓存状态按上游尝试计数；旧历史缺失维度显示为未知。",
        instances: "实例每 15 秒写入心跳；超过 45 秒未更新即标记为离线。"
      }
    };
  }

  flush(now = Date.now()): Promise<void> {
    const requests = [...this.requestRows.values()];
    const upstream = [...this.upstreamRows.values()];
    const providers = [...this.providerRows.values()];
    this.requestRows.clear();
    this.upstreamRows.clear();
    this.providerRows.clear();
    const cleanup = now - this.lastCleanupAt >= 5 * MINUTE_MS;
    if (cleanup) this.lastCleanupAt = now;
    this.flushTail = this.flushTail.then(async () => {
      if (requests.length || upstream.length) {
        await this.store.writeMetrics(requests, upstream);
      }
      if (providers.length) await this.store.writeProviderMetrics(providers);
      if (cleanup) await this.store.cleanup(now);
    });
    return this.flushTail;
  }

  captureRuntime(now = Date.now()): Promise<void> {
    this.heartbeatTail = this.heartbeatTail.then(async () => {
      const snapshot = await this.runtimeStats.snapshot();
      this.currentInstanceId = snapshot.instanceId;
      const runtime = runtimeRow(snapshot, now);
      const providerHealth = snapshot.providers.map((provider) => ({
        bucketStartMs: runtime.bucketStartMs,
        instanceId: snapshot.instanceId,
        provider: provider.name,
        state: provider.state,
        recentFailures: provider.recentFailures,
        openedAt: provider.openedAt ?? null,
        active: provider.active,
        queued: provider.queued,
        limit: provider.limit
      }));
      await this.store.writeRuntimeSamples(runtime, providerHealth);
    });
    return this.heartbeatTail;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
    await this.flush();
    await this.heartbeatTail;
  }
}

function legacyRuntimeStats(
  cacheStats: (() => { entries: number; maxEntries: number }) | undefined
): RuntimeStatsProvider {
  const startedAt = Date.now();
  return {
    snapshot: () => {
      const now = Date.now();
      const cache = cacheStats?.() ?? { entries: 0, maxEntries: 0 };
      return {
        instanceId: "test-instance",
        version: "1.0.0",
        revision: "unknown",
        runtime: "node",
        stateBackend: "sqlite",
        ready: true,
        heartbeatAt: now,
        startedAt,
        uptimeSeconds: Math.max(0, Math.floor((now - startedAt) / 1_000)),
        cache: {
          l1: {
            layer: "memory",
            entries: 0,
            maxEntries: 0,
            connected: true
          },
          l2: {
            layer: "sqlite",
            entries: cache.entries,
            maxEntries: cache.maxEntries,
            connected: true
          }
        },
        singleflight: { flights: 0, waiters: 0 },
        ingress: {
          active: 0,
          limit: 0,
          requestsThisSecond: 0,
          rateLimit: 0
        },
        providers: []
      };
    }
  };
}

function runtimeRow(snapshot: RuntimeStatsSnapshot, now: number): RuntimeSampleRow {
  return {
    bucketStartMs: minuteBucket(now),
    instanceId: snapshot.instanceId,
    heartbeatAt: snapshot.heartbeatAt,
    version: snapshot.version,
    revision: snapshot.revision,
    runtime: snapshot.runtime,
    stateBackend: snapshot.stateBackend,
    ready: snapshot.ready,
    startedAt: snapshot.startedAt,
    uptimeSeconds: snapshot.uptimeSeconds,
    l1Entries: snapshot.cache.l1.entries,
    l1MaxEntries: snapshot.cache.l1.maxEntries,
    l2Layer: snapshot.cache.l2.layer,
    l2Entries: snapshot.cache.l2.entries,
    l2MaxEntries: snapshot.cache.l2.maxEntries,
    l2Connected: snapshot.cache.l2.connected,
    singleflightFlights: snapshot.singleflight.flights,
    singleflightWaiters: snapshot.singleflight.waiters,
    ingressActive: snapshot.ingress.active,
    ingressLimit: snapshot.ingress.limit,
    requestsThisSecond: snapshot.ingress.requestsThisSecond,
    rateLimit: snapshot.ingress.rateLimit
  };
}

function aggregateProviders(rows: StoredProviderMetric[]): Map<string, ProviderAggregate> {
  const values = new Map<string, ProviderAggregate>();
  for (const row of rows) {
    const aggregate = values.get(row.provider) || emptyProviderAggregate();
    aggregate.attempts += row.attempts;
    aggregate.durationSumMs += row.durationSumMs;
    aggregate.durationMaxMs = Math.max(aggregate.durationMaxMs, row.durationMaxMs);
    aggregate.hosts.add(row.host);
    addCounts(aggregate.outcomes, row.outcome, row.attempts);
    addCounts(aggregate.cacheStates, row.cacheState, row.attempts);
    addCounts(aggregate.cacheLayers, row.cacheLayer, row.attempts);
    mergeBuckets(aggregate.latencyBuckets, row.latencyBuckets);
    values.set(row.provider, aggregate);
  }
  return values;
}

function aggregateCache(rows: StoredProviderMetric[], trendSize: number) {
  const states: Record<string, number> = {};
  const layers: Record<string, number> = {};
  const trend = new Map<number, { fresh: number; stale: number; miss: number }>();
  let attempts = 0;
  let knownAttempts = 0;
  for (const row of rows) {
    attempts += row.attempts;
    addCounts(states, row.cacheState, row.attempts);
    addCounts(layers, row.cacheLayer, row.attempts);
    const bucket = Math.floor(row.bucketStartMs / trendSize) * trendSize;
    const value = trend.get(bucket) || { fresh: 0, stale: 0, miss: 0 };
    if (row.cacheState === "fresh") {
      value.fresh += row.attempts;
      knownAttempts += row.attempts;
    } else if (row.cacheState === "stale") {
      value.stale += row.attempts;
      knownAttempts += row.attempts;
    } else if (row.cacheState === "miss") {
      value.miss += row.attempts;
      knownAttempts += row.attempts;
    }
    trend.set(bucket, value);
  }
  return { attempts, knownAttempts, states, layers, trend };
}

function latestBy<T extends { bucketStartMs: number }>(
  rows: T[],
  key: (row: T) => string
): Map<string, T> {
  const values = new Map<string, T>();
  for (const row of rows) {
    const rowKey = key(row);
    const current = values.get(rowKey);
    if (!current || current.bucketStartMs <= row.bucketStartMs) values.set(rowKey, row);
  }
  return values;
}

function emptyProviderAggregate(): ProviderAggregate {
  return {
    attempts: 0,
    durationSumMs: 0,
    durationMaxMs: 0,
    latencyBuckets: emptyLatencyBuckets(),
    outcomes: {},
    cacheStates: {},
    cacheLayers: {},
    hosts: new Set()
  };
}

function providerPercentile(aggregate: ProviderAggregate, quantile: number): number | null {
  if (aggregate.attempts === 0) return null;
  const target = Math.ceil(aggregate.attempts * quantile);
  for (let index = 0; index < LATENCY_THRESHOLDS.length; index += 1) {
    if ((aggregate.latencyBuckets[index] || 0) >= target) return LATENCY_THRESHOLDS[index]!;
  }
  return aggregate.durationMaxMs;
}

function worstState(
  states: Array<ProviderHealthSampleRow["state"]>
): ProviderHealthSampleRow["state"] | "unknown" {
  if (states.includes("open")) return "open";
  if (states.includes("half_open")) return "half_open";
  if (states.includes("closed")) return "closed";
  return "unknown";
}

function nullableMax(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? Math.max(...known) : null;
}

function addCounts(target: Record<string, number>, key: string, count: number): void {
  target[key] = (target[key] || 0) + count;
}

function upstreamOutcome(
  status: number,
  detailed?: string
): UpstreamMetricRow["outcome"] {
  if (detailed === "success") return "success";
  if (detailed === "not_found") return "not_found";
  if (detailed) return "failure";
  if (status === 404) return "not_found";
  if (status >= 200 && status < 400) return "success";
  return "failure";
}

function detailedOutcomeForStatus(status: number): UpstreamOutcome | "unknown" {
  if (status === 404) return "not_found";
  if (status >= 200 && status < 400) return "success";
  if (status > 0) return "http";
  return "unknown";
}

function emptyAggregate(): Aggregate {
  return {
    requests: 0,
    errors: 0,
    clientErrors: 0,
    cacheHits: 0,
    upstreamRequests: 0,
    upstreamAttempts: 0,
    durationSumMs: 0,
    durationMaxMs: 0,
    latencyBuckets: emptyLatencyBuckets()
  };
}

function addRow(target: Aggregate, row: RequestMetricRow): void {
  target.requests += row.requests;
  if (row.status >= 500) target.errors += row.requests;
  else if (row.status >= 400) target.clientErrors += row.requests;
  target.cacheHits += row.cacheHits;
  target.upstreamRequests += row.upstreamRequests;
  target.upstreamAttempts += row.upstreamAttempts;
  target.durationSumMs += row.durationSumMs;
  target.durationMaxMs = Math.max(target.durationMaxMs, row.durationMaxMs);
  mergeBuckets(target.latencyBuckets, row.latencyBuckets);
}

function percentile(aggregate: Aggregate, quantile: number): number | null {
  if (aggregate.requests === 0) return null;
  const target = Math.ceil(aggregate.requests * quantile);
  for (let index = 0; index < LATENCY_THRESHOLDS.length; index += 1) {
    if ((aggregate.latencyBuckets[index] || 0) >= target) return LATENCY_THRESHOLDS[index]!;
  }
  return aggregate.durationMaxMs;
}

function emptyLatencyBuckets(): number[] {
  return Array.from({ length: LATENCY_THRESHOLDS.length + 1 }, () => 0);
}

function addLatency(buckets: number[], durationMs: number): void {
  for (let index = 0; index < LATENCY_THRESHOLDS.length; index += 1) {
    if (durationMs <= LATENCY_THRESHOLDS[index]!) {
      buckets[index] = (buckets[index] || 0) + 1;
    }
  }
  if (durationMs > LATENCY_THRESHOLDS.at(-1)!) {
    buckets[LATENCY_THRESHOLDS.length] =
      (buckets[LATENCY_THRESHOLDS.length] || 0) + 1;
  }
}

function mergeBuckets(target: number[], source: number[]): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] = (target[index] || 0) + (source[index] || 0);
  }
}

function boundedMs(value: number): number {
  return Math.max(0, Math.min(120_000, Math.round(value)));
}

function minuteBucket(value: number): number {
  return Math.floor(value / MINUTE_MS) * MINUTE_MS;
}

function divide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
