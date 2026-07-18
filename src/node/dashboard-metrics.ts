import type { RequestTrace } from "../types.js";
import {
  type RequestMetricRow,
  type UpstreamMetricRow
} from "./dashboard-store.js";
import type { DashboardStoreAdapter } from "./dashboard-store-adapter.js";

const MINUTE_MS = 60_000;
const LATENCY_THRESHOLDS = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const WINDOWS = {
  "15m": 15 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
  "24h": 24 * 60 * MINUTE_MS
} as const;

export type DashboardWindow = keyof typeof WINDOWS;

export interface CacheStats {
  entries: number;
  maxEntries: number;
}

export interface DashboardMetricsOptions {
  retentionDays: number;
  cacheStats: () => CacheStats;
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

export class DashboardMetrics {
  private readonly requestRows = new Map<string, RequestMetricRow>();
  private readonly upstreamRows = new Map<string, UpstreamMetricRow>();
  private readonly startedAt = Date.now();
  private readonly timer: NodeJS.Timeout;
  private lastCleanupAt = 0;
  private flushTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: DashboardStoreAdapter,
    private readonly options: DashboardMetricsOptions
  ) {
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, 1_000);
    this.timer.unref();
  }

  record(
    route: string,
    status: number,
    durationMs: number,
    trace: RequestTrace,
    now = Date.now()
  ): void {
    if (!route.startsWith("/v1/") && !route.startsWith("/v2/")) return;
    const bucketStartMs = Math.floor(now / MINUTE_MS) * MINUTE_MS;
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
        latencyBuckets: Array.from({ length: LATENCY_THRESHOLDS.length + 1 }, () => 0)
      };
      this.requestRows.set(requestKey, requestRow);
    }
    const boundedDuration = Math.max(0, Math.min(120_000, Math.round(durationMs)));
    requestRow.requests += 1;
    requestRow.cacheHits += trace.cacheHit ? 1 : 0;
    requestRow.upstreamRequests += trace.upstream.length > 0 ? 1 : 0;
    requestRow.upstreamAttempts += trace.upstream.length;
    requestRow.durationSumMs += boundedDuration;
    requestRow.durationMaxMs = Math.max(requestRow.durationMaxMs, boundedDuration);
    for (let index = 0; index < LATENCY_THRESHOLDS.length; index += 1) {
      if (boundedDuration <= LATENCY_THRESHOLDS[index]!) {
        requestRow.latencyBuckets[index] = (requestRow.latencyBuckets[index] || 0) + 1;
      }
    }
    if (boundedDuration > LATENCY_THRESHOLDS.at(-1)!) {
      requestRow.latencyBuckets[LATENCY_THRESHOLDS.length] =
        (requestRow.latencyBuckets[LATENCY_THRESHOLDS.length] || 0) + 1;
    }

    for (const attempt of trace.upstream) {
      const outcome = upstreamOutcome(attempt.status, attempt.outcome);
      const upstreamKey = [bucketStartMs, route, attempt.host, outcome].join("\u0000");
      let upstreamRow = this.upstreamRows.get(upstreamKey);
      if (!upstreamRow) {
        upstreamRow = { bucketStartMs, route, host: attempt.host, outcome, attempts: 0 };
        this.upstreamRows.set(upstreamKey, upstreamRow);
      }
      upstreamRow.attempts += 1;
    }

    if (this.requestRows.size + this.upstreamRows.size >= 100) {
      void this.flush(now).catch(() => {});
    }
  }

  async snapshot(window: DashboardWindow, now = Date.now()) {
    await this.flush(now);
    const windowMs = WINDOWS[window];
    const since = Math.floor((now - windowMs) / MINUTE_MS) * MINUTE_MS;
    const requestRows = await this.store.readRequestMetrics(since);
    const upstreamRows = await this.store.readUpstreamSummary(since);
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

    const upstreamByHost = new Map<string, { success: number; notFound: number; failure: number }>();
    let upstreamAttempts = 0;
    let upstreamFailures = 0;
    for (const row of upstreamRows) {
      const host = upstreamByHost.get(row.host) || { success: 0, notFound: 0, failure: 0 };
      if (row.outcome === "success") host.success += row.attempts;
      else if (row.outcome === "not_found") host.notFound += row.attempts;
      else {
        host.failure += row.attempts;
        upstreamFailures += row.attempts;
      }
      upstreamAttempts += row.attempts;
      upstreamByHost.set(row.host, host);
    }

    const cache = this.options.cacheStats();
    return {
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
        fanOut: divide(overall.upstreamAttempts, overall.requests)
      },
      trend: [...trendAggregates.entries()].map(([bucketStartMs, aggregate]) => ({
        bucketStartMs,
        requests: aggregate.requests,
        errors: aggregate.errors,
        cacheHitRate: divide(aggregate.cacheHits, aggregate.upstreamRequests),
        latencyP95Ms: percentile(aggregate, 0.95)
      })),
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
      runtime: {
        startedAt: this.startedAt,
        uptimeSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1_000)),
        cacheEntries: cache.entries,
        cacheMaxEntries: cache.maxEntries
      },
      definitions: {
        scope: "仅统计 Node 运行时的 /v1/* 与 /v2/* 业务请求；健康探针和面板流量已排除。",
        availability: "1 − 5xx 请求数 ÷ 总请求数。",
        cacheHitRate: "至少一次上游读取命中 SQLite 的请求 ÷ 存在上游尝试的请求。",
        upstreamAvailability: "1 − 上游失败尝试数 ÷ 上游总尝试数；已知 404 视为可达。",
        latency: "Node 处理请求的端到端耗时；分位数由固定直方图区间近似。"
      }
    };
  }

  flush(now = Date.now()): Promise<void> {
    const requests = [...this.requestRows.values()];
    const upstream = [...this.upstreamRows.values()];
    this.requestRows.clear();
    this.upstreamRows.clear();
    const cleanup = now - this.lastCleanupAt >= 5 * MINUTE_MS;
    if (cleanup) this.lastCleanupAt = now;
    this.flushTail = this.flushTail.then(async () => {
      if (requests.length || upstream.length) {
        await this.store.writeMetrics(requests, upstream);
      }
      if (cleanup) await this.store.cleanup(now);
    });
    return this.flushTail;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
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
    latencyBuckets: Array.from({ length: LATENCY_THRESHOLDS.length + 1 }, () => 0)
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
  for (let index = 0; index < target.latencyBuckets.length; index += 1) {
    target.latencyBuckets[index] =
      (target.latencyBuckets[index] || 0) + (row.latencyBuckets[index] || 0);
  }
}

function percentile(aggregate: Aggregate, quantile: number): number | null {
  if (aggregate.requests === 0) return null;
  const target = Math.ceil(aggregate.requests * quantile);
  for (let index = 0; index < LATENCY_THRESHOLDS.length; index += 1) {
    if ((aggregate.latencyBuckets[index] || 0) >= target) return LATENCY_THRESHOLDS[index]!;
  }
  return aggregate.durationMaxMs;
}

function divide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
