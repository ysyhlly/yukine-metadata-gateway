import {
  DEFAULT_PROVIDER_POLICIES,
  providerForUrl,
  type DistributedProviderCoordinator,
  type ProviderName,
  type ProviderPassiveHealth,
  type ProviderPolicy
} from "./providers/types.js";
import type {
  CacheEntry,
  CacheLayer,
  UpstreamJsonCache,
  UpstreamJsonResult,
  UpstreamOutcome,
  UpstreamRequestOptions,
  UpstreamTransport
} from "./types.js";

const MUSICBRAINZ_HOST = "musicbrainz.org";
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MEMORY_ENTRIES = 1_000;
const DEFAULT_FRESH_MS = 3_600_000;
const DEFAULT_STALE_MS = 86_400_000;

export interface JsonFetchTransportOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  musicBrainzIntervalMs?: number;
  cloudflareCache?: boolean;
  cache?: UpstreamJsonCache;
  memoryMaxEntries?: number;
  freshMs?: number;
  staleMs?: number;
  providerPolicies?: Partial<Record<ProviderName, Partial<ProviderPolicy>>>;
  coordinator?: DistributedProviderCoordinator;
  cacheLayer?: Exclude<CacheLayer, "memory" | "none">;
}

export interface ProviderRuntimeStats extends ProviderPassiveHealth {
  active: number;
  queued: number;
  limit: number;
}

export interface TransportRuntimeStats {
  memory: { entries: number; maxEntries: number };
  singleflight: { flights: number; waiters: number };
  providers: ProviderRuntimeStats[];
}

interface SharedFlight {
  controller: AbortController;
  promise: Promise<UpstreamJsonResult>;
  waiters: number;
  settled: boolean;
}

interface MemoryEntry extends CacheEntry {
  touchedAt: number;
}

export class JsonFetchTransport implements UpstreamTransport {
  private readonly timeoutMs?: number;
  private readonly maxResponseBytes: number;
  private readonly musicBrainzIntervalMs: number;
  private readonly cloudflareCache: boolean;
  private readonly cache?: UpstreamJsonCache;
  private readonly memoryMaxEntries: number;
  private readonly freshMs: number;
  private readonly staleMs: number;
  private readonly policies: Record<ProviderName, ProviderPolicy>;
  private readonly coordinator?: DistributedProviderCoordinator;
  private readonly cacheLayer: Exclude<CacheLayer, "memory" | "none">;
  private readonly semaphores = new Map<ProviderName, AsyncSemaphore>();
  private readonly breakers = new Map<ProviderName, CircuitBreaker>();
  private readonly pending = new Map<string, SharedFlight>();
  private readonly memory = new Map<string, MemoryEntry>();
  private musicBrainzTail: Promise<void> = Promise.resolve();
  private nextMusicBrainzAt = 0;

  constructor(options: JsonFetchTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.musicBrainzIntervalMs = options.musicBrainzIntervalMs ?? 1_100;
    this.cloudflareCache = options.cloudflareCache ?? false;
    this.cache = options.cache;
    this.memoryMaxEntries = options.memoryMaxEntries ?? DEFAULT_MEMORY_ENTRIES;
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.policies = mergePolicies(options.providerPolicies);
    this.coordinator = options.coordinator;
    this.cacheLayer = options.cacheLayer
      ?? (this.cloudflareCache ? "cloudflare" : "sqlite");
    for (const [name, policy] of Object.entries(this.policies) as [ProviderName, ProviderPolicy][]) {
      this.semaphores.set(name, new AsyncSemaphore(policy.concurrency));
      this.breakers.set(name, new CircuitBreaker(policy));
    }
  }

  stats(): { entries: number; maxEntries: number } {
    return {
      entries: this.memory.size,
      maxEntries: this.memoryMaxEntries
    };
  }

  runtimeStats(): TransportRuntimeStats {
    return {
      memory: this.stats(),
      singleflight: {
        flights: this.pending.size,
        waiters: [...this.pending.values()].reduce(
          (total, flight) => total + flight.waiters,
          0
        )
      },
      providers: this.health().map((health) => {
        const semaphore = this.semaphores.get(health.name)?.stats()
          ?? { active: 0, queued: 0, limit: this.policies[health.name].concurrency };
        return { ...health, ...semaphore };
      })
    };
  }

