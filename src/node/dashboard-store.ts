import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DashboardStoreOptions {
  path: string;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  metricsRetentionMs: number;
}

export interface AdminRecord {
  username: string;
  passwordHash: string;
  sessionVersion: number;
}

export interface SessionRecord {
  tokenHash: string;
  username: string;
  csrfToken: string;
  absoluteExpiresAt: number;
}

export interface NewSession {
  tokenHash: string;
  csrfToken: string;
  sessionVersion: number;
  createdAt: number;
}

export interface RequestMetricRow {
  bucketStartMs: number;
  route: string;
  status: number;
  requests: number;
  cacheHits: number;
  upstreamRequests: number;
  upstreamAttempts: number;
  durationSumMs: number;
  durationMaxMs: number;
  latencyBuckets: number[];
}

export interface UpstreamMetricRow {
  bucketStartMs: number;
  route: string;
  host: string;
  outcome: "success" | "not_found" | "failure";
  attempts: number;
}

export interface StoredRequestMetric extends RequestMetricRow {}

export interface StoredUpstreamSummary {
  host: string;
  outcome: "success" | "not_found" | "failure";
  attempts: number;
}

const LATENCY_COLUMNS = [
  "lat_le_10",
  "lat_le_25",
  "lat_le_50",
  "lat_le_100",
  "lat_le_250",
  "lat_le_500",
  "lat_le_1000",
  "lat_le_2500",
  "lat_le_5000",
  "lat_le_10000",
  "lat_gt_10000"
] as const;

export class DashboardStore {
  private readonly database: DatabaseSync;

