import { Redis } from "ioredis";

export interface CloudEphemeralStore {
  reserve(userId: string, nonce: string, now: number): Promise<boolean>;
  close(): Promise<void>;
}

export class InMemoryEphemeralStore implements CloudEphemeralStore {
  private readonly nonces = new Map<string, number>();
  private readonly rate = new Map<string, { minute: number; count: number }>();

  constructor(private readonly limitPerMinute = 20) {}

  async reserve(userId: string, nonce: string, now: number): Promise<boolean> {
    for (const [key, expiresAt] of this.nonces) {
      if (expiresAt <= now) this.nonces.delete(key);
    }
    const minute = Math.floor(now / 60_000);
    const current = this.rate.get(userId);
    const next = current?.minute === minute
      ? { minute, count: current.count + 1 }
      : { minute, count: 1 };
    this.rate.set(userId, next);
    if (next.count > this.limitPerMinute) return false;
    const key = `${userId}:${nonce}`;
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, now + 15 * 60_000);
    return true;
  }

  async close(): Promise<void> {}
}

export class RedisEphemeralStore implements CloudEphemeralStore {
  private readonly redis: Redis;

  constructor(url: string, private readonly limitPerMinute = 20) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    });
  }

  async reserve(userId: string, nonce: string, now: number): Promise<boolean> {
    if (this.redis.status === "wait") await this.redis.connect();
    const minute = Math.floor(now / 60_000);
    const rateKey = `yukine:cloud:authorization:rate:${userId}:${minute}`;
    const nonceKey = `yukine:cloud:authorization:nonce:${userId}:${nonce}`;
    const results = await this.redis
      .multi()
      .incr(rateKey)
      .expire(rateKey, 120)
      .set(nonceKey, "1", "PX", 15 * 60_000, "NX")
      .exec();
    const count = Number(results?.[0]?.[1] || 0);
    const nonceAccepted = results?.[2]?.[1] === "OK";
    return count <= this.limitPerMinute && nonceAccepted;
  }

  async close(): Promise<void> {
    if (this.redis.status !== "end") await this.redis.quit();
  }
}
