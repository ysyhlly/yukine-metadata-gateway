import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresDashboardStore } from "../src/node/postgres-dashboard-store.js";
import { RedisJsonCache } from "../src/node/redis-cache.js";
import { JsonFetchTransport } from "../src/transport.js";

const redisUrl = required(process.env.TEST_REDIS_URL, "TEST_REDIS_URL");
const databaseUrl = required(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL");

test("two transport replicas share Redis cache and refresh leases", async (context) => {
  const prefix = `yukine:test:${randomUUID()}:`;
  const firstCache = new RedisJsonCache({
    url: redisUrl,
    ttlSeconds: 60,
    staleSeconds: 60,
    keyPrefix: prefix
  });
  const secondCache = new RedisJsonCache({
    url: redisUrl,
    ttlSeconds: 60,
    staleSeconds: 60,
    keyPrefix: prefix
  });
  context.after(async () => {
    await Promise.all([firstCache.close(), secondCache.close()]);
  });
  assert.equal(await firstCache.ready(), true);
  assert.equal(await secondCache.ready(), true);

  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return Response.json({ shared: true });
  };
  const first = new JsonFetchTransport({
    cache: firstCache,
    coordinator: firstCache,
    cacheLayer: "redis",
    memoryMaxEntries: 0
  });
  const second = new JsonFetchTransport({
    cache: secondCache,
    coordinator: secondCache,
    cacheLayer: "redis",
    memoryMaxEntries: 0
  });
  const url = "https://itunes.apple.com/search?term=distributed";

  const [left, right] = await Promise.all([
    first.getJson(url, {}),
    second.getJson(url, {})
  ]);

  assert.equal(left.kind, "success");
  assert.equal(right.kind, "success");
  assert.equal([left.cacheLayer, right.cacheLayer].includes("redis"), true);
  assert.equal(calls, 1);
});

test("PostgreSQL dashboard schema persists shared minute metrics", async (context) => {
  const store = new PostgresDashboardStore({
    url: databaseUrl,
    sessionIdleMs: 30 * 60_000,
    sessionAbsoluteMs: 8 * 60 * 60_000,
    metricsRetentionMs: 30 * 24 * 60 * 60_000
  });
  context.after(() => store.close());
  await store.initialize();
  assert.equal(await store.ready(), true);
  const route = `/v2/integration/${randomUUID()}`;
  const instanceId = `integration-${randomUUID()}`;
  const bucketStartMs = Math.floor(Date.now() / 60_000) * 60_000;
  await store.writeMetrics([{
    bucketStartMs,
    route,
    status: 200,
    requests: 1,
    cacheHits: 1,
    upstreamRequests: 1,
    upstreamAttempts: 1,
    durationSumMs: 10,
    durationMaxMs: 10,
    latencyBuckets: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]
  }], [{
    bucketStartMs,
    route,
    host: "integration.example",
    outcome: "success",
    attempts: 1
  }]);
  await store.writeProviderMetrics([{
    bucketStartMs,
    route,
    provider: "itunes",
    host: "itunes.apple.com",
    outcome: "success",
    cacheState: "fresh",
    cacheLayer: "redis",
    attempts: 1,
    durationSumMs: 10,
    durationMaxMs: 10,
    latencyBuckets: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]
  }]);
  await store.writeRuntimeSamples({
    bucketStartMs,
    instanceId,
    heartbeatAt: Date.now(),
    version: "1.0.0",
    revision: "integration",
    runtime: "node",
    stateBackend: "external",
    ready: true,
    startedAt: Date.now() - 10_000,
    uptimeSeconds: 10,
    l1Entries: 1,
    l1MaxEntries: 1_000,
    l2Layer: "redis",
    l2Entries: null,
    l2MaxEntries: null,
    l2Connected: true,
    singleflightFlights: 1,
    singleflightWaiters: 2,
    ingressActive: 1,
    ingressLimit: 500,
    requestsThisSecond: 2,
    rateLimit: 500
  }, [{
    bucketStartMs,
    instanceId,
    provider: "itunes",
    state: "half_open",
    recentFailures: 10,
    openedAt: Date.now() - 1_000,
    active: 1,
    queued: 0,
    limit: 20
  }]);

  const rows = await store.readRequestMetrics(bucketStartMs);
  assert.equal(rows.some((row) => row.route === route && row.requests === 1), true);
  assert.equal(
    (await store.readProviderMetrics(bucketStartMs))
      .some((row) => row.route === route && row.cacheLayer === "redis"),
    true
  );
  assert.equal(
    (await store.readRuntimeSamples(bucketStartMs))
      .some((row) => row.instanceId === instanceId && row.l2Entries === null),
    true
  );
  assert.equal(
    (await store.readProviderHealth(bucketStartMs))
      .some((row) => row.instanceId === instanceId && row.state === "half_open"),
    true
  );

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  context.after(() => pool.end());
  await pool.query("DELETE FROM dashboard_request_minute WHERE route = $1", [route]);
  await pool.query("DELETE FROM dashboard_upstream_minute WHERE route = $1", [route]);
  await pool.query("DELETE FROM dashboard_provider_minute WHERE route = $1", [route]);
  await pool.query("DELETE FROM dashboard_runtime_sample WHERE instance_id = $1", [instanceId]);
  await pool.query(
    "DELETE FROM dashboard_provider_health_sample WHERE instance_id = $1",
    [instanceId]
  );
});

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for external integration tests`);
  return value;
}
