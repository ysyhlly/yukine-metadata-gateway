import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  AUTHORIZATION_PROTOCOL_VERSION,
  authorizationRequestSchema,
  normalizeCapabilities,
  signAuthorization,
  type AuthorizationCapability,
  type AuthorizationRequest,
  type SignedAuthorization
} from "@yukine/authorization-contract";
import type {
  AuthorizationCredential,
  AuthorizationDashboardSnapshot,
  AuthorizationStore,
  AuthorizationSubject
} from "./authorization-store.js";

const API_KEY_PREFIX = "yk_api_";
const ACTIVATION_PREFIX = "yk_activation_";
const REDEMPTION_PATH = "/v1/authorization/redeem/";
const NONCE_TTL_MS = 15 * 60_000;
const PENDING_TTL_MS = 60_000;

export interface GatewayAuthorizationOptions {
  issuerId: string;
  keyId: string;
  privateKeyPem: string;
  credentialPepper: Uint8Array;
  publicOrigin: string;
  store: AuthorizationStore;
}

export interface IssuedSecret {
  value: string;
  fingerprint: string;
}

export interface RedeemedAuthorization {
  apiKey: string;
  activationToken: string;
  authorization: SignedAuthorization;
  activationExpiresAt: string;
}

export class GatewayAuthorizationError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "invalid_request"
      | "invalid_authorization"
      | "authorization_denied"
      | "nonce_replay"
      | "redemption_used"
      | "redemption_expired"
      | "activation_invalid"
  ) {
    super(code);
    this.name = "GatewayAuthorizationError";
  }
}

export class GatewayAuthorizationService {
  readonly issuerId: string;
  private readonly store: AuthorizationStore;
  private readonly keyId: string;
  private readonly privateKeyPem: string;
  private readonly pepper: Uint8Array;
  private readonly publicOrigin: string;

  constructor(options: GatewayAuthorizationOptions) {
    this.issuerId = options.issuerId;
    this.keyId = options.keyId;
    this.privateKeyPem = options.privateKeyPem;
    this.pepper = options.credentialPepper;
    this.publicOrigin = new URL(options.publicOrigin).origin;
    this.store = options.store;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.cleanup(Date.now());
  }

  ready(): Promise<boolean> {
    return this.store.ready();
  }

  async createSubject(input: {
    label: string;
    capabilities: AuthorizationCapability[];
    expiresAt: number;
  }, now = Date.now()): Promise<AuthorizationSubject> {
    const label = input.label.trim();
    if (!label || label.length > 80 || input.expiresAt <= now) {
      throw new GatewayAuthorizationError(400, "invalid_request");
    }
    const capabilities = normalizeCapabilities(input.capabilities);
    if (capabilities.length === 0) {
      throw new GatewayAuthorizationError(400, "invalid_request");
    }
    const subject: AuthorizationSubject = {
      id: `sub_${randomUUID()}`,
      label,
      capabilities,
      expiresAt: input.expiresAt,
      active: true,
      createdAt: now,
      updatedAt: now
    };
    if (!await this.store.createSubject(subject, randomUUID())) {
      throw new GatewayAuthorizationError(400, "invalid_request");
    }
    return subject;
  }

  async updateSubject(
    id: string,
    input: {
      label: string;
      capabilities: AuthorizationCapability[];
      expiresAt: number;
      active: boolean;
    },
    now = Date.now()
  ): Promise<boolean> {
    const label = input.label.trim();
    const capabilities = normalizeCapabilities(input.capabilities);
    if (!label || label.length > 80 || capabilities.length === 0 || input.expiresAt <= now) {
      throw new GatewayAuthorizationError(400, "invalid_request");
    }
    return this.store.updateSubject(
      id,
      { ...input, label, capabilities },
      now,
      randomUUID()
    );
  }

  async issueApiKey(subjectId: string, now = Date.now()): Promise<IssuedSecret> {
    const subject = await this.requireIssuableSubject(subjectId, now);
    const id = randomUUID();
    const apiKey = `${API_KEY_PREFIX}${id}.${randomBytes(32).toString("base64url")}`;
    const fingerprint = fingerprintOf(apiKey);
    await this.store.createCredential({
      id,
      subjectId: subject.id,
      digest: this.digest(apiKey),
      fingerprint,
      status: "active",
      expiresAt: subject.expiresAt,
      pendingExpiresAt: null,
      createdAt: now,
      revokedAt: null
    }, randomUUID());
    return { value: apiKey, fingerprint };
  }

