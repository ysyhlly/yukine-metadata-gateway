import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { PostgresDashboardStore } from "./postgres-dashboard-store.js";

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

export async function migrateDashboardSqliteToPostgres(options: {
  sqlitePath: string;
  databaseUrl: string;
}): Promise<{ migrated: boolean; migrationId: string }> {
  const sqlite = new DatabaseSync(options.sqlitePath, { readOnly: true });
  try {
    const admin = sqlite.prepare(`
      SELECT username, password_hash, session_version, created_at, updated_at
      FROM dashboard_admin
      WHERE singleton = 1
    `).get() as Record<string, string | number> | undefined;
    const requests = sqlite.prepare(`
      SELECT *
      FROM dashboard_request_minute
      ORDER BY bucket_start_ms, route, status
    `).all() as Array<Record<string, string | number>>;
    const upstream = sqlite.prepare(`
      SELECT *
      FROM dashboard_upstream_minute
      ORDER BY bucket_start_ms, route, host, outcome
    `).all() as Array<Record<string, string | number>>;
    const providers = readOptionalTable(
      sqlite,
      "dashboard_provider_minute",
      "bucket_start_ms, route, provider, host, outcome, cache_state, cache_layer"
    );
    const runtimeSamples = readOptionalTable(
      sqlite,
      "dashboard_runtime_sample",
      "bucket_start_ms, instance_id"
    );
    const providerHealth = readOptionalTable(
      sqlite,
      "dashboard_provider_health_sample",
      "bucket_start_ms, instance_id, provider"
    );
    const migrationId = createHash("sha256")
      .update(JSON.stringify({
        admin,
        requests,
        upstream,
        providers,
        runtimeSamples,
        providerHealth
      }), "utf8")
      .digest("hex");

    const initializer = new PostgresDashboardStore({
      url: options.databaseUrl,
      sessionIdleMs: 30 * 60_000,
      sessionAbsoluteMs: 8 * 60 * 60_000,
      metricsRetentionMs: 30 * 24 * 60 * 60_000
    });
    await initializer.initialize();
    await initializer.close();

    const pool = new Pool({ connectionString: options.databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS gateway_data_migrations (
          migration_id TEXT PRIMARY KEY,
          applied_at BIGINT NOT NULL
        )
      `);
      const existing = await client.query(
        "SELECT 1 FROM gateway_data_migrations WHERE migration_id = $1",
        [migrationId]
      );
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        return { migrated: false, migrationId };
      }
      if (admin) {
        await client.query(`
          INSERT INTO dashboard_admin(
            singleton, username, password_hash, session_version, created_at, updated_at
          ) VALUES (1, $1, $2, $3, $4, $5)
          ON CONFLICT(singleton) DO NOTHING
        `, [
          admin.username,
          admin.password_hash,
          admin.session_version,
          admin.created_at,
          admin.updated_at
        ]);
      }
      for (const row of requests) {
        const columns = [
          "bucket_start_ms",
          "route",
          "status",
          "requests",
          "cache_hits",
          "upstream_requests",
          "upstream_attempts",
          "duration_sum_ms",
          "duration_max_ms",
          ...LATENCY_COLUMNS
        ];
        const values = columns.map((column) => row[column]);
        await client.query(`
          INSERT INTO dashboard_request_minute(${columns.join(", ")})
          VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
          ON CONFLICT(bucket_start_ms, route, status) DO UPDATE SET
            ${columns.slice(3).map((column) => `${column} = excluded.${column}`).join(", ")}
        `, values);
      }
      for (const row of upstream) {
        await client.query(`
          INSERT INTO dashboard_upstream_minute(
            bucket_start_ms, route, host, outcome, attempts
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT(bucket_start_ms, route, host, outcome) DO UPDATE SET
            attempts = excluded.attempts
        `, [
          row.bucket_start_ms,
          row.route,
          row.host,
          row.outcome,
          row.attempts
        ]);
      }
      for (const row of providers) {
        const columns = [
          "bucket_start_ms",
          "route",
          "provider",
          "host",
          "outcome",
          "cache_state",
          "cache_layer",
          "attempts",
          "duration_sum_ms",
          "duration_max_ms",
          ...LATENCY_COLUMNS
        ];
        const values = columns.map((column) => row[column]);
        await client.query(`
          INSERT INTO dashboard_provider_minute(${columns.join(", ")})
          VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
          ON CONFLICT(
            bucket_start_ms, route, provider, host, outcome, cache_state, cache_layer
          ) DO UPDATE SET
            ${columns.slice(7).map((column) => `${column} = excluded.${column}`).join(", ")}
        `, values);
      }
      for (const row of runtimeSamples) {
        const columns = [
          "bucket_start_ms",
          "instance_id",
          "heartbeat_at",
          "version",
          "revision",
          "runtime",
          "state_backend",
          "ready",
          "started_at",
          "uptime_seconds",
          "l1_entries",
          "l1_max_entries",
          "l2_layer",
          "l2_entries",
          "l2_max_entries",
          "l2_connected",
          "singleflight_flights",
          "singleflight_waiters",
          "ingress_active",
          "ingress_limit",
          "requests_this_second",
          "rate_limit"
        ];
        const values = columns.map((column) => {
          if (column === "ready" || column === "l2_connected") {
            return Boolean(row[column]);
          }
          return row[column];
        });
        await client.query(`
          INSERT INTO dashboard_runtime_sample(${columns.join(", ")})
          VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
          ON CONFLICT(bucket_start_ms, instance_id) DO UPDATE SET
            ${columns.slice(2).map((column) => `${column} = excluded.${column}`).join(", ")}
        `, values);
      }
      for (const row of providerHealth) {
        const columns = [
          "bucket_start_ms",
          "instance_id",
          "provider",
          "state",
          "recent_failures",
          "opened_at",
          "active",
          "queued",
          "concurrency_limit"
        ];
        const values = columns.map((column) => row[column]);
        await client.query(`
          INSERT INTO dashboard_provider_health_sample(${columns.join(", ")})
          VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})
          ON CONFLICT(bucket_start_ms, instance_id, provider) DO UPDATE SET
            ${columns.slice(3).map((column) => `${column} = excluded.${column}`).join(", ")}
        `, values);
      }
      await client.query(
        "INSERT INTO gateway_data_migrations(migration_id, applied_at) VALUES ($1, $2)",
        [migrationId, Date.now()]
      );
      await client.query("COMMIT");
      return { migrated: true, migrationId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  } finally {
    sqlite.close();
  }
}

function readOptionalTable(
  sqlite: DatabaseSync,
  table: string,
  orderBy: string
): Array<Record<string, string | number | null>> {
  const exists = sqlite.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table);
  if (!exists) return [];
  return sqlite.prepare(`
    SELECT *
    FROM ${table}
    ORDER BY ${orderBy}
  `).all() as Array<Record<string, string | number | null>>;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    process.stderr.write("metadata-gateway: DATABASE_URL is required\n");
    process.exitCode = 1;
  } else {
    const sqlitePath = process.env.DASHBOARD_DB_PATH?.trim()
      || resolve("data", "dashboard.sqlite");
    void migrateDashboardSqliteToPostgres({ sqlitePath, databaseUrl })
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      })
      .catch(() => {
        process.stderr.write("metadata-gateway: migration_failed\n");
        process.exitCode = 1;
      });
  }
}
