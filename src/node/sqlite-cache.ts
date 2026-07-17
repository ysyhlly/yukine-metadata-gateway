import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UpstreamJsonCache } from "../types.js";

export interface SqliteJsonCacheOptions {
  path: string;
  ttlSeconds: number;
  maxEntries: number;
}

export class SqliteJsonCache implements UpstreamJsonCache {
  private readonly database: DatabaseSync;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private writesSinceCleanup = 0;

  constructor(options: SqliteJsonCacheOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.ttlMs = options.ttlSeconds * 1_000;
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
          last_accessed_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS upstream_json_cache_expiry
          ON upstream_json_cache(expires_at);
        CREATE INDEX IF NOT EXISTS upstream_json_cache_access
          ON upstream_json_cache(last_accessed_at);
      `);
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
    this.cleanup(Date.now());
  }

  get(url: string, now: number): string | null {
    const key = cacheKey(url);
    const row = this.database.prepare(`
      SELECT response_json
      FROM upstream_json_cache
      WHERE cache_key = ? AND expires_at > ?
    `).get(key, now) as { response_json: string } | undefined;
    if (!row) return null;
    this.database.prepare(`
      UPDATE upstream_json_cache
      SET last_accessed_at = ?
      WHERE cache_key = ?
    `).run(now, key);
    return row.response_json;
  }

  put(url: string, body: string, now: number): void {
    const key = cacheKey(url);
    this.database.prepare(`
      INSERT INTO upstream_json_cache(
        cache_key,
        response_json,
        created_at,
        expires_at,
        last_accessed_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        response_json = excluded.response_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        last_accessed_at = excluded.last_accessed_at
    `).run(key, body, now, safeAdd(now, this.ttlMs), now);
    this.writesSinceCleanup += 1;
    if (this.writesSinceCleanup >= 100) {
      this.cleanup(now);
      this.writesSinceCleanup = 0;
    }
  }

  close(): void {
    this.database.close();
  }

  private cleanup(now: number): void {
    this.database.prepare("DELETE FROM upstream_json_cache WHERE expires_at <= ?").run(now);
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