  async getJson(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
    options: UpstreamRequestOptions = {}
  ): Promise<UpstreamJsonResult> {
    const startedAt = Date.now();
    const host = safeHost(url);
    const provider = asProvider(options.provider) ?? providerForUrl(url);
    const now = Date.now();
    const memoryEntry = this.memoryGet(url, now);
    if (memoryEntry) {
      const cached = this.cachedResult(
        memoryEntry,
        host,
        provider,
        startedAt,
        "memory"
      );
      if (cached) {
        if (memoryEntry.freshness === "stale") {
          this.deferRefresh(url, headers, provider, options);
        }
        return cached;
      }
    }

    const stored = await this.cache?.get(url, now);
    if (stored) {
      this.memoryPut(url, stored);
      const cached = this.cachedResult(
        stored,
        host,
        provider,
        startedAt,
        this.cacheLayer
      );
      if (cached) {
        if (stored.freshness === "stale") {
          this.deferRefresh(url, headers, provider, options);
        }
        return cached;
      }
      await this.cache?.delete?.(url);
    }

    return this.coordinatedFetch(url, headers, provider, signal, true);
  }

  health(): ProviderPassiveHealth[] {
    return (Object.keys(this.policies) as ProviderName[])
      .filter((name) => name !== "unknown")
      .map((name) => this.breakers.get(name)?.health(name) ?? {
        name,
        state: "closed",
        recentFailures: 0
      });
  }

  pendingRequests(): number {
    return this.pending.size;
  }

  private cachedResult(
    entry: CacheEntry,
    host: string,
    provider: ProviderName,
    startedAt: number,
    cacheLayer: CacheLayer
  ): UpstreamJsonResult | null {
    try {
      return {
        kind: "success",
        data: JSON.parse(entry.body),
        status: 200,
        host,
        provider,
        cacheHit: true,
        cacheState: entry.freshness,
        cacheLayer,
        durationMs: Date.now() - startedAt,
        outcome: "success"
      };
    } catch {
      return null;
    }
  }

  private deferRefresh(
    url: string,
    headers: Record<string, string>,
    provider: ProviderName,
    options: UpstreamRequestOptions
  ): void {
    const task = this.coordinatedFetch(url, headers, provider, undefined, false)
      .then(() => undefined)
      .catch(() => undefined);
    if (options.defer) {
      options.defer(task);
    } else {
      void task;
    }
  }

  private async coordinatedFetch(
    url: string,
    headers: Record<string, string>,
    provider: ProviderName,
    signal: AbortSignal | undefined,
    waitForPeer: boolean
  ): Promise<UpstreamJsonResult> {
    if (!this.cache?.acquireRefreshLease) {
      return this.sharedFetch(url, headers, provider, signal);
    }
    let release: (() => void | Promise<void>) | null;
    try {
      const timeout = this.timeoutMs ?? this.policies[provider].timeoutMs;
      release = await this.cache.acquireRefreshLease(url, timeout + 2_000);
    } catch {
      return this.sharedFetch(url, headers, provider, signal);
    }
    if (release) {
      try {
        return await this.sharedFetch(url, headers, provider, signal);
      } finally {
        await release();
      }
    }
    if (!waitForPeer) {
      return failureResult(url, provider, "circuit_open", 0, 0);
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !signal?.aborted) {
      await abortableDelay(50, signal);
      const entry = await this.cache.get(url, Date.now());
      if (entry?.freshness === "fresh") {
        this.memoryPut(url, entry);
        const cached = this.cachedResult(
          entry,
          safeHost(url),
          provider,
          Date.now(),
          this.cacheLayer
        );
        if (cached) return cached;
      }
    }
    return this.sharedFetch(url, headers, provider, signal);
  }

