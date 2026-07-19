import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { PostgresAuthorizationStore } from "./authorization-store.js";

export async function migrateAuthorizationState(
  sqlitePath: string,
  databaseUrl: string
): Promise<{ migrated: boolean; subjects: number; credentials: number }> {
  const migrationId = createHash("sha256")
    .update(readFileSync(sqlitePath))
    .digest("hex");
  const schema = new PostgresAuthorizationStore({ url: databaseUrl });
  await schema.initialize();
  await schema.close();

  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const subjects = source.prepare("SELECT * FROM authorization_subjects").all() as unknown as Record<string, unknown>[];
    const credentials = source.prepare("SELECT * FROM authorization_credentials").all() as unknown as Record<string, unknown>[];
    const redemptions = source.prepare("SELECT * FROM authorization_redemptions").all() as unknown as Record<string, unknown>[];
    const activations = source.prepare("SELECT * FROM authorization_activations").all() as unknown as Record<string, unknown>[];
    const audit = source.prepare("SELECT * FROM authorization_audit").all() as unknown as Record<string, unknown>[];
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS authorization_data_migrations (
        migration_id TEXT PRIMARY KEY,
        migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const existing = await client.query(
      "SELECT 1 FROM authorization_data_migrations WHERE migration_id = $1",
      [migrationId]
    );
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return {
        migrated: false,
        subjects: subjects.length,
        credentials: credentials.length
      };
    }
    for (const row of subjects) {
      await client.query(`
        INSERT INTO authorization_subjects (
          id, label, capabilities_json, expires_at, active, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET
          label=EXCLUDED.label, capabilities_json=EXCLUDED.capabilities_json,
          expires_at=EXCLUDED.expires_at, active=EXCLUDED.active,
          updated_at=EXCLUDED.updated_at
      `, [
        row.id, row.label, row.capabilities_json, row.expires_at,
        Number(row.active) === 1, row.created_at, row.updated_at
      ]);
    }
    for (const row of credentials) {
      await client.query(`
        INSERT INTO authorization_credentials (
          id, subject_id, digest, fingerprint, status, expires_at,
          pending_expires_at, created_at, revoked_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO UPDATE SET
          subject_id=EXCLUDED.subject_id, digest=EXCLUDED.digest,
          fingerprint=EXCLUDED.fingerprint, status=EXCLUDED.status,
          expires_at=EXCLUDED.expires_at,
          pending_expires_at=EXCLUDED.pending_expires_at,
          revoked_at=EXCLUDED.revoked_at
      `, [
        row.id, row.subject_id, row.digest, row.fingerprint, row.status,
        row.expires_at, row.pending_expires_at, row.created_at, row.revoked_at
      ]);
    }
    for (const row of redemptions) {
      await client.query(`
        INSERT INTO authorization_redemptions (
          id, subject_id, digest, fingerprint, expires_at, created_at, used_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET
          subject_id=EXCLUDED.subject_id, digest=EXCLUDED.digest,
          fingerprint=EXCLUDED.fingerprint, expires_at=EXCLUDED.expires_at,
          used_at=EXCLUDED.used_at
      `, [
        row.id, row.subject_id, row.digest, row.fingerprint,
        row.expires_at, row.created_at, row.used_at
      ]);
    }
    for (const row of activations) {
      await client.query(`
        INSERT INTO authorization_activations (
          digest, credential_id, expires_at, used_at
        ) VALUES ($1,$2,$3,$4)
        ON CONFLICT (digest) DO UPDATE SET
          credential_id=EXCLUDED.credential_id,
          expires_at=EXCLUDED.expires_at,
          used_at=EXCLUDED.used_at
      `, [row.digest, row.credential_id, row.expires_at, row.used_at]);
    }
    for (const row of audit) {
      await client.query(`
        INSERT INTO authorization_audit (
          id, action, subject_id, credential_id, fingerprint, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO NOTHING
      `, [
        row.id, row.action, row.subject_id, row.credential_id,
        row.fingerprint, row.created_at
      ]);
    }
    await client.query(
      "INSERT INTO authorization_data_migrations (migration_id) VALUES ($1)",
      [migrationId]
    );
    await client.query("COMMIT");
    return {
      migrated: true,
      subjects: subjects.length,
      credentials: credentials.length
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    source.close();
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const sqlitePath = process.env.AUTHORIZATION_DB_PATH?.trim();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!sqlitePath || !databaseUrl) {
    throw new Error("authorization_migration_requires_paths");
  }
  const result = await migrateAuthorizationState(sqlitePath, databaseUrl);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("authorization-state-migration: failed\n");
    process.exitCode = 1;
  });
}
