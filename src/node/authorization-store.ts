import { timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import type { AuthorizationCapability } from "@yukine/authorization-contract";

export type CredentialStatus = "pending" | "active" | "revoked";

export interface AuthorizationSubject {
  id: string;
  label: string;
  capabilities: AuthorizationCapability[];
  expiresAt: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AuthorizationCredential {
  id: string;
  subjectId: string;
  digest: string;
  fingerprint: string;
  status: CredentialStatus;
  expiresAt: number;
  pendingExpiresAt: number | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface AuthorizationRedemption {
  id: string;
  subjectId: string;
  digest: string;
  fingerprint: string;
  expiresAt: number;
  createdAt: number;
  usedAt: number | null;
}

export interface AuthorizationAuditEntry {
  id: string;
  action: string;
  subjectId: string | null;
  credentialId: string | null;
  fingerprint: string | null;
  createdAt: number;
}

export interface AuthorizationDashboardSnapshot {
  subjects: Array<AuthorizationSubject & {
    credentials: Array<Pick<
      AuthorizationCredential,
      "id" | "fingerprint" | "status" | "expiresAt" | "createdAt" | "revokedAt"
    >>;
  }>;
  redemptions: Array<Pick<
    AuthorizationRedemption,
    "id" | "subjectId" | "fingerprint" | "expiresAt" | "createdAt" | "usedAt"
  >>;
  audit: AuthorizationAuditEntry[];
}

export interface RedeemInput {
  tokenId: string;
  tokenDigest: string;
  requestedCapabilities: AuthorizationCapability[];
  credential: AuthorizationCredential;
  activationDigest: string;
  activationExpiresAt: number;
  now: number;
  auditId: string;
}

export type RedeemResult =
  | { kind: "success"; subject: AuthorizationSubject }
  | { kind: "invalid" }
  | { kind: "used" }
  | { kind: "expired" }
  | { kind: "denied" };

export interface AuthorizationStore {
  initialize(): Promise<void>;
  ready(): Promise<boolean>;
  createSubject(subject: AuthorizationSubject, auditId: string): Promise<boolean>;
  updateSubject(
    id: string,
    input: Pick<AuthorizationSubject, "label" | "capabilities" | "expiresAt" | "active">,
    now: number,
    auditId: string
  ): Promise<boolean>;
  getSubject(id: string): Promise<AuthorizationSubject | null>;
  createCredential(
    credential: AuthorizationCredential,
    auditId: string
  ): Promise<void>;
  getCredential(id: string): Promise<AuthorizationCredential | null>;
  revokeCredential(id: string, now: number, auditId: string): Promise<boolean>;
  createRedemption(
    redemption: AuthorizationRedemption,
    auditId: string
  ): Promise<void>;
  redeem(input: RedeemInput): Promise<RedeemResult>;
  activate(
    activationDigest: string,
    now: number,
    auditId: string
  ): Promise<AuthorizationCredential | null>;
  consumeNonce(hash: string, expiresAt: number, now: number): Promise<boolean>;
  snapshot(limit?: number): Promise<AuthorizationDashboardSnapshot>;
  cleanup(now: number): Promise<void>;
  close(): Promise<void>;
}

export interface SqliteAuthorizationStoreOptions {
  path: string;
}

export class SqliteAuthorizationStore implements AuthorizationStore {
  private readonly database: DatabaseSync;

  constructor(private readonly options: SqliteAuthorizationStoreOptions) {
    const directory = dirname(options.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    securePermissions(directory, 0o700);
    this.database = new DatabaseSync(options.path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS authorization_subjects (
        id TEXT PRIMARY KEY NOT NULL,
        label TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS authorization_credentials (
        id TEXT PRIMARY KEY NOT NULL,
        subject_id TEXT NOT NULL REFERENCES authorization_subjects(id),
        digest TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'revoked')),
        expires_at INTEGER NOT NULL,
        pending_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS authorization_credentials_digest
        ON authorization_credentials(digest);
      CREATE INDEX IF NOT EXISTS authorization_credentials_subject
        ON authorization_credentials(subject_id, status);

      CREATE TABLE IF NOT EXISTS authorization_redemptions (
        id TEXT PRIMARY KEY NOT NULL,
        subject_id TEXT NOT NULL REFERENCES authorization_subjects(id),
        digest TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS authorization_redemptions_digest
        ON authorization_redemptions(digest);

      CREATE TABLE IF NOT EXISTS authorization_activations (
        digest TEXT PRIMARY KEY NOT NULL,
        credential_id TEXT NOT NULL REFERENCES authorization_credentials(id),
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS authorization_nonces (
        nonce_hash TEXT PRIMARY KEY NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS authorization_audit (
        id TEXT PRIMARY KEY NOT NULL,
        action TEXT NOT NULL,
        subject_id TEXT,
        credential_id TEXT,
        fingerprint TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS authorization_audit_created
        ON authorization_audit(created_at DESC);

      PRAGMA user_version = 3;
    `);
    securePermissions(options.path, 0o600);
    securePermissions(`${options.path}-wal`, 0o600);
    securePermissions(`${options.path}-shm`, 0o600);
  }

  async initialize(): Promise<void> {}

  async ready(): Promise<boolean> {
    try {
      this.database.prepare("SELECT 1 AS ready").get();
      return true;
    } catch {
      return false;
    }
  }

  async createSubject(subject: AuthorizationSubject, auditId: string): Promise<boolean> {
    const transaction = this.database.prepare(`
      INSERT OR IGNORE INTO authorization_subjects (
        id, label, capabilities_json, expires_at, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = transaction.run(
        subject.id,
        subject.label,
        JSON.stringify(subject.capabilities),
        subject.expiresAt,
        subject.active ? 1 : 0,
        subject.createdAt,
        subject.updatedAt
      );
      if (Number(result.changes) === 1) {
        this.insertAudit({
          id: auditId,
          action: "subject_created",
          subjectId: subject.id,
          credentialId: null,
          fingerprint: null,
          createdAt: subject.createdAt
        });
      }
      this.database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async updateSubject(
    id: string,
    input: Pick<AuthorizationSubject, "label" | "capabilities" | "expiresAt" | "active">,
    now: number,
    auditId: string
  ): Promise<boolean> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE authorization_subjects
        SET label = ?, capabilities_json = ?, expires_at = ?, active = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.label,
        JSON.stringify(input.capabilities),
        input.expiresAt,
        input.active ? 1 : 0,
        now,
        id
      );
      if (Number(result.changes) === 1) {
        this.insertAudit({
          id: auditId,
          action: "subject_updated",
          subjectId: id,
          credentialId: null,
          fingerprint: null,
          createdAt: now
        });
      }
      this.database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getSubject(id: string): Promise<AuthorizationSubject | null> {
    const row = this.database.prepare(`
      SELECT id, label, capabilities_json, expires_at, active, created_at, updated_at
      FROM authorization_subjects
      WHERE id = ?
    `).get(id) as SqliteSubjectRow | undefined;
    return row ? subjectFromRow(row) : null;
  }

  async createCredential(
    credential: AuthorizationCredential,
    auditId: string
  ): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      insertSqliteCredential(this.database, credential);
      this.insertAudit({
        id: auditId,
        action: "api_key_issued",
        subjectId: credential.subjectId,
        credentialId: credential.id,
        fingerprint: credential.fingerprint,
        createdAt: credential.createdAt
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getCredential(id: string): Promise<AuthorizationCredential | null> {
    const row = this.database.prepare(`
      SELECT id, subject_id, digest, fingerprint, status, expires_at,
             pending_expires_at, created_at, revoked_at
      FROM authorization_credentials
      WHERE id = ?
    `).get(id) as SqliteCredentialRow | undefined;
    return row ? credentialFromRow(row) : null;
  }

  async revokeCredential(id: string, now: number, auditId: string): Promise<boolean> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = await this.getCredential(id);
      const result = this.database.prepare(`
        UPDATE authorization_credentials
        SET status = 'revoked', revoked_at = ?
        WHERE id = ? AND status <> 'revoked'
      `).run(now, id);
      if (Number(result.changes) === 1 && current) {
        this.insertAudit({
          id: auditId,
          action: "api_key_revoked",
          subjectId: current.subjectId,
          credentialId: id,
          fingerprint: current.fingerprint,
          createdAt: now
        });
      }
      this.database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async createRedemption(
    redemption: AuthorizationRedemption,
    auditId: string
  ): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO authorization_redemptions (
          id, subject_id, digest, fingerprint, expires_at, created_at, used_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(
        redemption.id,
        redemption.subjectId,
        redemption.digest,
        redemption.fingerprint,
        redemption.expiresAt,
        redemption.createdAt
      );
      this.insertAudit({
        id: auditId,
        action: "redemption_issued",
        subjectId: redemption.subjectId,
        credentialId: null,
        fingerprint: redemption.fingerprint,
        createdAt: redemption.createdAt
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async redeem(input: RedeemInput): Promise<RedeemResult> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT r.id, r.subject_id, r.digest, r.expires_at, r.used_at,
               s.label, s.capabilities_json, s.expires_at AS subject_expires_at,
               s.active, s.created_at AS subject_created_at, s.updated_at
        FROM authorization_redemptions r
        JOIN authorization_subjects s ON s.id = r.subject_id
        WHERE r.id = ?
      `).get(input.tokenId) as SqliteRedemptionJoinRow | undefined;
      if (!row || !safeDigestEqual(row.digest, input.tokenDigest)) {
        this.database.exec("ROLLBACK");
        return { kind: "invalid" };
      }
      if (row.used_at !== null) {
        this.database.exec("ROLLBACK");
        return { kind: "used" };
      }
      if (row.expires_at <= input.now) {
        this.database.exec("ROLLBACK");
        return { kind: "expired" };
      }
      if (row.active !== 1 || row.subject_expires_at <= input.now) {
        this.database.exec("ROLLBACK");
        return { kind: "denied" };
      }
      const subjectCapabilities = parseCapabilities(row.capabilities_json);
      if (input.requestedCapabilities.some(
        (capability) => !subjectCapabilities.includes(capability)
      )) {
        this.database.exec("ROLLBACK");
        return { kind: "denied" };
      }
      const consumed = this.database.prepare(`
        UPDATE authorization_redemptions SET used_at = ?
        WHERE id = ? AND used_at IS NULL
      `).run(input.now, input.tokenId);
      if (Number(consumed.changes) !== 1) {
        this.database.exec("ROLLBACK");
        return { kind: "used" };
      }
      insertSqliteCredential(this.database, {
        ...input.credential,
        subjectId: row.subject_id,
        expiresAt: row.subject_expires_at
      });
      this.database.prepare(`
        INSERT INTO authorization_activations (digest, credential_id, expires_at, used_at)
        VALUES (?, ?, ?, NULL)
      `).run(
        input.activationDigest,
        input.credential.id,
        input.activationExpiresAt
      );
      this.insertAudit({
        id: input.auditId,
        action: "redemption_consumed",
        subjectId: row.subject_id,
        credentialId: input.credential.id,
        fingerprint: input.credential.fingerprint,
        createdAt: input.now
      });
      this.database.exec("COMMIT");
      return {
        kind: "success",
        subject: {
          id: row.subject_id,
          label: row.label,
          capabilities: subjectCapabilities,
          expiresAt: row.subject_expires_at,
          active: row.active === 1,
          createdAt: row.subject_created_at,
          updatedAt: row.updated_at
        }
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async activate(
    activationDigest: string,
    now: number,
    auditId: string
  ): Promise<AuthorizationCredential | null> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT a.digest AS activation_digest, a.expires_at AS activation_expires_at,
               a.used_at AS activation_used_at,
               c.id, c.subject_id, c.digest, c.fingerprint, c.status,
               c.expires_at, c.pending_expires_at, c.created_at, c.revoked_at
        FROM authorization_activations a
        JOIN authorization_credentials c ON c.id = a.credential_id
        WHERE a.digest = ?
      `).get(activationDigest) as SqliteActivationJoinRow | undefined;
      if (
        !row
        || row.activation_used_at !== null
        || row.activation_expires_at <= now
        || row.status !== "pending"
        || (row.pending_expires_at !== null && row.pending_expires_at <= now)
      ) {
        this.database.exec("ROLLBACK");
        return null;
      }
      this.database.prepare(`
        UPDATE authorization_activations SET used_at = ?
        WHERE digest = ? AND used_at IS NULL
      `).run(now, activationDigest);
      this.database.prepare(`
        UPDATE authorization_credentials
        SET status = 'active', pending_expires_at = NULL
        WHERE id = ? AND status = 'pending'
      `).run(row.id);
      this.insertAudit({
        id: auditId,
        action: "api_key_activated",
        subjectId: row.subject_id,
        credentialId: row.id,
        fingerprint: row.fingerprint,
        createdAt: now
      });
      this.database.exec("COMMIT");
      return {
        ...credentialFromRow(row),
        status: "active",
        pendingExpiresAt: null
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async consumeNonce(hash: string, expiresAt: number, now: number): Promise<boolean> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "DELETE FROM authorization_nonces WHERE expires_at <= ?"
      ).run(now);
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO authorization_nonces (nonce_hash, expires_at)
        VALUES (?, ?)
      `).run(hash, expiresAt);
      this.database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async snapshot(limit = 100): Promise<AuthorizationDashboardSnapshot> {
    const subjects = (this.database.prepare(`
      SELECT id, label, capabilities_json, expires_at, active, created_at, updated_at
      FROM authorization_subjects
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as unknown as SqliteSubjectRow[]).map(subjectFromRow);
    const credentials = this.database.prepare(`
      SELECT id, subject_id, digest, fingerprint, status, expires_at,
             pending_expires_at, created_at, revoked_at
      FROM authorization_credentials
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit * 5) as unknown as SqliteCredentialRow[];
    const redemptions = this.database.prepare(`
      SELECT id, subject_id, digest, fingerprint, expires_at, created_at, used_at
      FROM authorization_redemptions
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as unknown as SqliteRedemptionRow[];
    const audit = this.database.prepare(`
      SELECT id, action, subject_id, credential_id, fingerprint, created_at
      FROM authorization_audit
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as unknown as SqliteAuditRow[];
    return {
      subjects: subjects.map((subject) => ({
        ...subject,
        credentials: credentials
          .filter((credential) => credential.subject_id === subject.id)
          .map((credential) => {
            const parsed = credentialFromRow(credential);
            return {
              id: parsed.id,
              fingerprint: parsed.fingerprint,
              status: parsed.status,
              expiresAt: parsed.expiresAt,
              createdAt: parsed.createdAt,
              revokedAt: parsed.revokedAt
            };
          })
      })),
      redemptions: redemptions.map((row) => ({
        id: row.id,
        subjectId: row.subject_id,
        fingerprint: row.fingerprint,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        usedAt: row.used_at
      })),
      audit: audit.map((row) => ({
        id: row.id,
        action: row.action,
        subjectId: row.subject_id,
        credentialId: row.credential_id,
        fingerprint: row.fingerprint,
        createdAt: row.created_at
      }))
    };
  }

  async cleanup(now: number): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "UPDATE authorization_credentials SET status = 'revoked', revoked_at = ? WHERE status = 'pending' AND pending_expires_at <= ?"
      ).run(now, now);
      this.database.prepare(
        "DELETE FROM authorization_activations WHERE expires_at <= ?"
      ).run(now);
      this.database.prepare(
        "DELETE FROM authorization_nonces WHERE expires_at <= ?"
      ).run(now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private insertAudit(entry: AuthorizationAuditEntry): void {
    this.database.prepare(`
      INSERT INTO authorization_audit (
        id, action, subject_id, credential_id, fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.action,
      entry.subjectId,
      entry.credentialId,
      entry.fingerprint,
      entry.createdAt
    );
  }
}

export interface PostgresAuthorizationStoreOptions {
  url: string;
}

export class PostgresAuthorizationStore implements AuthorizationStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(options: PostgresAuthorizationStoreOptions) {
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

  async createSubject(subject: AuthorizationSubject, auditId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(`
        INSERT INTO authorization_subjects (
          id, label, capabilities_json, expires_at, active, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO NOTHING
      `, [
        subject.id,
        subject.label,
        JSON.stringify(subject.capabilities),
        subject.expiresAt,
        subject.active,
        subject.createdAt,
        subject.updatedAt
      ]);
      if (result.rowCount === 1) {
        await insertPostgresAudit(client, {
          id: auditId,
          action: "subject_created",
          subjectId: subject.id,
          credentialId: null,
          fingerprint: null,
          createdAt: subject.createdAt
        });
      }
      return result.rowCount === 1;
    });
  }

  async updateSubject(
    id: string,
    input: Pick<AuthorizationSubject, "label" | "capabilities" | "expiresAt" | "active">,
    now: number,
    auditId: string
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(`
        UPDATE authorization_subjects
        SET label = $1, capabilities_json = $2, expires_at = $3,
            active = $4, updated_at = $5
        WHERE id = $6
      `, [input.label, JSON.stringify(input.capabilities), input.expiresAt, input.active, now, id]);
      if (result.rowCount === 1) {
        await insertPostgresAudit(client, {
          id: auditId,
          action: "subject_updated",
          subjectId: id,
          credentialId: null,
          fingerprint: null,
          createdAt: now
        });
      }
      return result.rowCount === 1;
    });
  }

  async getSubject(id: string): Promise<AuthorizationSubject | null> {
    await this.initialize();
    const result = await this.pool.query<PostgresSubjectRow>(`
      SELECT id, label, capabilities_json, expires_at, active, created_at, updated_at
      FROM authorization_subjects WHERE id = $1
    `, [id]);
    return result.rows[0] ? subjectFromPostgresRow(result.rows[0]) : null;
  }

  async createCredential(
    credential: AuthorizationCredential,
    auditId: string
  ): Promise<void> {
    await this.transaction(async (client) => {
      await insertPostgresCredential(client, credential);
      await insertPostgresAudit(client, {
        id: auditId,
        action: "api_key_issued",
        subjectId: credential.subjectId,
        credentialId: credential.id,
        fingerprint: credential.fingerprint,
        createdAt: credential.createdAt
      });
    });
  }

  async getCredential(id: string): Promise<AuthorizationCredential | null> {
    await this.initialize();
    const result = await this.pool.query<PostgresCredentialRow>(`
      SELECT id, subject_id, digest, fingerprint, status, expires_at,
             pending_expires_at, created_at, revoked_at
      FROM authorization_credentials WHERE id = $1
    `, [id]);
    return result.rows[0] ? credentialFromPostgresRow(result.rows[0]) : null;
  }

  async revokeCredential(id: string, now: number, auditId: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const current = await client.query<PostgresCredentialRow>(`
        SELECT id, subject_id, digest, fingerprint, status, expires_at,
               pending_expires_at, created_at, revoked_at
        FROM authorization_credentials WHERE id = $1
      `, [id]);
      const result = await client.query(`
        UPDATE authorization_credentials
        SET status = 'revoked', revoked_at = $1
        WHERE id = $2 AND status <> 'revoked'
      `, [now, id]);
      const row = current.rows[0];
      if (result.rowCount === 1 && row) {
        await insertPostgresAudit(client, {
          id: auditId,
          action: "api_key_revoked",
          subjectId: row.subject_id,
          credentialId: id,
          fingerprint: row.fingerprint,
          createdAt: now
        });
      }
      return result.rowCount === 1;
    });
  }

  async createRedemption(
    redemption: AuthorizationRedemption,
    auditId: string
  ): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`
        INSERT INTO authorization_redemptions (
          id, subject_id, digest, fingerprint, expires_at, created_at, used_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL)
      `, [
        redemption.id,
        redemption.subjectId,
        redemption.digest,
        redemption.fingerprint,
        redemption.expiresAt,
        redemption.createdAt
      ]);
      await insertPostgresAudit(client, {
        id: auditId,
        action: "redemption_issued",
        subjectId: redemption.subjectId,
        credentialId: null,
        fingerprint: redemption.fingerprint,
        createdAt: redemption.createdAt
      });
    });
  }

  async redeem(input: RedeemInput): Promise<RedeemResult> {
    return this.transaction(async (client) => {
      const result = await client.query<PostgresRedemptionJoinRow>(`
        SELECT r.id, r.subject_id, r.digest, r.expires_at, r.used_at,
               s.label, s.capabilities_json,
               s.expires_at AS subject_expires_at, s.active,
               s.created_at AS subject_created_at, s.updated_at
        FROM authorization_redemptions r
        JOIN authorization_subjects s ON s.id = r.subject_id
        WHERE r.id = $1
        FOR UPDATE
      `, [input.tokenId]);
      const row = result.rows[0];
      if (!row || !safeDigestEqual(row.digest, input.tokenDigest)) {
        return { kind: "invalid" };
      }
      if (row.used_at !== null) return { kind: "used" };
      if (Number(row.expires_at) <= input.now) return { kind: "expired" };
      if (!row.active || Number(row.subject_expires_at) <= input.now) {
        return { kind: "denied" };
      }
      const subjectCapabilities = parseCapabilities(row.capabilities_json);
      if (input.requestedCapabilities.some(
        (capability) => !subjectCapabilities.includes(capability)
      )) {
        return { kind: "denied" };
      }
      await client.query(
        "UPDATE authorization_redemptions SET used_at = $1 WHERE id = $2",
        [input.now, input.tokenId]
      );
      await insertPostgresCredential(client, {
        ...input.credential,
        subjectId: row.subject_id,
        expiresAt: Number(row.subject_expires_at)
      });
      await client.query(`
        INSERT INTO authorization_activations (digest, credential_id, expires_at, used_at)
        VALUES ($1, $2, $3, NULL)
      `, [input.activationDigest, input.credential.id, input.activationExpiresAt]);
      await insertPostgresAudit(client, {
        id: input.auditId,
        action: "redemption_consumed",
        subjectId: row.subject_id,
        credentialId: input.credential.id,
        fingerprint: input.credential.fingerprint,
        createdAt: input.now
      });
      return {
        kind: "success",
        subject: {
          ...subjectFromPostgresJoinedRow(row),
          capabilities: subjectCapabilities
        }
      };
    });
  }

  async activate(
    activationDigest: string,
    now: number,
    auditId: string
  ): Promise<AuthorizationCredential | null> {
    return this.transaction(async (client) => {
      const result = await client.query<PostgresActivationJoinRow>(`
        SELECT a.digest AS activation_digest,
               a.expires_at AS activation_expires_at,
               a.used_at AS activation_used_at,
               c.id, c.subject_id, c.digest, c.fingerprint, c.status,
               c.expires_at, c.pending_expires_at, c.created_at, c.revoked_at
        FROM authorization_activations a
        JOIN authorization_credentials c ON c.id = a.credential_id
        WHERE a.digest = $1
        FOR UPDATE
      `, [activationDigest]);
      const row = result.rows[0];
      if (
        !row
        || row.activation_used_at !== null
        || Number(row.activation_expires_at) <= now
        || row.status !== "pending"
        || (row.pending_expires_at !== null && Number(row.pending_expires_at) <= now)
      ) return null;
      await client.query(
        "UPDATE authorization_activations SET used_at = $1 WHERE digest = $2",
        [now, activationDigest]
      );
      await client.query(`
        UPDATE authorization_credentials
        SET status = 'active', pending_expires_at = NULL
        WHERE id = $1 AND status = 'pending'
      `, [row.id]);
      await insertPostgresAudit(client, {
        id: auditId,
        action: "api_key_activated",
        subjectId: row.subject_id,
        credentialId: row.id,
        fingerprint: row.fingerprint,
        createdAt: now
      });
      return {
        ...credentialFromPostgresRow(row),
        status: "active",
        pendingExpiresAt: null
      };
    });
  }

  async consumeNonce(hash: string, expiresAt: number, now: number): Promise<boolean> {
    return this.transaction(async (client) => {
      await client.query("DELETE FROM authorization_nonces WHERE expires_at <= $1", [now]);
      const result = await client.query(`
        INSERT INTO authorization_nonces (nonce_hash, expires_at)
        VALUES ($1, $2)
        ON CONFLICT (nonce_hash) DO NOTHING
      `, [hash, expiresAt]);
      return result.rowCount === 1;
    });
  }

  async snapshot(limit = 100): Promise<AuthorizationDashboardSnapshot> {
    await this.initialize();
    const [subjectResult, credentialResult, redemptionResult, auditResult] = await Promise.all([
      this.pool.query<PostgresSubjectRow>(`
        SELECT id, label, capabilities_json, expires_at, active, created_at, updated_at
        FROM authorization_subjects ORDER BY created_at DESC LIMIT $1
      `, [limit]),
      this.pool.query<PostgresCredentialRow>(`
        SELECT id, subject_id, digest, fingerprint, status, expires_at,
               pending_expires_at, created_at, revoked_at
        FROM authorization_credentials ORDER BY created_at DESC LIMIT $1
      `, [limit * 5]),
      this.pool.query<PostgresRedemptionRow>(`
        SELECT id, subject_id, digest, fingerprint, expires_at, created_at, used_at
        FROM authorization_redemptions ORDER BY created_at DESC LIMIT $1
      `, [limit]),
      this.pool.query<PostgresAuditRow>(`
        SELECT id, action, subject_id, credential_id, fingerprint, created_at
        FROM authorization_audit ORDER BY created_at DESC LIMIT $1
      `, [limit])
    ]);
    return {
      subjects: subjectResult.rows.map((row) => {
        const subject = subjectFromPostgresRow(row);
        return {
          ...subject,
          credentials: credentialResult.rows
            .filter((credential) => credential.subject_id === subject.id)
            .map((credential) => {
              const parsed = credentialFromPostgresRow(credential);
              return {
                id: parsed.id,
                fingerprint: parsed.fingerprint,
                status: parsed.status,
                expiresAt: parsed.expiresAt,
                createdAt: parsed.createdAt,
                revokedAt: parsed.revokedAt
              };
            })
        };
      }),
      redemptions: redemptionResult.rows.map((row) => ({
        id: row.id,
        subjectId: row.subject_id,
        fingerprint: row.fingerprint,
        expiresAt: Number(row.expires_at),
        createdAt: Number(row.created_at),
        usedAt: row.used_at === null ? null : Number(row.used_at)
      })),
      audit: auditResult.rows.map((row) => ({
        id: row.id,
        action: row.action,
        subjectId: row.subject_id,
        credentialId: row.credential_id,
        fingerprint: row.fingerprint,
        createdAt: Number(row.created_at)
      }))
    };
  }

  async cleanup(now: number): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`
        UPDATE authorization_credentials
        SET status = 'revoked', revoked_at = $1
        WHERE status = 'pending' AND pending_expires_at <= $1
      `, [now]);
      await client.query("DELETE FROM authorization_activations WHERE expires_at <= $1", [now]);
      await client.query("DELETE FROM authorization_nonces WHERE expires_at <= $1", [now]);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(AUTHORIZATION_POSTGRES_SCHEMA);
      await client.query(`
        INSERT INTO gateway_schema_migrations (version)
        VALUES (3)
        ON CONFLICT (version) DO NOTHING
      `);
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
      throw error;
    } finally {
      client.release();
    }
  }
}

const AUTHORIZATION_POSTGRES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS authorization_subjects (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    active BOOLEAN NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS authorization_credentials (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL REFERENCES authorization_subjects(id),
    digest TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'revoked')),
    expires_at BIGINT NOT NULL,
    pending_expires_at BIGINT,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT
  );
  CREATE INDEX IF NOT EXISTS authorization_credentials_subject
    ON authorization_credentials(subject_id, status);
  CREATE TABLE IF NOT EXISTS authorization_redemptions (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL REFERENCES authorization_subjects(id),
    digest TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    used_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS authorization_activations (
    digest TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL REFERENCES authorization_credentials(id),
    expires_at BIGINT NOT NULL,
    used_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS authorization_nonces (
    nonce_hash TEXT PRIMARY KEY,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS authorization_audit (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    subject_id TEXT,
    credential_id TEXT,
    fingerprint TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS authorization_audit_created
    ON authorization_audit(created_at DESC);
`;

interface SqliteSubjectRow {
  id: string;
  label: string;
  capabilities_json: string;
  expires_at: number;
  active: number;
  created_at: number;
  updated_at: number;
}

interface SqliteCredentialRow {
  id: string;
  subject_id: string;
  digest: string;
  fingerprint: string;
  status: CredentialStatus;
  expires_at: number;
  pending_expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
}

interface SqliteRedemptionRow {
  id: string;
  subject_id: string;
  digest: string;
  fingerprint: string;
  expires_at: number;
  created_at: number;
  used_at: number | null;
}

interface SqliteRedemptionJoinRow {
  id: string;
  subject_id: string;
  digest: string;
  expires_at: number;
  used_at: number | null;
  label: string;
  capabilities_json: string;
  subject_expires_at: number;
  active: number;
  subject_created_at: number;
  updated_at: number;
}

interface SqliteActivationJoinRow extends SqliteCredentialRow {
  activation_digest: string;
  activation_expires_at: number;
  activation_used_at: number | null;
}

interface SqliteAuditRow {
  id: string;
  action: string;
  subject_id: string | null;
  credential_id: string | null;
  fingerprint: string | null;
  created_at: number;
}

interface PostgresSubjectRow {
  id: string;
  label: string;
  capabilities_json: string;
  expires_at: string | number;
  active: boolean;
  created_at: string | number;
  updated_at: string | number;
}

interface PostgresCredentialRow {
  id: string;
  subject_id: string;
  digest: string;
  fingerprint: string;
  status: CredentialStatus;
  expires_at: string | number;
  pending_expires_at: string | number | null;
  created_at: string | number;
  revoked_at: string | number | null;
}

interface PostgresRedemptionRow {
  id: string;
  subject_id: string;
  digest: string;
  fingerprint: string;
  expires_at: string | number;
  created_at: string | number;
  used_at: string | number | null;
}

interface PostgresRedemptionJoinRow extends PostgresSubjectRow {
  subject_id: string;
  digest: string;
  used_at: string | number | null;
  subject_expires_at: string | number;
  subject_created_at: string | number;
}

interface PostgresActivationJoinRow extends PostgresCredentialRow {
  activation_digest: string;
  activation_expires_at: string | number;
  activation_used_at: string | number | null;
}

interface PostgresAuditRow {
  id: string;
  action: string;
  subject_id: string | null;
  credential_id: string | null;
  fingerprint: string | null;
  created_at: string | number;
}

function subjectFromRow(row: SqliteSubjectRow): AuthorizationSubject {
  return {
    id: row.id,
    label: row.label,
    capabilities: parseCapabilities(row.capabilities_json),
    expiresAt: row.expires_at,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function subjectFromPostgresRow(row: PostgresSubjectRow): AuthorizationSubject {
  return {
    id: row.id,
    label: row.label,
    capabilities: parseCapabilities(row.capabilities_json),
    expiresAt: Number(row.expires_at),
    active: row.active,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function subjectFromPostgresJoinedRow(
  row: PostgresRedemptionJoinRow
): AuthorizationSubject {
  return {
    id: row.subject_id,
    label: row.label,
    capabilities: parseCapabilities(row.capabilities_json),
    expiresAt: Number(row.subject_expires_at),
    active: row.active,
    createdAt: Number(row.subject_created_at),
    updatedAt: Number(row.updated_at)
  };
}

function credentialFromRow(row: SqliteCredentialRow): AuthorizationCredential {
  return {
    id: row.id,
    subjectId: row.subject_id,
    digest: row.digest,
    fingerprint: row.fingerprint,
    status: row.status,
    expiresAt: row.expires_at,
    pendingExpiresAt: row.pending_expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  };
}

function credentialFromPostgresRow(
  row: PostgresCredentialRow
): AuthorizationCredential {
  return {
    id: row.id,
    subjectId: row.subject_id,
    digest: row.digest,
    fingerprint: row.fingerprint,
    status: row.status,
    expiresAt: Number(row.expires_at),
    pendingExpiresAt: row.pending_expires_at === null
      ? null
      : Number(row.pending_expires_at),
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at)
  };
}

function parseCapabilities(value: string): AuthorizationCapability[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is AuthorizationCapability =>
      item === "official_metadata_gateway" || item === "together_listening"
  );
}

function insertSqliteCredential(
  database: DatabaseSync,
  credential: AuthorizationCredential
): void {
  database.prepare(`
    INSERT INTO authorization_credentials (
      id, subject_id, digest, fingerprint, status, expires_at,
      pending_expires_at, created_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    credential.id,
    credential.subjectId,
    credential.digest,
    credential.fingerprint,
    credential.status,
    credential.expiresAt,
    credential.pendingExpiresAt,
    credential.createdAt,
    credential.revokedAt
  );
}

async function insertPostgresCredential(
  client: PoolClient,
  credential: AuthorizationCredential
): Promise<void> {
  await client.query(`
    INSERT INTO authorization_credentials (
      id, subject_id, digest, fingerprint, status, expires_at,
      pending_expires_at, created_at, revoked_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    credential.id,
    credential.subjectId,
    credential.digest,
    credential.fingerprint,
    credential.status,
    credential.expiresAt,
    credential.pendingExpiresAt,
    credential.createdAt,
    credential.revokedAt
  ]);
}

async function insertPostgresAudit(
  client: PoolClient,
  entry: AuthorizationAuditEntry
): Promise<void> {
  await client.query(`
    INSERT INTO authorization_audit (
      id, action, subject_id, credential_id, fingerprint, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    entry.id,
    entry.action,
    entry.subjectId,
    entry.credentialId,
    entry.fingerprint,
    entry.createdAt
  ]);
}

function securePermissions(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && process.platform !== "win32") throw error;
  }
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}