  private async sharedFetch(
    url: string,
    headers: Record<string, string>,
    provider: ProviderName,
    signal?: AbortSignal
  ): Promise<UpstreamJsonResult> {
    const key = await requestKey(provider, url, headers);
    let flight = this.pending.get(key);
    if (!flight) {
      const controller = new AbortController();
      flight = {
        controller,
        waiters: 0,
        settled: false,
        promise: Promise.resolve(failureResult(url, provider, "network", 0, 0))
      };
      flight.promise = this.fetchAndCache(url, headers, provider, controller.signal)
        .finally(() => {
          flight!.settled = true;
          this.pending.delete(key);
        });
      this.pending.set(key, flight);
    }
    return subscribe(flight, signal);
  }

  private async fetchAndCache(
    url: string,
    headers: Record<string, string>,
    provider: ProviderName,
    signal: AbortSignal
  ): Promise<UpstreamJsonResult> {
    const result = await this.fetchFromUpstream(url, headers, provider, signal);
    if (result.kind === "success") {
      const now = Date.now();
      const entry: CacheEntry = {
        body: JSON.stringify(result.data),
        freshness: "fresh",
        freshUntil: safeAdd(now, this.freshMs),
        staleUntil: safeAdd(now, this.freshMs + this.staleMs)
      };
      this.memoryPut(url, entry);
      await this.cache?.put(url, entry.body, now);
    }
    return result;
  }

  private async fetchFromUpstream(
    url: string,
    headers: Record<string, string>,
    provider: ProviderName,
    signal: AbortSignal
  ): Promise<UpstreamJsonResult> {
    const startedAt = Date.now();
    const host = safeHost(url);
    const policy = this.policies[provider];
    const breaker = this.breakers.get(provider)!;
    if (!breaker.tryAcquire(startedAt)) {
      return failureResult(url, provider, "circuit_open", 0, Date.now() - startedAt);
    }

    let release = (): void => {};
    let distributedRelease = (): void | Promise<void> => {};
    try {
      if (this.coordinator) {
        const acquired = await this.coordinator.acquire(provider, policy, signal);
        if (!acquired) {
          return failureResult(url, provider, "circuit_open", 0, Date.now() - startedAt);
        }
        distributedRelease = acquired;
      }
      release = await this.semaphores.get(provider)!.acquire(signal);
      await this.waitForMusicBrainz(host, signal);
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs ?? policy.timeoutMs);
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      try {
        const init: RequestInit & { cf?: { cacheTtl: number; cacheEverything: boolean } } = {
          headers,
          signal: controller.signal
        };
        if (this.cloudflareCache) {
          init.cf = { cacheTtl: 3_600, cacheEverything: true };
        }
        const response = await fetch(url, init);
        const durationMs = Date.now() - startedAt;
        if (response.status === 404) {
          const result: UpstreamJsonResult = {
            kind: "not_found",
            status: 404,
            host,
            provider,
            cacheHit: false,
            cacheState: "miss",
            cacheLayer: "none",
            durationMs,
            outcome: "not_found"
          };
          await this.recordProviderResult(provider, result);
          return result;
        }
        if (!response.ok) {
          const result = failureResult(url, provider, "http", response.status, durationMs);
          await this.recordProviderResult(provider, result);
          return result;
        }
        let body: string;
        try {
          body = await readBoundedBody(response, this.maxResponseBytes);
        } catch (error) {
          const outcome = error instanceof ResponseTooLargeError
            ? "response_too_large"
            : "network";
          const result = failureResult(
            url,
            provider,
            outcome,
            response.status,
            Date.now() - startedAt
          );
          await this.recordProviderResult(provider, result);
          return result;
        }
        try {
          const data = JSON.parse(body);
          const result: UpstreamJsonResult = {
            kind: "success",
            data,
            status: response.status,
            host,
            provider,
            cacheHit: false,
            cacheState: "miss",
            cacheLayer: "none",
            durationMs: Date.now() - startedAt,
            outcome: "success"
          };
          await this.recordProviderResult(provider, result);
          return result;
        } catch {
          const result = failureResult(
            url,
            provider,
            "parse",
            response.status,
            Date.now() - startedAt
          );
          await this.recordProviderResult(provider, result);
          return result;
        }
      } catch {
        const outcome: UpstreamOutcome = timedOut
          ? "timeout"
          : signal.aborted
            ? "aborted"
            : "network";
        const result = failureResult(
          url,
          provider,
          outcome,
          0,
          Date.now() - startedAt
        );
        await this.recordProviderResult(provider, result);
        return result;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
    } catch {
      const result = failureResult(
        url,
        provider,
        signal.aborted ? "aborted" : "network",
        0,
        Date.now() - startedAt
      );
      await this.recordProviderResult(provider, result);
      return result;
    } finally {
      release();
      await distributedRelease();
    }
  }

