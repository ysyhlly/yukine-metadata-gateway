import { Pool, type PoolClient } from "pg";
import type {
  AdminRecord,
  NewSession,
  RequestMetricRow,
  SessionRecord,
  StoredRequestMetric,
  StoredUpstreamSummary,
  UpstreamMetricRow
} from "./dashboard-store.js";
import type { DashboardStoreAdapter } from "./dashboard-store-adapter.js";

export interface PostgresDashboardStoreOptions {
  url: string;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  metricsRetentionMs: number;
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

export class PostgresDashboardStore implements DashboardStoreAdapter {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(private readonly options: PostgresDashboardStoreOptions) {
    this.pool = new Pool({
      connectionString: options.url,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000
    });
  }

  async initialize(): Promise<void> {
    this.initialized ??= this.migrate();
    await this.initialized;
  }

  async hasAdmin(): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(
      "SELECT 1 AS present FROM dashboard_admin WHERE singleton = 1"
    );
    return result.rowCount === 1;
  }

  async getAdmin(): Promise<AdminRecord | null> {
    await this.initialize();
    const result = await this.pool.query<{
      username: string;
      password_hash: string;
      session_version: number;
    }>(`
      SELECT username, password_hash, session_version
      FROM dashboard_admin
      WHERE singleton = 1
    `);
    const row = result.rows[0];
    return row
      ? {
          username: row.username,
          passwordHash: row.password_hash,
          sessionVersion: Number(row.session_version)
        }
      : null;
  }

