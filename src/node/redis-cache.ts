import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { CacheEntry, UpstreamJsonCache } from "../types.js";
import type { UpstreamJsonResult } from "../types.js";
import type {
  DistributedProviderCoordinator,
  ProviderName,
  ProviderPolicy
} from "../providers/types.js";

export interface RedisJsonCacheOptions {
  url: string;
  ttlSeconds: number;
  staleSeconds: number;
  keyPrefix?: string;
}

interface StoredCacheEntry {
  body: string;
  freshUntil: number;
  staleUntil: number;
}

export class RedisJsonCache implements UpstreamJsonCache, DistributedProviderCoordinator {
  private readonly client: Redis;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly prefix: string;
  private connected = false;

  constructor(options: RedisJsonCacheOptions) {
    this.ttlMs = options.ttlSeconds * 1_000;
    this.staleMs = options.staleSeconds * 1_000;
    this.prefix = options.keyPrefix || "yukine:metadata:";
    this.client = new Redis(options.url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000
    });
    this.client.on("error", () => {
      this.connected = false;
    });
    this.client.on("ready", () => {
      this.connected = true;
    });
  }

  async connect(): Promise<void> {
    if (this.client.status === "wait") await this.client.connect();
    if (this.client.status !== "ready") await this.waitUntilReady();
    this.connected = true;
  }

  async get(url: string, now: number): Promise<CacheEntry | null> {
    await this.ensureConnected();
    const value = await this.client.get(this.cacheKey(url));
    if (!value) return null;
    try {
      const stored = JSON.parse(value) as StoredCacheEntry;
      if (
        typeof stored.body !== "string"
        || !Number.isFinite(stored.freshUntil)
        || !Number.isFinite(stored.staleUntil)
      ) {
        await this.delete(url);
        return null;
      }
      if (stored.staleUntil <= now) {
        await this.delete(url);
        return null;
      }
      return {
        body: stored.body,
        freshness: stored.freshUntil > now ? "fresh" : "stale",
        freshUntil: stored.freshUntil,
        staleUntil: stored.staleUntil
      };
    } catch {
      await this.delete(url);
      return null;
    }
  }

  async put(url: string, body: string, now: number): Promise<void> {
    await this.ensureConnected();
    const freshUntil = safeAdd(now, this.ttlMs);
    const staleUntil = safeAdd(freshUntil, this.staleMs);
    const value: StoredCacheEntry = { body, freshUntil, staleUntil };
    await this.client.set(
      this.cacheKey(url),
      JSON.stringify(value),
      "PX",
      Math.max(1, staleUntil - now)
    );
  }

  async delete(url: string): Promise<void> {
    await this.ensureConnected();
    await this.client.del(this.cacheKey(url));
  }

  async ready(): Promise<boolean> {
    try {
      await this.ensureConnected();
      return await this.client.ping() === "PONG";
    } catch {
      return false;
    }
  }

  async acquireRefreshLease(
    url: string,
    ttlMs: number
  ): Promise<(() => Promise<void>) | null> {
    await this.ensureConnected();
    const key = `${this.prefix}lease:${hash(url)}`;
    const token = randomUUID();
    const acquired = await this.client.set(key, token, "PX", Math.max(1, ttlMs), "NX");
    if (acquired !== "OK") return null;
    return async () => {
      await this.client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then "
          + "return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        token
      );
    };
  }

  async acquire(
    provider: ProviderName,
    policy: ProviderPolicy,
    signal: AbortSignal
  ): Promise<(() => Promise<void>) | null> {
    await this.ensureConnected();
    const token = randomUUID();
    const semaphoreKey = `${this.prefix}provider:${provider}:active`;
    const openKey = `${this.prefix}provider:${provider}:open`;
    const failuresKey = `${this.prefix}provider:${provider}:failures`;
    const probeKey = `${this.prefix}provider:${provider}:probe`;
    const deadline = Date.now() + policy.timeoutMs;
    while (!signal.aborted && Date.now() < deadline) {
      const now = Date.now();
      const result = Number(await this.client.eval(
        "if redis.call('exists', KEYS[1]) == 1 then return -1 end "
          + "redis.call('zremrangebyscore', KEYS[2], '-inf', ARGV[1]) "
          + "local failures = redis.call('zcount', KEYS[3], ARGV[2], '+inf') "
          + "if failures >= tonumber(ARGV[3]) then "
          + "  local probe = redis.call('set', KEYS[4], ARGV[4], 'PX', ARGV[5], 'NX') "
          + "  if not probe then return -1 end "
          + "end "
          + "if redis.call('zcard', KEYS[2]) >= tonumber(ARGV[6]) then return 0 end "
          + "redis.call('zadd', KEYS[2], ARGV[7], ARGV[4]) "
          + "redis.call('pexpire', KEYS[2], ARGV[5]) "
          + "return 1",
        4,
        openKey,
        semaphoreKey,
        failuresKey,
        probeKey,
        now,
        now - policy.failureWindowMs,
        policy.failureThreshold,
        token,
        policy.timeoutMs + 2_000,
        policy.concurrency,
        now + policy.timeoutMs + 2_000
      ));
      if (result === -1) return null;
      if (result === 1) {
        return async () => {
          await this.client.zrem(semaphoreKey, token);
        };
      }
      await delay(25, signal);
    }
    return null;
  }

  async record(
    provider: ProviderName,
    policy: ProviderPolicy,
    result: UpstreamJsonResult
  ): Promise<void> {
    await this.ensureConnected();
    const openKey = `${this.prefix}provider:${provider}:open`;
    const failuresKey = `${this.prefix}provider:${provider}:failures`;
    const probeKey = `${this.prefix}provider:${provider}:probe`;
    if (!countsForBreaker(result)) {
      if (result.outcome !== "aborted") {
        await this.client.del(openKey, failuresKey, probeKey);
      }
      return;
    }
    const now = Date.now();
    const member = `${now}:${randomUUID()}`;
    await this.client.eval(
      "redis.call('zadd', KEYS[1], ARGV[1], ARGV[2]) "
        + "redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[3]) "
        + "redis.call('pexpire', KEYS[1], ARGV[4]) "
        + "local count = redis.call('zcard', KEYS[1]) "
        + "redis.call('del', KEYS[3]) "
        + "if count >= tonumber(ARGV[5]) then "
        + "  redis.call('set', KEYS[2], '1', 'PX', ARGV[6]) "
        + "end "
        + "return count",
      3,
      failuresKey,
      openKey,
      probeKey,
      now,
      member,
      now - policy.failureWindowMs,
      policy.failureWindowMs,
      policy.failureThreshold,
      policy.openMs
    );
  }

  async close(): Promise<void> {
    if (this.client.status === "end") return;
    await this.client.quit().catch(() => this.client.disconnect());
  }

  private cacheKey(url: string): string {
    return `${this.prefix}cache:${hash(url)}`;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected || this.client.status !== "ready") await this.connect();
  }

  private waitUntilReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ready = () => {
        cleanup();
        resolve();
      };
      const error = (cause: Error) => {
        cleanup();
        reject(cause);
      };
      const cleanup = () => {
        this.client.removeListener("ready", ready);
        this.client.removeListener("error", error);
      };
      this.client.once("ready", ready);
      this.client.once("error", error);
    });
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeAdd(value: number, delta: number): number {
  return Number.MAX_SAFE_INTEGER - value < delta ? Number.MAX_SAFE_INTEGER : value + delta;
}

function countsForBreaker(result: UpstreamJsonResult): boolean {
  return result.kind === "failure" && (
    result.outcome === "timeout"
    || result.outcome === "network"
    || result.status === 429
    || result.status >= 500
  );
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const complete = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(complete, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new Error("aborted"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