  private async recordProviderResult(
    provider: ProviderName,
    result: UpstreamJsonResult
  ): Promise<void> {
    const breaker = this.breakers.get(provider)!;
    if (result.kind === "success" || result.kind === "not_found") {
      breaker.recordReachable();
    } else {
      breaker.recordResult(result);
    }
    await this.coordinator?.record(provider, this.policies[provider], result);
  }

  private memoryGet(url: string, now: number): MemoryEntry | null {
    const entry = this.memory.get(url);
    if (!entry) return null;
    if (entry.staleUntil <= now) {
      this.memory.delete(url);
      return null;
    }
    entry.freshness = entry.freshUntil > now ? "fresh" : "stale";
    entry.touchedAt = now;
    this.memory.delete(url);
    this.memory.set(url, entry);
    return entry;
  }

  private memoryPut(url: string, entry: CacheEntry): void {
    if (this.memoryMaxEntries <= 0) return;
    this.memory.delete(url);
    this.memory.set(url, { ...entry, touchedAt: Date.now() });
    while (this.memory.size > this.memoryMaxEntries) {
      const oldest = this.memory.keys().next().value;
      if (typeof oldest !== "string") break;
      this.memory.delete(oldest);
    }
  }

  private async waitForMusicBrainz(host: string, signal?: AbortSignal): Promise<void> {
    if (host !== MUSICBRAINZ_HOST) return;
    let release = (): void => {};
    const previous = this.musicBrainzTail;
    this.musicBrainzTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.nextMusicBrainzAt - Date.now());
      if (waitMs > 0) await abortableDelay(waitMs, signal);
      this.nextMusicBrainzAt = Date.now() + this.musicBrainzIntervalMs;
    } finally {
      release();
    }
  }
}

class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: () => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(private readonly maximum: number) {}

  stats(): { active: number; queued: number; limit: number } {
    return {
      active: this.active,
      queued: this.queue.length,
      limit: this.maximum
    };
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    return new Promise((resolve, reject) => {
      const item = {
        resolve,
        reject: () => reject(new Error("aborted")),
        signal,
        abort: undefined as (() => void) | undefined
      };
      item.abort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        item.reject();
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item);
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.abort!);
        next.resolve(this.releaseFunction());
      } else {
        this.active = Math.max(0, this.active - 1);
      }
    };
  }
}

class CircuitBreaker {
  private state: "closed" | "open" | "half_open" = "closed";
  private failures: number[] = [];
  private openedAt?: number;
  private halfOpenProbe = false;

  constructor(private readonly policy: ProviderPolicy) {}

  tryAcquire(now: number): boolean {
    this.prune(now);
    if (this.state === "open") {
      if (!this.openedAt || now - this.openedAt < this.policy.openMs) return false;
      this.state = "half_open";
      this.halfOpenProbe = false;
    }
    if (this.state === "half_open") {
      if (this.halfOpenProbe) return false;
      this.halfOpenProbe = true;
    }
    return true;
  }

  recordReachable(): void {
    this.state = "closed";
    this.failures = [];
    this.openedAt = undefined;
    this.halfOpenProbe = false;
  }

  recordResult(result: UpstreamJsonResult): void {
    if (result.kind !== "failure" || !countsForBreaker(result)) {
      if (result.outcome !== "aborted") this.recordReachable();
      return;
    }
    const now = Date.now();
    this.prune(now);
    if (this.state === "half_open") {
      this.open(now);
      return;
    }
    this.failures.push(now);
    if (this.failures.length >= this.policy.failureThreshold) this.open(now);
  }

