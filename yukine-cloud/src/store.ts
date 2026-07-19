import { Pool, type PoolClient } from "pg";
import type {
  AuthorizationBinding,
  EncryptedCredential,
  TrustedIssuer
} from "./types.js";

export class BindingConflictError extends Error {
  constructor() {
    super("authorization_already_bound");
    this.name = "BindingConflictError";
  }
}

export interface CloudAuthorizationStore {
  initialize(): Promise<void>;
  ready(): Promise<boolean>;
  upsertTrustedIssuer(issuer: TrustedIssuer): Promise<void>;
  getTrustedIssuer(issuerId: string): Promise<TrustedIssuer | null>;
  getBinding(userId: string): Promise<AuthorizationBinding | null>;
  replaceActive(binding: AuthorizationBinding): Promise<void>;
  reserveCandidate(binding: AuthorizationBinding): Promise<void>;
  promoteCandidate(userId: string, now: number): Promise<AuthorizationBinding | null>;
  deleteCandidate(userId: string): Promise<void>;
  updateActive(binding: AuthorizationBinding): Promise<void>;
  deleteBinding(userId: string): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryCloudAuthorizationStore implements CloudAuthorizationStore {
  private readonly issuers = new Map<string, TrustedIssuer>();
  private readonly bindings = new Map<string, AuthorizationBinding>();
  private readonly candidates = new Map<string, AuthorizationBinding>();

  async initialize(): Promise<void> {}
  async ready(): Promise<boolean> { return true; }

  async upsertTrustedIssuer(issuer: TrustedIssuer): Promise<void> {
    this.issuers.set(issuer.issuerId, structuredClone(issuer));
  }

  async getTrustedIssuer(issuerId: string): Promise<TrustedIssuer | null> {
    const issuer = this.issuers.get(issuerId);
    return issuer ? structuredClone(issuer) : null;
  }

  async getBinding(userId: string): Promise<AuthorizationBinding | null> {
    const binding = this.bindings.get(userId);
    return binding ? structuredClone(binding) : null;
  }

  async replaceActive(binding: AuthorizationBinding): Promise<void> {
    this.assertSubjectAvailable(binding.userId, binding.issuerId, binding.subject);
    this.bindings.set(binding.userId, structuredClone({ ...binding, status: "active" }));
    this.candidates.delete(binding.userId);
  }

  async reserveCandidate(binding: AuthorizationBinding): Promise<void> {
    this.assertSubjectAvailable(binding.userId, binding.issuerId, binding.subject);
    this.candidates.set(binding.userId, structuredClone({ ...binding, status: "pending" }));
  }

  async promoteCandidate(
    userId: string,
    now: number
  ): Promise<AuthorizationBinding | null> {
    const candidate = this.candidates.get(userId);
    if (!candidate) return null;
    this.assertSubjectAvailable(userId, candidate.issuerId, candidate.subject);
    const promoted = {
      ...candidate,
      status: "active" as const,
      updatedAt: now
    };
    this.bindings.set(userId, structuredClone(promoted));
    this.candidates.delete(userId);
    return structuredClone(promoted);
  }

  async deleteCandidate(userId: string): Promise<void> {
    this.candidates.delete(userId);
  }

  async updateActive(binding: AuthorizationBinding): Promise<void> {
    if (!this.bindings.has(binding.userId)) return;
    this.bindings.set(binding.userId, structuredClone(binding));
  }

  async deleteBinding(userId: string): Promise<void> {
    this.bindings.delete(userId);
    this.candidates.delete(userId);
  }

  async close(): Promise<void> {}

  private assertSubjectAvailable(
    userId: string,
    issuerId: string,
    subject: string
  ): void {
    for (const binding of [...this.bindings.values(), ...this.candidates.values()]) {
      if (
        binding.userId !== userId
        && binding.issuerId === issuerId
        && binding.subject === subject
      ) {
        throw new BindingConflictError();
      }
    }
  }
}

export interface PostgresCloudAuthorizationStoreOptions {
  url: string;
}

export class PostgresCloudAuthorizationStore implements CloudAuthorizationStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(options: PostgresCloudAuthorizationStoreOptions) {
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