  async issueRedemption(
    subjectId: string,
    redemptionExpiresAt: number,
    now = Date.now()
  ): Promise<IssuedSecret> {
    const subject = await this.requireIssuableSubject(subjectId, now);
    if (redemptionExpiresAt <= now || redemptionExpiresAt > subject.expiresAt) {
      throw new GatewayAuthorizationError(400, "invalid_request");
    }
    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const token = `${id}.${secret}`;
    const url = `${this.publicOrigin}${REDEMPTION_PATH}${token}`;
    const fingerprint = fingerprintOf(url);
    await this.store.createRedemption({
      id,
      subjectId,
      digest: this.digest(token),
      fingerprint,
      expiresAt: redemptionExpiresAt,
      createdAt: now,
      usedAt: null
    }, randomUUID());
    return { value: url, fingerprint };
  }

  async verify(
    authorizationHeader: string | undefined,
    body: unknown,
    now = Date.now()
  ): Promise<SignedAuthorization> {
    const request = this.parseRequest(body);
    const authenticated = await this.authenticateApiKey(authorizationHeader, now);
    this.requireRequestedCapabilities(authenticated.subject, request);
    await this.consumeNonce(request.nonce, now);
    return this.signSubject(authenticated.subject, request.nonce, now);
  }

  async authorizeMetadata(
    authorizationHeader: string | undefined,
    now = Date.now()
  ): Promise<AuthorizationSubject> {
    const authenticated = await this.authenticateApiKey(authorizationHeader, now);
    if (!authenticated.subject.capabilities.includes("official_metadata_gateway")) {
      throw new GatewayAuthorizationError(403, "authorization_denied");
    }
    return authenticated.subject;
  }

  async redeem(
    pathnameToken: string,
    body: unknown,
    now = Date.now()
  ): Promise<RedeemedAuthorization> {
    const request = this.parseRequest(body);
    const token = parseRedemptionToken(pathnameToken);
    if (!token) throw new GatewayAuthorizationError(401, "invalid_authorization");
    await this.consumeNonce(request.nonce, now);
    const credentialId = randomUUID();
    const apiKey = `${API_KEY_PREFIX}${credentialId}.${randomBytes(32).toString("base64url")}`;
    const activationToken = `${ACTIVATION_PREFIX}${randomBytes(32).toString("base64url")}`;
    const activationExpiresAt = now + PENDING_TTL_MS;
    const credential: AuthorizationCredential = {
      id: credentialId,
      subjectId: "",
      digest: this.digest(apiKey),
      fingerprint: fingerprintOf(apiKey),
      status: "pending",
      expiresAt: 0,
      pendingExpiresAt: activationExpiresAt,
      createdAt: now,
      revokedAt: null
    };
    const result = await this.store.redeem({
      tokenId: token.id,
      tokenDigest: this.digest(token.full),
      requestedCapabilities: request.requestedCapabilities || [],
      credential,
      activationDigest: this.digest(activationToken),
      activationExpiresAt,
      now,
      auditId: randomUUID()
    });
    if (result.kind === "invalid") {
      throw new GatewayAuthorizationError(401, "invalid_authorization");
    }
    if (result.kind === "used") {
      throw new GatewayAuthorizationError(410, "redemption_used");
    }
    if (result.kind === "expired") {
      throw new GatewayAuthorizationError(410, "redemption_expired");
    }
    if (result.kind === "denied") {
      throw new GatewayAuthorizationError(403, "authorization_denied");
    }
    if (!result.subject.active || result.subject.expiresAt <= now) {
      throw new GatewayAuthorizationError(403, "authorization_denied");
    }
    this.requireRequestedCapabilities(result.subject, request);
    credential.subjectId = result.subject.id;
    credential.expiresAt = result.subject.expiresAt;
    return {
      apiKey,
      activationToken,
      activationExpiresAt: new Date(activationExpiresAt).toISOString(),
      authorization: this.signSubject(result.subject, request.nonce, now)
    };
  }