  health(name: ProviderName): ProviderPassiveHealth {
    this.prune(Date.now());
    return {
      name,
      state: this.state,
      recentFailures: this.failures.length,
      ...(this.openedAt ? { openedAt: this.openedAt } : {})
    };
  }

  private open(now: number): void {
    this.state = "open";
    this.openedAt = now;
    this.halfOpenProbe = false;
  }

  private prune(now: number): void {
    const cutoff = now - this.policy.failureWindowMs;
    this.failures = this.failures.filter((value) => value >= cutoff);
  }
}

class ResponseTooLargeError extends Error {}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > maxBytes) throw new ResponseTooLargeError("upstream_response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const value = await reader.read();
    if (value.done) break;
    size += value.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError("upstream_response_too_large");
    }
    chunks.push(value.value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "invalid";
  }
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value;
  }
}

async function requestKey(
  provider: ProviderName,
  url: string,
  headers: Record<string, string>
): Promise<string> {
  const relevantHeaders = Object.entries(headers)
    .filter(([name]) => ["accept", "user-agent"].includes(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name.toLowerCase()}:${value}`)
    .join("\n");
  const input = new TextEncoder().encode(`${provider}\n${canonicalUrl(url)}\n${relevantHeaders}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function subscribe(flight: SharedFlight, signal?: AbortSignal): Promise<UpstreamJsonResult> {
  flight.waiters += 1;
  if (!signal) {
    return flight.promise.finally(() => releaseWaiter(flight));
  }
  if (signal.aborted) {
    releaseWaiter(flight);
    return Promise.resolve(abortedResult());
  }
  return new Promise((resolve) => {
    let completed = false;
    const finish = (value: UpstreamJsonResult) => {
      if (completed) return;
      completed = true;
      signal.removeEventListener("abort", abort);
      releaseWaiter(flight);
      resolve(value);
    };
    const abort = () => finish(abortedResult());
    signal.addEventListener("abort", abort, { once: true });
    void flight.promise.then(finish, () => finish(abortedResult()));
  });
}

function releaseWaiter(flight: SharedFlight): void {
  flight.waiters = Math.max(0, flight.waiters - 1);
  if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
}

function abortedResult(): UpstreamJsonResult {
  return {
    kind: "failure",
    status: 0,
    host: "shared",
    provider: "unknown",
    cacheHit: false,
    cacheState: "miss",
    cacheLayer: "none",
    durationMs: 0,
    outcome: "aborted"
  };
}

function failureResult(
  url: string,
  provider: string,
  outcome: Exclude<UpstreamOutcome, "success" | "not_found">,
  status: number,
  durationMs: number
): UpstreamJsonResult {
  return {
    kind: "failure",
    status,
    host: safeHost(url),
    provider,
    cacheHit: false,
    cacheState: "miss",
    cacheLayer: "none",
    durationMs,
    outcome
  };
}

function countsForBreaker(result: Extract<UpstreamJsonResult, { kind: "failure" }>): boolean {
  return result.outcome === "timeout"
    || result.outcome === "network"
    || result.status === 429
    || result.status >= 500;
}

function mergePolicies(
  overrides: JsonFetchTransportOptions["providerPolicies"]
): Record<ProviderName, ProviderPolicy> {
  return Object.fromEntries(
    (Object.entries(DEFAULT_PROVIDER_POLICIES) as [ProviderName, ProviderPolicy][])
      .map(([name, policy]) => [name, { ...policy, ...overrides?.[name] }])
  ) as Record<ProviderName, ProviderPolicy>;
}

function asProvider(value: string | undefined): ProviderName | undefined {
  return value && value in DEFAULT_PROVIDER_POLICIES ? value as ProviderName : undefined;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(complete, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function safeAdd(value: number, delta: number): number {
  return Number.MAX_SAFE_INTEGER - value < delta ? Number.MAX_SAFE_INTEGER : value + delta;
}
