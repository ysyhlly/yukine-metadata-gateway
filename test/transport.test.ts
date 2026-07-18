import assert from "node:assert/strict";
import test from "node:test";
import { JsonFetchTransport } from "../src/transport.js";
import type { CacheEntry, UpstreamJsonCache } from "../src/types.js";

test("singleflight coalesces one hundred identical cache misses", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ ok: true });
  };
  const transport = new JsonFetchTransport({
    musicBrainzIntervalMs: 0,
    memoryMaxEntries: 0
  });

  const results = await Promise.all(Array.from({ length: 100 }, () =>
    transport.getJson("https://itunes.apple.com/search?term=Song", {
      Accept: "application/json"
    })
  ));

  assert.equal(calls, 1);
  assert.equal(results.every((result) => result.kind === "success"), true);
  assert.equal(transport.pendingRequests(), 0);
});

test("canceling one singleflight follower does not cancel the shared request", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let releaseFetch = (): void => {};
  globalThis.fetch = async () => {
    await new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    return Response.json({ ok: true });
  };
  const transport = new JsonFetchTransport({ memoryMaxEntries: 0 });
  const first = new AbortController();
  const second = new AbortController();
  const firstResult = transport.getJson("https://itunes.apple.com/search?term=Song", {}, first.signal);
  const secondResult = transport.getJson(
    "https://itunes.apple.com/search?term=Song",
    {},
    second.signal
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const inFlight = transport.runtimeStats();
  assert.equal(inFlight.singleflight.flights, 1);
  assert.equal(inFlight.singleflight.waiters, 2);
  assert.equal(inFlight.providers.find((provider) => provider.name === "itunes")?.active, 1);
  assert.equal(inFlight.providers.find((provider) => provider.name === "itunes")?.limit, 20);
  first.abort();
  releaseFetch();

  assert.equal((await firstResult).outcome, "aborted");
  assert.equal((await secondResult).kind, "success");
  assert.equal(transport.runtimeStats().singleflight.flights, 0);
  assert.equal(transport.runtimeStats().singleflight.waiters, 0);
});

test("singleflight cancels the shared fetch only after every waiter leaves", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let sharedAborted = false;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      sharedAborted = true;
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
  const transport = new JsonFetchTransport({ memoryMaxEntries: 0 });
  const first = new AbortController();
  const second = new AbortController();
  const url = "https://itunes.apple.com/search?term=all-abort";
  const left = transport.getJson(url, {}, first.signal);
  const right = transport.getJson(url, {}, second.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));

  first.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sharedAborted, false);
  second.abort();

  assert.equal((await left).outcome, "aborted");
  assert.equal((await right).outcome, "aborted");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sharedAborted, true);
  assert.equal(transport.pendingRequests(), 0);
});

test("singleflight removes failed entries so a later request can retry", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("network unavailable");
    return Response.json({ recovered: true });
  };
  const transport = new JsonFetchTransport({ memoryMaxEntries: 0 });
  const url = "https://itunes.apple.com/search?term=retry";

  const failed = await transport.getJson(url, {});
  const recovered = await transport.getJson(url, {});

  assert.equal(failed.outcome, "network");
  assert.equal(recovered.kind, "success");
  assert.equal(calls, 2);
  assert.equal(transport.pendingRequests(), 0);
});

test("provider timeout is classified and clears pending state", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("timeout", "AbortError"));
    }, { once: true });
  });
  const transport = new JsonFetchTransport({
    timeoutMs: 5,
    memoryMaxEntries: 0,
    providerPolicies: { itunes: { timeoutMs: 5 } }
  });

  const response = await transport.getJson(
    "https://itunes.apple.com/search?term=timeout",
    {}
  );

  assert.equal(response.outcome, "timeout");
  assert.equal(transport.pendingRequests(), 0);
});

test("stale cache returns immediately and schedules one refresh", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const cache = new FixtureCache({
    body: JSON.stringify({ stale: true }),
    freshness: "stale",
    freshUntil: 1,
    staleUntil: Date.now() + 60_000
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ fresh: true });
  };
  const deferred: Promise<void>[] = [];
  const transport = new JsonFetchTransport({
    cache,
    cacheLayer: "sqlite",
    memoryMaxEntries: 0
  });

  const result = await transport.getJson(
    "https://itunes.apple.com/search?term=Song",
    {},
    undefined,
    { defer: (task) => deferred.push(task) }
  );
  await Promise.all(deferred);

  assert.equal(result.kind, "success");
  assert.equal(result.cacheState, "stale");
  assert.equal(result.cacheLayer, "sqlite");
  assert.equal(calls, 1);
  assert.equal(cache.puts, 1);
});

test("provider circuit breaker opens after configured failures", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("failure", { status: 503 });
  };
  const transport = new JsonFetchTransport({
    memoryMaxEntries: 0,
    providerPolicies: {
      itunes: { failureThreshold: 2, failureWindowMs: 60_000, openMs: 30_000 }
    }
  });

  await transport.getJson("https://itunes.apple.com/search?term=one", {});
  await transport.getJson("https://itunes.apple.com/search?term=two", {});
  const blocked = await transport.getJson("https://itunes.apple.com/search?term=three", {});

  assert.equal(calls, 2);
  assert.equal(blocked.outcome, "circuit_open");
  assert.equal(transport.health().find((item) => item.name === "itunes")?.state, "open");
});

test("provider circuit breaker permits one half-open probe and closes on success", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("failure", { status: 503 })
      : Response.json({ recovered: true });
  };
  const transport = new JsonFetchTransport({
    memoryMaxEntries: 0,
    providerPolicies: {
      itunes: { failureThreshold: 1, failureWindowMs: 60_000, openMs: 5 }
    }
  });
  const first = await transport.getJson("https://itunes.apple.com/search?term=one", {});
  const blocked = await transport.getJson("https://itunes.apple.com/search?term=two", {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  const probe = await transport.getJson("https://itunes.apple.com/search?term=three", {});

  assert.equal(first.kind, "failure");
  assert.equal(blocked.outcome, "circuit_open");
  assert.equal(probe.kind, "success");
  assert.equal(calls, 2);
  assert.equal(transport.health().find((item) => item.name === "itunes")?.state, "closed");
});

class FixtureCache implements UpstreamJsonCache {
  puts = 0;

  constructor(private entry: CacheEntry | null) {}

  get(): CacheEntry | null {
    return this.entry;
  }

  put(_url: string, body: string, now: number): void {
    this.puts += 1;
    this.entry = {
      body,
      freshness: "fresh",
      freshUntil: now + 1_000,
      staleUntil: now + 2_000
    };
  }

  close(): void {}
}