  constructor(private readonly options: DashboardStoreOptions) {
    const directory = dirname(options.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    securePermissions(directory, 0o700);
    const database = new DatabaseSync(options.path);
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS dashboard_admin (
          singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          session_version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS dashboard_sessions (
          token_hash TEXT PRIMARY KEY NOT NULL,
          csrf_token TEXT NOT NULL,
          session_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          idle_expires_at INTEGER NOT NULL,
          absolute_expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS dashboard_sessions_expiry
          ON dashboard_sessions(idle_expires_at, absolute_expires_at);

        CREATE TABLE IF NOT EXISTS dashboard_request_minute (
          bucket_start_ms INTEGER NOT NULL,
          route TEXT NOT NULL,
          status INTEGER NOT NULL,
          requests INTEGER NOT NULL DEFAULT 0,
          cache_hits INTEGER NOT NULL DEFAULT 0,
          upstream_requests INTEGER NOT NULL DEFAULT 0,
          upstream_attempts INTEGER NOT NULL DEFAULT 0,
          duration_sum_ms INTEGER NOT NULL DEFAULT 0,
          duration_max_ms INTEGER NOT NULL DEFAULT 0,
          lat_le_10 INTEGER NOT NULL DEFAULT 0,
          lat_le_25 INTEGER NOT NULL DEFAULT 0,
          lat_le_50 INTEGER NOT NULL DEFAULT 0,
          lat_le_100 INTEGER NOT NULL DEFAULT 0,
          lat_le_250 INTEGER NOT NULL DEFAULT 0,
          lat_le_500 INTEGER NOT NULL DEFAULT 0,
          lat_le_1000 INTEGER NOT NULL DEFAULT 0,
          lat_le_2500 INTEGER NOT NULL DEFAULT 0,
          lat_le_5000 INTEGER NOT NULL DEFAULT 0,
          lat_le_10000 INTEGER NOT NULL DEFAULT 0,
          lat_gt_10000 INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(bucket_start_ms, route, status)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS dashboard_request_minute_time
          ON dashboard_request_minute(bucket_start_ms);

        CREATE TABLE IF NOT EXISTS dashboard_upstream_minute (
          bucket_start_ms INTEGER NOT NULL,
          route TEXT NOT NULL,
          host TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('success', 'not_found', 'failure')),
          attempts INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(bucket_start_ms, route, host, outcome)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS dashboard_upstream_minute_time
          ON dashboard_upstream_minute(bucket_start_ms);
      `);
      securePermissions(options.path, 0o600);
      this.database = database;
      this.cleanup(Date.now());
    } catch (error) {
      database.close();
      throw error;
    }
  }

  hasAdmin(): boolean {
    return Boolean(this.database.prepare(
      "SELECT 1 AS present FROM dashboard_admin WHERE singleton = 1"
    ).get());
  }

  getAdmin(): AdminRecord | null {
    const row = this.database.prepare(`
      SELECT username, password_hash, session_version
      FROM dashboard_admin
      WHERE singleton = 1
    `).get() as {
      username: string;
      password_hash: string;
      session_version: number;
    } | undefined;
    return row
      ? {
          username: row.username,
          passwordHash: row.password_hash,
          sessionVersion: Number(row.session_version)
        }
      : null;
  }

  createAdmin(username: string, passwordHash: string, now: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.hasAdmin()) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database.prepare(`
        INSERT INTO dashboard_admin(
          singleton,
          username,
          password_hash,
          session_version,
          created_at,
          updated_at
        ) VALUES (1, ?, ?, 1, ?, ?)
      `).run(username, passwordHash, now, now);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  createSession(session: NewSession): void {
    const absoluteExpiresAt = safeAdd(session.createdAt, this.options.sessionAbsoluteMs);
    const idleExpiresAt = Math.min(
      absoluteExpiresAt,
      safeAdd(session.createdAt, this.options.sessionIdleMs)
    );
    this.database.prepare(`
      INSERT INTO dashboard_sessions(
        token_hash,
        csrf_token,
        session_version,
        created_at,
        last_seen_at,
        idle_expires_at,
        absolute_expires_at,
        revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      session.tokenHash,
      session.csrfToken,
      session.sessionVersion,
      session.createdAt,
      session.createdAt,
      idleExpiresAt,
      absoluteExpiresAt
    );
  }

  resolveSession(tokenHash: string, now: number): SessionRecord | null {
    const row = this.database.prepare(`
      SELECT
        sessions.token_hash,
        sessions.csrf_token,
        sessions.last_seen_at,
        sessions.absolute_expires_at,
        admin.username
      FROM dashboard_sessions AS sessions
      JOIN dashboard_admin AS admin
        ON admin.singleton = 1
       AND admin.session_version = sessions.session_version
      WHERE sessions.token_hash = ?
        AND sessions.revoked_at IS NULL
        AND sessions.idle_expires_at > ?
        AND sessions.absolute_expires_at > ?
    `).get(tokenHash, now, now) as {
      token_hash: string;
      csrf_token: string;
      last_seen_at: number;
      absolute_expires_at: number;
      username: string;
    } | undefined;
    if (!row) return null;

    const lastSeenAt = Number(row.last_seen_at);
    const absoluteExpiresAt = Number(row.absolute_expires_at);
    if (now - lastSeenAt >= 60_000) {
      const idleExpiresAt = Math.min(
        absoluteExpiresAt,
        safeAdd(now, this.options.sessionIdleMs)
      );
      this.database.prepare(`
        UPDATE dashboard_sessions
        SET last_seen_at = ?, idle_expires_at = ?
        WHERE token_hash = ?
      `).run(now, idleExpiresAt, tokenHash);
    }
    return {
      tokenHash: row.token_hash,
      username: row.username,
      csrfToken: row.csrf_token,
      absoluteExpiresAt
    };
  }

  revokeSession(tokenHash: string, now: number): void {
    this.database.prepare(`
      UPDATE dashboard_sessions
      SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(now, tokenHash);
  }

  writeMetrics(requests: RequestMetricRow[], upstream: UpstreamMetricRow[]): void {
    if (requests.length === 0 && upstream.length === 0) return;
    const requestStatement = this.database.prepare(`
      INSERT INTO dashboard_request_minute(
        bucket_start_ms,
        route,
        status,
        requests,
        cache_hits,
        upstream_requests,
        upstream_attempts,
        duration_sum_ms,
        duration_max_ms,
        ${LATENCY_COLUMNS.join(", ")}
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ${LATENCY_COLUMNS.map(() => "?").join(", ")}
      )
      ON CONFLICT(bucket_start_ms, route, status) DO UPDATE SET
        requests = requests + excluded.requests,
        cache_hits = cache_hits + excluded.cache_hits,
        upstream_requests = upstream_requests + excluded.upstream_requests,
        upstream_attempts = upstream_attempts + excluded.upstream_attempts,
        duration_sum_ms = duration_sum_ms + excluded.duration_sum_ms,
        duration_max_ms = MAX(duration_max_ms, excluded.duration_max_ms),
        ${LATENCY_COLUMNS.map(
          (column) => `${column} = ${column} + excluded.${column}`
        ).join(",\n        ")}
    `);
    const upstreamStatement = this.database.prepare(`
      INSERT INTO dashboard_upstream_minute(
        bucket_start_ms,
        route,
        host,
        outcome,
        attempts
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bucket_start_ms, route, host, outcome) DO UPDATE SET
        attempts = attempts + excluded.attempts
    `);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of requests) {
        requestStatement.run(
          row.bucketStartMs,
          row.route,
          row.status,
          row.requests,
          row.cacheHits,
          row.upstreamRequests,
          row.upstreamAttempts,
          row.durationSumMs,
          row.durationMaxMs,
          ...row.latencyBuckets
        );
      }
      for (const row of upstream) {
        upstreamStatement.run(
          row.bucketStartMs,
          row.route,
          row.host,
          row.outcome,
          row.attempts
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  readRequestMetrics(since: number): StoredRequestMetric[] {
    const rows = this.database.prepare(`
      SELECT
        bucket_start_ms,
        route,
        status,
        requests,
        cache_hits,
        upstream_requests,
        upstream_attempts,
        duration_sum_ms,
        duration_max_ms,
        ${LATENCY_COLUMNS.join(", ")}
      FROM dashboard_request_minute
      WHERE bucket_start_ms >= ?
      ORDER BY bucket_start_ms ASC, route ASC, status ASC
    `).all(since) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      bucketStartMs: Number(row.bucket_start_ms),
      route: String(row.route),
      status: Number(row.status),
      requests: Number(row.requests),
      cacheHits: Number(row.cache_hits),
      upstreamRequests: Number(row.upstream_requests),
      upstreamAttempts: Number(row.upstream_attempts),
      durationSumMs: Number(row.duration_sum_ms),
      durationMaxMs: Number(row.duration_max_ms),
      latencyBuckets: LATENCY_COLUMNS.map((column) => Number(row[column]))
    }));
  }

  readUpstreamSummary(since: number): StoredUpstreamSummary[] {
    const rows = this.database.prepare(`
      SELECT host, outcome, SUM(attempts) AS attempts
      FROM dashboard_upstream_minute
      WHERE bucket_start_ms >= ?
      GROUP BY host, outcome
      ORDER BY host ASC, outcome ASC
    `).all(since) as Array<{
      host: string;
      outcome: "success" | "not_found" | "failure";
      attempts: number;
    }>;
    return rows.map((row) => ({
      host: row.host,
      outcome: row.outcome,
      attempts: Number(row.attempts)
    }));
  }

  cleanup(now: number): void {
    const cutoff = now - this.options.metricsRetentionMs;
    this.database.prepare(
      "DELETE FROM dashboard_request_minute WHERE bucket_start_ms < ?"
    ).run(cutoff);
    this.database.prepare(
      "DELETE FROM dashboard_upstream_minute WHERE bucket_start_ms < ?"
    ).run(cutoff);
    this.database.prepare(`
      DELETE FROM dashboard_sessions
      WHERE revoked_at IS NOT NULL
         OR idle_expires_at <= ?
         OR absolute_expires_at <= ?
    `).run(now, now);
  }

  close(): void {
    this.database.close();
  }
}

function securePermissions(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function safeAdd(value: number, delta: number): number {
  return Number.MAX_SAFE_INTEGER - value < delta ? Number.MAX_SAFE_INTEGER : value + delta;
}