  async ready(): Promise<boolean> {
    try {
      await this.initialize();
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async upsertTrustedIssuer(issuer: TrustedIssuer): Promise<void> {
    await this.initialize();
    await this.pool.query(`
      INSERT INTO trusted_authorization_issuers (
        issuer_id, display_name, origin, verify_path, redeem_path_prefix,
        activate_path, capabilities_json, public_keys_json, timeout_ms,
        max_response_bytes, enabled, allow_private_for_tests, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (issuer_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        origin = EXCLUDED.origin,
        verify_path = EXCLUDED.verify_path,
        redeem_path_prefix = EXCLUDED.redeem_path_prefix,
        activate_path = EXCLUDED.activate_path,
        capabilities_json = EXCLUDED.capabilities_json,
        public_keys_json = EXCLUDED.public_keys_json,
        timeout_ms = EXCLUDED.timeout_ms,
        max_response_bytes = EXCLUDED.max_response_bytes,
        enabled = EXCLUDED.enabled,
        allow_private_for_tests = EXCLUDED.allow_private_for_tests,
        updated_at = EXCLUDED.updated_at
    `, [
      issuer.issuerId,
      issuer.displayName,
      issuer.origin,
      issuer.verifyPath,
      issuer.redeemPathPrefix,
      issuer.activatePath,
      JSON.stringify(issuer.capabilities),
      JSON.stringify(issuer.publicKeys),
      issuer.timeoutMs,
      issuer.maxResponseBytes,
      issuer.enabled,
      process.env.NODE_ENV === "test" && Boolean(issuer.allowPrivateForTests),
      Date.now()
    ]);
  }

  async getTrustedIssuer(issuerId: string): Promise<TrustedIssuer | null> {
    await this.initialize();
    const result = await this.pool.query<TrustedIssuerRow>(`
      SELECT issuer_id, display_name, origin, verify_path, redeem_path_prefix,
             activate_path, capabilities_json, public_keys_json, timeout_ms,
             max_response_bytes, enabled, allow_private_for_tests
      FROM trusted_authorization_issuers
      WHERE issuer_id = $1
    `, [issuerId]);
    return result.rows[0] ? issuerFromRow(result.rows[0]) : null;
  }

  async getBinding(userId: string): Promise<AuthorizationBinding | null> {
    await this.initialize();
    const result = await this.pool.query<BindingRow>(`
      SELECT user_id, issuer_id, subject, credential_json, fingerprint,
             capabilities_json, expires_at, status, version, created_at, updated_at
      FROM authorization_bindings
      WHERE user_id = $1
    `, [userId]);
    return result.rows[0] ? bindingFromRow(result.rows[0]) : null;
  }

  async replaceActive(binding: AuthorizationBinding): Promise<void> {
    await this.transaction(async (client) => {
      await lockBindingKeys(client, binding.userId, binding.issuerId, binding.subject);
      await assertSubjectAvailable(client, binding.userId, binding.issuerId, binding.subject);
      await upsertBinding(client, { ...binding, status: "active" }, "authorization_bindings");
      await client.query(
        "DELETE FROM authorization_binding_candidates WHERE user_id = $1",
        [binding.userId]
      );
    });
  }

  async reserveCandidate(binding: AuthorizationBinding): Promise<void> {
    await this.transaction(async (client) => {
      await lockBindingKeys(client, binding.userId, binding.issuerId, binding.subject);
      await assertSubjectAvailable(client, binding.userId, binding.issuerId, binding.subject);
      await upsertBinding(
        client,
        { ...binding, status: "pending" },
        "authorization_binding_candidates"
      );
    });
  }

  async promoteCandidate(
    userId: string,
    now: number
  ): Promise<AuthorizationBinding | null> {
    return this.transaction(async (client) => {
      const candidateResult = await client.query<BindingRow>(`
        SELECT user_id, issuer_id, subject, credential_json, fingerprint,
               capabilities_json, expires_at, status, version, created_at, updated_at
        FROM authorization_binding_candidates
        WHERE user_id = $1
        FOR UPDATE
      `, [userId]);
      const row = candidateResult.rows[0];
      if (!row) return null;
      const candidate = bindingFromRow(row);
      await lockBindingKeys(client, userId, candidate.issuerId, candidate.subject);
      await assertSubjectAvailable(client, userId, candidate.issuerId, candidate.subject);
      const promoted = { ...candidate, status: "active" as const, updatedAt: now };
      await upsertBinding(client, promoted, "authorization_bindings");
      await client.query(
        "DELETE FROM authorization_binding_candidates WHERE user_id = $1",
        [userId]
      );
      return promoted;
    });
  }

  async deleteCandidate(userId: string): Promise<void> {
    await this.initialize();
    await this.pool.query(
      "DELETE FROM authorization_binding_candidates WHERE user_id = $1",
      [userId]
    );
  }

  async updateActive(binding: AuthorizationBinding): Promise<void> {
    await this.initialize();
    await this.pool.query(`
      UPDATE authorization_bindings
      SET capabilities_json = $1, expires_at = $2, updated_at = $3
      WHERE user_id = $4 AND issuer_id = $5 AND subject = $6
    `, [
      JSON.stringify(binding.capabilities),
      binding.expiresAt,
      binding.updatedAt,
      binding.userId,
      binding.issuerId,
      binding.subject
    ]);
  }

  async deleteBinding(userId: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("DELETE FROM authorization_binding_candidates WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM authorization_bindings WHERE user_id = $1", [userId]);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(CLOUD_SCHEMA);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        throw new BindingConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

const CLOUD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cloud_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  INSERT INTO cloud_schema_migrations(version)
  VALUES (1) ON CONFLICT (version) DO NOTHING;

  CREATE TABLE IF NOT EXISTS trusted_authorization_issuers (
    issuer_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    origin TEXT NOT NULL,
    verify_path TEXT NOT NULL,
    redeem_path_prefix TEXT NOT NULL,
    activate_path TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    public_keys_json TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    max_response_bytes INTEGER NOT NULL,
    enabled BOOLEAN NOT NULL,
    allow_private_for_tests BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL
  );
  ALTER TABLE trusted_authorization_issuers
    ADD COLUMN IF NOT EXISTS allow_private_for_tests BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE TABLE IF NOT EXISTS authorization_bindings (
    user_id TEXT PRIMARY KEY,
    issuer_id TEXT NOT NULL REFERENCES trusted_authorization_issuers(issuer_id),
    subject TEXT NOT NULL,
    credential_json JSONB NOT NULL,
    fingerprint TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    status TEXT NOT NULL CHECK(status = 'active'),
    version INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(issuer_id, subject)
  );

  CREATE TABLE IF NOT EXISTS authorization_binding_candidates (
    user_id TEXT PRIMARY KEY,
    issuer_id TEXT NOT NULL REFERENCES trusted_authorization_issuers(issuer_id),
    subject TEXT NOT NULL,
    credential_json JSONB NOT NULL,
    fingerprint TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    status TEXT NOT NULL CHECK(status = 'pending'),
    version INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(issuer_id, subject)
  );
`;

interface TrustedIssuerRow {
  issuer_id: string;
  display_name: string;
  origin: string;
  verify_path: string;
  redeem_path_prefix: string;
  activate_path: string;
  capabilities_json: string;
  public_keys_json: string;
  timeout_ms: number;
  max_response_bytes: number;
  enabled: boolean;
  allow_private_for_tests: boolean;
}

interface BindingRow {
  user_id: string;
  issuer_id: string;
  subject: string;
  credential_json: EncryptedCredential;
  fingerprint: string;
  capabilities_json: string;
  expires_at: string | number;
  status: "pending" | "active";
  version: number;
  created_at: string | number;
  updated_at: string | number;
}

function issuerFromRow(row: TrustedIssuerRow): TrustedIssuer {
  return {
    issuerId: row.issuer_id,
    displayName: row.display_name,
    origin: row.origin,
    verifyPath: row.verify_path,
    redeemPathPrefix: row.redeem_path_prefix,
    activatePath: row.activate_path,
    capabilities: JSON.parse(row.capabilities_json),
    publicKeys: JSON.parse(row.public_keys_json),
    timeoutMs: row.timeout_ms,
    maxResponseBytes: row.max_response_bytes,
    enabled: row.enabled,
    ...(process.env.NODE_ENV === "test" && row.allow_private_for_tests
      ? { allowPrivateForTests: true }
      : {})
  } as TrustedIssuer;
}

function bindingFromRow(row: BindingRow): AuthorizationBinding {
  return {
    userId: row.user_id,
    issuerId: row.issuer_id,
    subject: row.subject,
    credential: row.credential_json,
    fingerprint: row.fingerprint,
    capabilities: JSON.parse(row.capabilities_json),
    expiresAt: Number(row.expires_at),
    status: row.status,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  } as AuthorizationBinding;
}

async function lockBindingKeys(
  client: PoolClient,
  userId: string,
  issuerId: string,
  subject: string
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`user:${userId}`]
  );
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`subject:${issuerId}:${subject}`]
  );
}

async function assertSubjectAvailable(
  client: PoolClient,
  userId: string,
  issuerId: string,
  subject: string
): Promise<void> {
  const result = await client.query(`
    SELECT user_id FROM authorization_bindings
    WHERE issuer_id = $1 AND subject = $2 AND user_id <> $3
    UNION ALL
    SELECT user_id FROM authorization_binding_candidates
    WHERE issuer_id = $1 AND subject = $2 AND user_id <> $3
    LIMIT 1
  `, [issuerId, subject, userId]);
  if (result.rowCount) throw new BindingConflictError();
}

async function upsertBinding(
  client: PoolClient,
  binding: AuthorizationBinding,
  table: "authorization_bindings" | "authorization_binding_candidates"
): Promise<void> {
  await client.query(`
    INSERT INTO ${table} (
      user_id, issuer_id, subject, credential_json, fingerprint,
      capabilities_json, expires_at, status, version, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (user_id) DO UPDATE SET
      issuer_id = EXCLUDED.issuer_id,
      subject = EXCLUDED.subject,
      credential_json = EXCLUDED.credential_json,
      fingerprint = EXCLUDED.fingerprint,
      capabilities_json = EXCLUDED.capabilities_json,
      expires_at = EXCLUDED.expires_at,
      status = EXCLUDED.status,
      version = EXCLUDED.version,
      updated_at = EXCLUDED.updated_at
  `, [
    binding.userId,
    binding.issuerId,
    binding.subject,
    JSON.stringify(binding.credential),
    binding.fingerprint,
    JSON.stringify(binding.capabilities),
    binding.expiresAt,
    binding.status,
    binding.version,
    binding.createdAt,
    binding.updatedAt
  ]);
}
