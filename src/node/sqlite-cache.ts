import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CacheEntry, UpstreamJsonCache } from "../types.js";

export interface SqliteJsonCacheOptions {
  path: string;
  ttlSeconds: number;
  staleSeconds?: number;
  maxEntries: number;
}

export class SqliteJsonCache implements UpstreamJsonCache {
  private readonly database: DatabaseSync;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly maxEntries: number;
  private writesSinceCleanup = 0;

  constructor(options: SqliteJsonCacheOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.ttlMs = options.ttlSeconds * 1_000;
    this.staleMs = (options.staleSeconds ?? 86_400) * 1_000;
    this.maxEntries = options.maxEntries;
    const database = new DatabaseSync(options.path);
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS upstream_json_cache (
          cache_key TEXT PRIMARY KEY NOT NULL,
          response_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          stale_until INTEGER NOT NULL DEFAULT 0,
          last_accessed_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS upstream_json_cache_expiry
          ON upstream_json_cache(expires_at);
        CREATE INDEX IF NOT EXISTS upstream_json_cache_access
          ON upstream_json_cache(last_accessed_at);
      `);
      const columns = database.prepare(
        "PRAGMA table_info(upstream_json_cache)"
      ).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "stale_until")) {
        database.exec(
          "ALTER TABLE upstream_json_cache ADD COLUMN stale_until INTEGER NOT NULL DEFAULT 0"
        );
      }
      database.prepare(`
        UPDATE upstream_json_cache
        SET stale_until = CASE
          WHEN expires_at > ? THEN expires_at + ?
          ELSE expires_at
        END
        WHERE stale_until = 0
      `).run(Date.now(), this.staleMs);
      database.exec(`
        CREATE INDEX IF NOT EXISTS upstream_json_cache_stale
          ON upstream_json_cache(stale_until);
        PRAGMA user_version = 2;
      `);
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
    this.cleanup(Date.now());
  }

  get(url: string, now: number): CacheEntry | null {
    const key = cacheKey(url);
    const row = this.database.prepare(`
      SELECT response_json, expires_at, stale_until
      FROM upstream_json_cache
      WHERE cache_key = ? AND stale_until > ?
    `).get(key, now) as {
      response_json: string;
      expires_at: number;
      stale_until: number;
    } | undefined;
    if (!row) return null;
    this.database.prepare(`
      UPDATE upstream_json_cache
      SET last_accessed_at = ?
      WHERE cache_key = ?
    `).run(now, key);
    return {
      body: row.response_json,
      freshness: row.expires_at > now ? "fresh" : "stale",
      freshUntil: row.expires_at,
      staleUntil: row.stale_until
    };
  }

  put(url: string, body: string, now: number): void {
    const key = cacheKey(url);
    this.database.prepare(`
      INSERT INTO upstream_json_cache(
        cache_key,
        response_json,
          created_at,
          expires_at,
          stale_until,
          last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        response_json = excluded.response_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        stale_until = excluded.stale_until,
        last_accessed_at = excluded.last_accessed_at
    `).run(
      key,
      body,
      now,
      safeAdd(now, this.ttlMs),
      safeAdd(now, this.ttlMs + this.staleMs),
      now
    );
    this.writesSinceCleanup += 1;
    if (this.writesSinceCleanup >= 100) {
      this.cleanup(now);
      this.writesSinceCleanup = 0;
    }
  }

  close(): void {
    this.database.close();
  }

  delete(url: string): void {
    this.database.prepare(
      "DELETE FROM upstream_json_cache WHERE cache_key = ?"
    ).run(cacheKey(url));
  }

  ready(): boolean {
    const row = this.database.prepare("SELECT 1 AS ok").get() as { ok: number };
    return row.ok === 1;
  }

  stats(): { entries: number; maxEntries: number } {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM upstream_json_cache"
    ).get() as { count: number };
    return {
      entries: Number(row.count),
      maxEntries: this.maxEntries
    };
  }

  private cleanup(now: number): void {
    this.database.prepare("DELETE FROM upstream_json_cache WHERE stale_until <= ?").run(now);
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM upstream_json_cache"
    ).get() as { count: number };
    const overflow = Math.max(0, Number(row.count) - this.maxEntries);
    if (overflow > 0) {
      this.database.prepare(`
        DELETE FROM upstream_json_cache
        WHERE cache_key IN (
          SELECT cache_key
          FROM upstream_json_cache
          ORDER BY last_accessed_at ASC, created_at ASC, cache_key ASC
          LIMIT ?
        )
      `).run(overflow);
    }
  }
}

function cacheKey(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

function safeAdd(value: number, delta: number): number {
  return Number.MAX_SAFE_INTEGER - value < delta ? Number.MAX_SAFE_INTEGER : value + delta;
}
