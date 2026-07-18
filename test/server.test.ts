import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RequestConcurrencyLimiter,
  RequestRateLimiter,
  startNodeGateway
} from "../src/node/server.js";

test("Node request concurrency limiter rejects work above its configured maximum", () => {
  const limiter = new RequestConcurrencyLimiter(2);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.activeRequests, 2);
  assert.equal(limiter.tryAcquire(), false);
  limiter.release();
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.activeRequests, 2);
});

test("Node request rate limiter enforces a fixed per-second maximum", () => {
  const limiter = new RequestRateLimiter(2);
  assert.equal(limiter.tryAcquire(1_000), true);
  assert.equal(limiter.tryAcquire(1_500), true);
  assert.equal(limiter.requestsInCurrentWindow, 2);
  assert.equal(limiter.tryAcquire(1_999), false);
  assert.equal(limiter.tryAcquire(2_000), true);
  assert.equal(limiter.requestsInCurrentWindow, 1);
});

test("Node adapter serves the shared health and method contracts", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "yukine-gateway-server-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const runtime = startNodeGateway({
    host: "127.0.0.1",
    port: 0,
    cacheDbPath: join(directory, "cache.sqlite"),
    cacheTtlSeconds: 3_600,
    cacheMaxEntries: 10_000,
    upstreamTimeoutMs: 500,
    requestTimeoutMs: 1_000,
    maxConcurrentRequests: 500,
    maxRequestsPerSecond: 500,
    appUserAgent: "GatewayServerTest/1.0"
  });
  if (!runtime.server.listening) await once(runtime.server, "listening");
  const address = runtime.server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    runtime: "node",
    cache: "sqlite",
    acoustid: false
  });

  const method = await fetch(`${origin}/health`, { method: "POST" });
  assert.equal(method.status, 405);
  assert.deepEqual(await method.json(), { error: "method_not_allowed" });

  runtime.close();
  await once(runtime.server, "close");
});
