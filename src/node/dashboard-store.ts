import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CacheLayer,
  CacheState,
  UpstreamOutcome
} from "../types.js";

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

export interface ProviderMetricRow {
  bucketStartMs: number;
  route: string;
  provider: string;
  host: string;
  outcome: UpstreamOutcome | "unknown";
  cacheState: CacheState | "unknown";
  cacheLayer: CacheLayer | "unknown";
  attempts: number;
  durationSumMs: number;
  durationMaxMs: number;
  latencyBuckets: number[];
}

export interface StoredProviderMetric extends ProviderMetricRow {}

export interface RuntimeSampleRow {
  bucketStartMs: number;
  instanceId: string;
  heartbeatAt: number;
  version: string;
  revision: string;
  runtime: "node";
  stateBackend: "sqlite" | "external";
  ready: boolean;
  startedAt: number;
  uptimeSeconds: number;
  l1Entries: number;
  l1MaxEntries: number;
  l2Layer: "sqlite" | "redis";
  l2Entries: number | null;
  l2MaxEntries: number | null;
  l2Connected: boolean;
  singleflightFlights: number;
  singleflightWaiters: number;
  ingressActive: number;
  ingressLimit: number;
  requestsThisSecond: number;
  rateLimit: number;
}

export interface ProviderHealthSampleRow {
  bucketStartMs: number;
  instanceId: string;
  provider: string;
  state: "closed" | "open" | "half_open";
  recentFailures: number;
  openedAt: number | null;
  active: number;
  queued: number;
  limit: number;
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
        BEGIN IMMEDIATE;

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

        CREATE TABLE IF NOT EXISTS dashboard_provider_minute (
          bucket_start_ms INTEGER NOT NULL,
          route TEXT NOT NULL,
          provider TEXT NOT NULL,
          host TEXT NOT NULL,
          outcome TEXT NOT NULL,
          cache_state TEXT NOT NULL,
          cache_layer TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          duration_sum_ms INTEGER NOT NULL DEFAULT 0,
          duration_max_ms INTEGER NOT NULL DEFAULT 0,
          ${LATENCY_COLUMNS.map((column) => `${column} INTEGER NOT NULL DEFAULT 0`).join(",\n          ")},
          PRIMARY KEY(
            bucket_start_ms, route, provider, host, outcome, cache_state, cache_layer
          )
        ) STRICT;
        CREATE INDEX IF NOT EXISTS dashboard_provider_minute_time
          ON dashboard_provider_minute(bucket_start_ms);