  async createAdmin(username: string, passwordHash: string, now: number): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(`
      INSERT INTO dashboard_admin(
        singleton, username, password_hash, session_version, created_at, updated_at
      ) VALUES (1, $1, $2, 1, $3, $3)
      ON CONFLICT(singleton) DO NOTHING
    `, [username, passwordHash, now]);
    return result.rowCount === 1;
  }

  async createSession(session: NewSession): Promise<void> {
    await this.initialize();
    const absoluteExpiresAt = safeAdd(session.createdAt, this.options.sessionAbsoluteMs);
    const idleExpiresAt = Math.min(
      absoluteExpiresAt,
      safeAdd(session.createdAt, this.options.sessionIdleMs)
    );
    await this.pool.query(`
      INSERT INTO dashboard_sessions(
        token_hash, csrf_token, session_version, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at, revoked_at
      ) VALUES ($1, $2, $3, $4, $4, $5, $6, NULL)
      ON CONFLICT(token_hash) DO UPDATE SET
        csrf_token = excluded.csrf_token,
        session_version = excluded.session_version,
        created_at = excluded.created_at,
        last_seen_at = excluded.last_seen_at,
        idle_expires_at = excluded.idle_expires_at,
        absolute_expires_at = excluded.absolute_expires_at,
        revoked_at = NULL
    `, [
      session.tokenHash,
      session.csrfToken,
      session.sessionVersion,
      session.createdAt,
      idleExpiresAt,
      absoluteExpiresAt
    ]);
  }

  async resolveSession(tokenHash: string, now: number): Promise<SessionRecord | null> {
    await this.initialize();
    const result = await this.pool.query<{
      token_hash: string;
      csrf_token: string;
      last_seen_at: string;
      absolute_expires_at: string;
      username: string;
    }>(`
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
      WHERE sessions.token_hash = $1
        AND sessions.revoked_at IS NULL
        AND sessions.idle_expires_at > $2
        AND sessions.absolute_expires_at > $2
    `, [tokenHash, now]);
    const row = result.rows[0];
    if (!row) return null;
    const lastSeenAt = Number(row.last_seen_at);
    const absoluteExpiresAt = Number(row.absolute_expires_at);
    if (now - lastSeenAt >= 60_000) {
      await this.pool.query(`
        UPDATE dashboard_sessions
        SET last_seen_at = $1, idle_expires_at = $2
        WHERE token_hash = $3
      `, [
        now,
        Math.min(absoluteExpiresAt, safeAdd(now, this.options.sessionIdleMs)),
        tokenHash
      ]);
    }
    return {
      tokenHash: row.token_hash,
      username: row.username,
      csrfToken: row.csrf_token,
      absoluteExpiresAt
    };
  }

  async revokeSession(tokenHash: string, now: number): Promise<void> {
    await this.initialize();
    await this.pool.query(`
      UPDATE dashboard_sessions
      SET revoked_at = $1
      WHERE token_hash = $2 AND revoked_at IS NULL
    `, [now, tokenHash]);
  }

  async writeMetrics(
    requests: RequestMetricRow[],
    upstream: UpstreamMetricRow[]
  ): Promise<void> {
    if (requests.length === 0 && upstream.length === 0) return;
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of requests) await this.writeRequestMetric(client, row);
      for (const row of upstream) {
        await client.query(`
          INSERT INTO dashboard_upstream_minute(
            bucket_start_ms, route, host, outcome, attempts
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT(bucket_start_ms, route, host, outcome) DO UPDATE SET
            attempts = dashboard_upstream_minute.attempts + excluded.attempts
        `, [row.bucketStartMs, row.route, row.host, row.outcome, row.attempts]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readRequestMetrics(since: number): Promise<StoredRequestMetric[]> {
    await this.initialize();
    const result = await this.pool.query<Record<string, string | number>>(`
      SELECT
        bucket_start_ms, route, status, requests, cache_hits, upstream_requests,
        upstream_attempts, duration_sum_ms, duration_max_ms,
        ${LATENCY_COLUMNS.join(", ")}
      FROM dashboard_request_minute
      WHERE bucket_start_ms >= $1
      ORDER BY bucket_start_ms ASC, route ASC, status ASC
    `, [since]);
    return result.rows.map((row) => ({
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

  async readUpstreamSummary(since: number): Promise<StoredUpstreamSummary[]> {
    await this.initialize();
    const result = await this.pool.query<{
      host: string;
      outcome: "success" | "not_found" | "failure";
      attempts: string;
    }>(`
      SELECT host, outcome, SUM(attempts) AS attempts
      FROM dashboard_upstream_minute
      WHERE bucket_start_ms >= $1
      GROUP BY host, outcome
      ORDER BY host ASC, outcome ASC
    `, [since]);
    return result.rows.map((row) => ({
      host: row.host,
      outcome: row.outcome,
      attempts: Number(row.attempts)
    }));
  }

  async cleanup(now: number): Promise<void> {
    await this.initialize();
    const cutoff = now - this.options.metricsRetentionMs;
    await this.pool.query(
      "DELETE FROM dashboard_request_minute WHERE bucket_start_ms < $1",
      [cutoff]
    );
    await this.pool.query(
      "DELETE FROM dashboard_upstream_minute WHERE bucket_start_ms < $1",
      [cutoff]
    );
    await this.pool.query(`
      DELETE FROM dashboard_sessions
      WHERE revoked_at IS NOT NULL
         OR idle_expires_at <= $1
         OR absolute_expires_at <= $1
    `, [now]);
  }

  async ready(): Promise<boolean> {
    try {
      await this.initialize();
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dashboard_admin (
          singleton SMALLINT PRIMARY KEY CHECK(singleton = 1),
          username TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          session_version INTEGER NOT NULL DEFAULT 1,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dashboard_sessions (
          token_hash TEXT PRIMARY KEY,
          csrf_token TEXT NOT NULL,
          session_version INTEGER NOT NULL,
          created_at BIGINT NOT NULL,
          last_seen_at BIGINT NOT NULL,
          idle_expires_at BIGINT NOT NULL,
          absolute_expires_at BIGINT NOT NULL,
          revoked_at BIGINT
        );
        CREATE INDEX IF NOT EXISTS dashboard_sessions_expiry
          ON dashboard_sessions(idle_expires_at, absolute_expires_at);
        CREATE TABLE IF NOT EXISTS dashboard_request_minute (
          bucket_start_ms BIGINT NOT NULL,
          route TEXT NOT NULL,
          status INTEGER NOT NULL,
          requests BIGINT NOT NULL,
          cache_hits BIGINT NOT NULL,
          upstream_requests BIGINT NOT NULL,
          upstream_attempts BIGINT NOT NULL,
          duration_sum_ms BIGINT NOT NULL,
          duration_max_ms BIGINT NOT NULL,
          ${LATENCY_COLUMNS.map((column) => `${column} BIGINT NOT NULL`).join(",\n          ")},
          PRIMARY KEY(bucket_start_ms, route, status)
        );
        CREATE TABLE IF NOT EXISTS dashboard_upstream_minute (
          bucket_start_ms BIGINT NOT NULL,
          route TEXT NOT NULL,
          host TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('success', 'not_found', 'failure')),
          attempts BIGINT NOT NULL,
          PRIMARY KEY(bucket_start_ms, route, host, outcome)
        );
        INSERT INTO gateway_schema_migrations(version, applied_at)
        VALUES (1, $1)
        ON CONFLICT(version) DO NOTHING;
      `, [Date.now()]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeRequestMetric(
    client: PoolClient,
    row: RequestMetricRow
  ): Promise<void> {
    const values = [
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
    ];
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    await client.query(`
      INSERT INTO dashboard_request_minute(
        bucket_start_ms, route, status, requests, cache_hits, upstream_requests,
        upstream_attempts, duration_sum_ms, duration_max_ms,
        ${LATENCY_COLUMNS.join(", ")}
      ) VALUES (${placeholders})
      ON CONFLICT(bucket_start_ms, route, status) DO UPDATE SET
        requests = dashboard_request_minute.requests + excluded.requests,
        cache_hits = dashboard_request_minute.cache_hits + excluded.cache_hits,
        upstream_requests = dashboard_request_minute.upstream_requests + excluded.upstream_requests,
        upstream_attempts = dashboard_request_minute.upstream_attempts + excluded.upstream_attempts,
        duration_sum_ms = dashboard_request_minute.duration_sum_ms + excluded.duration_sum_ms,
        duration_max_ms = GREATEST(
          dashboard_request_minute.duration_max_ms,
          excluded.duration_max_ms
        ),
        ${LATENCY_COLUMNS.map((column) =>
          `${column} = dashboard_request_minute.${column} + excluded.${column}`
        ).join(",\n        ")}
    `, values);
  }
}

function safeAdd(value: number, delta: number): number {
  return Number.MAX_SAFE_INTEGER - value < delta ? Number.MAX_SAFE_INTEGER : value + delta;
}