  async activate(
    authorizationHeader: string | undefined,
    body: unknown,
    now = Date.now()
  ): Promise<SignedAuthorization> {
    const request = this.parseRequest(body);
    const activationToken = bearerToken(authorizationHeader);
    if (!activationToken?.startsWith(ACTIVATION_PREFIX)) {
      throw new GatewayAuthorizationError(401, "activation_invalid");
    }
    await this.consumeNonce(request.nonce, now);
    const credential = await this.store.activate(
      this.digest(activationToken),
      now,
      randomUUID()
    );
    if (!credential) {
      throw new GatewayAuthorizationError(401, "activation_invalid");
    }
    const subject = await this.store.getSubject(credential.subjectId);
    if (!subject || !subject.active || subject.expiresAt <= now) {
      throw new GatewayAuthorizationError(403, "authorization_denied");
    }
    this.requireRequestedCapabilities(subject, request);
    return this.signSubject(subject, request.nonce, now);
  }

  async revokeCredential(id: string, now = Date.now()): Promise<boolean> {
    return this.store.revokeCredential(id, now, randomUUID());
  }

  snapshot(): Promise<AuthorizationDashboardSnapshot> {
    return this.store.snapshot();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private parseRequest(body: unknown): AuthorizationRequest {
    const parsed = authorizationRequestSchema.safeParse(body);
    if (!parsed.success) throw new GatewayAuthorizationError(400, "invalid_request");
    return {
      ...parsed.data,
      requestedCapabilities: normalizeCapabilities(
        parsed.data.requestedCapabilities || []
      )
    };
  }

  private async authenticateApiKey(
    authorizationHeader: string | undefined,
    now: number
  ): Promise<{ credential: AuthorizationCredential; subject: AuthorizationSubject }> {
    const apiKey = bearerToken(authorizationHeader);
    const parsed = apiKey ? parseApiKey(apiKey) : null;
    if (!parsed) throw new GatewayAuthorizationError(401, "invalid_authorization");
    const credential = await this.store.getCredential(parsed.id);
    if (
      !credential
      || credential.status !== "active"
      || credential.revokedAt !== null
      || credential.expiresAt <= now
      || !safeDigestEqual(credential.digest, this.digest(apiKey!))
    ) {
      throw new GatewayAuthorizationError(401, "invalid_authorization");
    }
    const subject = await this.store.getSubject(credential.subjectId);
    if (!subject || !subject.active || subject.expiresAt <= now) {
      throw new GatewayAuthorizationError(403, "authorization_denied");
    }
    return { credential, subject };
  }

  private async requireIssuableSubject(
    subjectId: string,
    now: number
  ): Promise<AuthorizationSubject> {
    const subject = await this.store.getSubject(subjectId);
    if (!subject || !subject.active || subject.expiresAt <= now) {
      throw new GatewayAuthorizationError(403, "authorization_denied");
    }
    return subject;
  }

  private requireRequestedCapabilities(
    subject: AuthorizationSubject,
    request: AuthorizationRequest
  ): void {
    if (
      request.requestedCapabilities?.some(
        (capability) => !subject.capabilities.includes(capability)
      )
    ) {
      throw new GatewayAuthorizationError(403, "authorization_denied");
    }
  }

  private async consumeNonce(nonce: string, now: number): Promise<void> {
    const accepted = await this.store.consumeNonce(
      createHash("sha256").update(nonce).digest("hex"),
      now + NONCE_TTL_MS,
      now
    );
    if (!accepted) throw new GatewayAuthorizationError(409, "nonce_replay");
  }

  private signSubject(
    subject: AuthorizationSubject,
    nonce: string,
    now: number
  ): SignedAuthorization {
    return signAuthorization({
      protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
      issuerId: this.issuerId,
      subject: subject.id,
      active: subject.active && subject.expiresAt > now,
      capabilities: subject.capabilities,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(subject.expiresAt).toISOString(),
      nonce
    }, this.privateKeyPem, this.keyId);
  }

  private digest(value: string): string {
    return createHmac("sha256", this.pepper).update(value).digest("hex");
  }
}

export function bearerToken(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] || null;
}

export function fingerprintOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function parseApiKey(value: string): { id: string } | null {
  const match = /^yk_api_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ? { id: match[1] } : null;
}

function parseRedemptionToken(
  value: string
): { id: string; full: string } | null {
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ? { id: match[1], full: value } : null;
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}