        CREATE TABLE IF NOT EXISTS dashboard_runtime_sample (
          bucket_start_ms INTEGER NOT NULL,
          instance_id TEXT NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          version TEXT NOT NULL,
          revision TEXT NOT NULL,
          runtime TEXT NOT NULL,
          state_backend TEXT NOT NULL,
          ready INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          uptime_seconds INTEGER NOT NULL,
          l1_entries INTEGER NOT NULL,
          l1_max_entries INTEGER NOT NULL,
          l2_layer TEXT NOT NULL,
          l2_entries INTEGER,
          l2_max_entries INTEGER,
          l2_connected INTEGER NOT NULL,
          singleflight_flights INTEGER NOT NULL,
          singleflight_waiters INTEGER NOT NULL,
          ingress_active INTEGER NOT NULL,
          ingress_limit INTEGER NOT NULL,
          requests_this_second INTEGER NOT NULL,
          rate_limit INTEGER NOT NULL,
          PRIMARY KEY(bucket_start_ms, instance_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS dashboard_runtime_sample_time
          ON dashboard_runtime_sample(bucket_start_ms);

        CREATE TABLE IF NOT EXISTS dashboard_provider_health_sample (
          bucket_start_ms INTEGER NOT NULL,
          instance_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          state TEXT NOT NULL,
          recent_failures INTEGER NOT NULL,
          opened_at INTEGER,
          active INTEGER NOT NULL,
          queued INTEGER NOT NULL,
          concurrency_limit INTEGER NOT NULL,
          PRIMARY KEY(bucket_start_ms, instance_id, provider)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS dashboard_provider_health_sample_time
          ON dashboard_provider_health_sample(bucket_start_ms);

        PRAGMA user_version = 2;
        COMMIT;
      `);
      securePermissions(options.path, 0o600);
      securePermissions(`${options.path}-wal`, 0o600);
      securePermissions(`${options.path}-shm`, 0o600);
      this.database = database;
      this.cleanup(Date.now());
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
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

  writeProviderMetrics(rows: ProviderMetricRow[]): void {
    if (rows.length === 0) return;
    const statement = this.database.prepare(`
      INSERT INTO dashboard_provider_minute(
        bucket_start_ms, route, provider, host, outcome, cache_state, cache_layer,
        attempts, duration_sum_ms, duration_max_ms, ${LATENCY_COLUMNS.join(", ")}
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ${LATENCY_COLUMNS.map(() => "?").join(", ")}
      )
      ON CONFLICT(
        bucket_start_ms, route, provider, host, outcome, cache_state, cache_layer
      ) DO UPDATE SET
        attempts = attempts + excluded.attempts,
        duration_sum_ms = duration_sum_ms + excluded.duration_sum_ms,
        duration_max_ms = MAX(duration_max_ms, excluded.duration_max_ms),
        ${LATENCY_COLUMNS.map(
          (column) => `${column} = ${column} + excluded.${column}`
        ).join(",\n        ")}
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        statement.run(
          row.bucketStartMs,
          row.route,
          row.provider,
          row.host,
          row.outcome,
          row.cacheState,
          row.cacheLayer,
          row.attempts,
          row.durationSumMs,
          row.durationMaxMs,
          ...row.latencyBuckets
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  writeRuntimeSamples(
    runtime: RuntimeSampleRow,
    providers: ProviderHealthSampleRow[]
  ): void {
    const runtimeStatement = this.database.prepare(`
      INSERT INTO dashboard_runtime_sample(
        bucket_start_ms, instance_id, heartbeat_at, version, revision, runtime,
        state_backend, ready, started_at, uptime_seconds, l1_entries, l1_max_entries,
        l2_layer, l2_entries, l2_max_entries, l2_connected, singleflight_flights,
        singleflight_waiters, ingress_active, ingress_limit, requests_this_second,
        rate_limit
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(bucket_start_ms, instance_id) DO UPDATE SET
        heartbeat_at = excluded.heartbeat_at,
        version = excluded.version,
        revision = excluded.revision,
        runtime = excluded.runtime,
        state_backend = excluded.state_backend,
        ready = excluded.ready,
        started_at = excluded.started_at,
        uptime_seconds = excluded.uptime_seconds,
        l1_entries = excluded.l1_entries,
        l1_max_entries = excluded.l1_max_entries,
        l2_layer = excluded.l2_layer,
        l2_entries = excluded.l2_entries,
        l2_max_entries = excluded.l2_max_entries,
        l2_connected = excluded.l2_connected,
        singleflight_flights = excluded.singleflight_flights,
        singleflight_waiters = excluded.singleflight_waiters,
        ingress_active = excluded.ingress_active,
        ingress_limit = excluded.ingress_limit,
        requests_this_second = excluded.requests_this_second,
        rate_limit = excluded.rate_limit
    `);
    const providerStatement = this.database.prepare(`
      INSERT INTO dashboard_provider_health_sample(
        bucket_start_ms, instance_id, provider, state, recent_failures,
        opened_at, active, queued, concurrency_limit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket_start_ms, instance_id, provider) DO UPDATE SET
        state = excluded.state,
        recent_failures = excluded.recent_failures,
        opened_at = excluded.opened_at,
        active = excluded.active,
        queued = excluded.queued,
        concurrency_limit = excluded.concurrency_limit
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      runtimeStatement.run(
        runtime.bucketStartMs,
        runtime.instanceId,
        runtime.heartbeatAt,
        runtime.version,
        runtime.revision,
        runtime.runtime,
        runtime.stateBackend,
        runtime.ready ? 1 : 0,
        runtime.startedAt,
        runtime.uptimeSeconds,
        runtime.l1Entries,
        runtime.l1MaxEntries,
        runtime.l2Layer,
        runtime.l2Entries,
        runtime.l2MaxEntries,
        runtime.l2Connected ? 1 : 0,
        runtime.singleflightFlights,
        runtime.singleflightWaiters,
        runtime.ingressActive,
        runtime.ingressLimit,
        runtime.requestsThisSecond,
        runtime.rateLimit
      );
      for (const row of providers) {
        providerStatement.run(
          row.bucketStartMs,
          row.instanceId,
          row.provider,
          row.state,
          row.recentFailures,
          row.openedAt,
          row.active,
          row.queued,
          row.limit
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

  readProviderMetrics(since: number): StoredProviderMetric[] {
    const rows = this.database.prepare(`
      SELECT
        bucket_start_ms, route, provider, host, outcome, cache_state, cache_layer,
        attempts, duration_sum_ms, duration_max_ms, ${LATENCY_COLUMNS.join(", ")}
      FROM dashboard_provider_minute
      WHERE bucket_start_ms >= ?
      ORDER BY bucket_start_ms ASC, provider ASC, host ASC
    `).all(since) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      bucketStartMs: Number(row.bucket_start_ms),
      route: String(row.route),
      provider: String(row.provider),
      host: String(row.host),
      outcome: String(row.outcome) as ProviderMetricRow["outcome"],
      cacheState: String(row.cache_state) as ProviderMetricRow["cacheState"],
      cacheLayer: String(row.cache_layer) as ProviderMetricRow["cacheLayer"],
      attempts: Number(row.attempts),
      durationSumMs: Number(row.duration_sum_ms),
      durationMaxMs: Number(row.duration_max_ms),
      latencyBuckets: LATENCY_COLUMNS.map((column) => Number(row[column]))
    }));
  }

  readRuntimeSamples(since: number): RuntimeSampleRow[] {
    const rows = this.database.prepare(`
      SELECT *
      FROM dashboard_runtime_sample
      WHERE bucket_start_ms >= ?
      ORDER BY bucket_start_ms ASC, instance_id ASC
    `).all(since) as Array<Record<string, string | number | null>>;
    return rows.map(runtimeSampleFromRow);
  }

  readProviderHealth(since: number): ProviderHealthSampleRow[] {
    const rows = this.database.prepare(`
      SELECT
        bucket_start_ms, instance_id, provider, state, recent_failures,
        opened_at, active, queued, concurrency_limit
      FROM dashboard_provider_health_sample
      WHERE bucket_start_ms >= ?
      ORDER BY bucket_start_ms ASC, instance_id ASC, provider ASC
    `).all(since) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      bucketStartMs: Number(row.bucket_start_ms),
      instanceId: String(row.instance_id),
      provider: String(row.provider),
      state: String(row.state) as ProviderHealthSampleRow["state"],
      recentFailures: Number(row.recent_failures),
      openedAt: row.opened_at === null ? null : Number(row.opened_at),
      active: Number(row.active),
      queued: Number(row.queued),
      limit: Number(row.concurrency_limit)
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
    this.database.prepare(
      "DELETE FROM dashboard_provider_minute WHERE bucket_start_ms < ?"
    ).run(cutoff);
    this.database.prepare(
      "DELETE FROM dashboard_runtime_sample WHERE bucket_start_ms < ?"
    ).run(cutoff);
    this.database.prepare(
      "DELETE FROM dashboard_provider_health_sample WHERE bucket_start_ms < ?"
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
    if (
      process.platform !== "win32"
      && (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

function runtimeSampleFromRow(
  row: Record<string, string | number | null>
): RuntimeSampleRow {
  return {
    bucketStartMs: Number(row.bucket_start_ms),
    instanceId: String(row.instance_id),
    heartbeatAt: Number(row.heartbeat_at),
    version: String(row.version),
    revision: String(row.revision),
    runtime: "node",
    stateBackend: String(row.state_backend) as RuntimeSampleRow["stateBackend"],
    ready: Boolean(row.ready),
    startedAt: Number(row.started_at),
    uptimeSeconds: Number(row.uptime_seconds),
    l1Entries: Number(row.l1_entries),
    l1MaxEntries: Number(row.l1_max_entries),
    l2Layer: String(row.l2_layer) as RuntimeSampleRow["l2Layer"],
    l2Entries: row.l2_entries === null ? null : Number(row.l2_entries),
    l2MaxEntries: row.l2_max_entries === null ? null : Number(row.l2_max_entries),
    l2Connected: Boolean(row.l2_connected),
    singleflightFlights: Number(row.singleflight_flights),
    singleflightWaiters: Number(row.singleflight_waiters),
    ingressActive: Number(row.ingress_active),
    ingressLimit: Number(row.ingress_limit),
    requestsThisSecond: Number(row.requests_this_second),
    rateLimit: Number(row.rate_limit)
  };
}

function safeAdd(value: number, delta: number): number {
  return Number.MAX_SAFE_INTEGER - value < delta ? Number.MAX_SAFE_INTEGER : value + delta;
}
