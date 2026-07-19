import { createHash, randomBytes } from "node:crypto";
import {
  AuthorizationContractError,
  AUTHORIZATION_PROTOCOL_VERSION,
  randomNonce,
  verifyAuthorization,
  type AuthorizationCapability,
  type SignedAuthorization
} from "@yukine/authorization-contract";
import { z } from "zod";
import { CredentialEnvelope } from "./credential-crypto.js";
import type { CloudEphemeralStore } from "./ephemeral.js";
import { SafeHttpError, SafeIssuerHttpClient } from "./safe-http.js";
import {
  BindingConflictError,
  type CloudAuthorizationStore
} from "./store.js";
import type {
  AuthorizationBinding,
  PublicAuthorizationBinding,
  TrustedIssuer,
  VerifiedGatewayAuthorization
} from "./types.js";

const redeemedResponseSchema = z.strictObject({
  apiKey: z.string().min(32).max(512),
  activationToken: z.string().min(32).max(512),
  activationExpiresAt: z.iso.datetime({ offset: true }),
  authorization: z.unknown()
});

export class CloudAuthorizationError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "invalid_request"
      | "authorization_required"
      | "authorization_denied"
      | "authorization_conflict"
      | "authorization_invalid"
      | "authorization_unavailable"
      | "rate_limited"
  ) {
    super(code);
    this.name = "CloudAuthorizationError";
  }
}

export interface CloudAuthorizationServiceOptions {
  store: CloudAuthorizationStore;
  ephemeral: CloudEphemeralStore;
  envelope: CredentialEnvelope;
  httpClient?: SafeIssuerHttpClient;
  now?: () => number;
}

export class CloudAuthorizationService {
  private readonly store: CloudAuthorizationStore;
  private readonly ephemeral: CloudEphemeralStore;
  private readonly envelope: CredentialEnvelope;
  private readonly http: SafeIssuerHttpClient;
  private readonly now: () => number;

  constructor(options: CloudAuthorizationServiceOptions) {
    this.store = options.store;
    this.ephemeral = options.ephemeral;
    this.envelope = options.envelope;
    this.http = options.httpClient || new SafeIssuerHttpClient();
    this.now = options.now || Date.now;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async bindApiKey(
    userId: string,
    input: { issuerId: string; apiKey: string }
  ): Promise<PublicAuthorizationBinding> {
    validateUserId(userId);
    validateSecret(input.apiKey);
    const issuer = await this.requireIssuer(input.issuerId);
    const verified = await this.verifyWithApiKey(userId, issuer, input.apiKey, []);
    const existing = await this.store.getBinding(userId);
    const now = this.now();
    const version = (existing?.version || 0) + 1;
    const binding = await this.bindingFromVerified(
      userId,
      input.apiKey,
      version,
      verified,
      "active",
      existing?.createdAt || now,
      now
    );
    try {
      await this.store.replaceActive(binding);
    } catch (error) {
      if (error instanceof BindingConflictError) {
        throw new CloudAuthorizationError(409, "authorization_conflict");
      }
      throw error;
    }
    return publicBinding(binding, issuer);
  }

  async redeemAndBind(
    userId: string,
    input: { issuerId: string; url: string }
  ): Promise<{
    binding: PublicAuthorizationBinding;
    clientCredential: {
      type: "api_key";
      apiKey: string;
      gatewayOrigin: string;
    };
  }> {
    validateUserId(userId);
    const issuer = await this.requireIssuer(input.issuerId);
    const redeemNonce = await this.freshNonce(userId);
    const response = await this.callGateway(
      issuer,
      input.url,
      "redeem",
      {},
      {
        protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
        nonce: redeemNonce
      }
    );
    if (response.status !== 200) throw gatewayStatusError(response.status);
    const parsed = redeemedResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new CloudAuthorizationError(502, "authorization_invalid");
    }
    validateSecret(parsed.data.apiKey);
    validateSecret(parsed.data.activationToken);
    const verified = this.verifyGatewayResponse(
      issuer,
      parsed.data.authorization,
      redeemNonce,
      []
    );
    const existing = await this.store.getBinding(userId);
    const now = this.now();
    const version = (existing?.version || 0) + 1;
    const candidate = await this.bindingFromVerified(
      userId,
      parsed.data.apiKey,
      version,
      verified,
      "pending",
      now,
      now
    );
    try {
      await this.store.reserveCandidate(candidate);
    } catch (error) {
      if (error instanceof BindingConflictError) {
        throw new CloudAuthorizationError(409, "authorization_conflict");
      }
      throw error;
    }

    try {
      const activationNonce = await this.freshNonce(userId);
      const activation = await this.callGateway(
        issuer,
        new URL(issuer.activatePath, issuer.origin).toString(),
        "activate",
        { Authorization: `Bearer ${parsed.data.activationToken}` },
        {
          protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
          nonce: activationNonce
        }
      );
      if (activation.status !== 200) throw gatewayStatusError(activation.status);
      const activated = this.verifyGatewayResponse(
        issuer,
        activation.body,
        activationNonce,
        []
      );
      if (activated.authorization.subject !== verified.authorization.subject) {
        throw new CloudAuthorizationError(502, "authorization_invalid");
      }
      const promoted = await this.store.promoteCandidate(userId, this.now());
      if (!promoted) {
        throw new CloudAuthorizationError(503, "authorization_unavailable");
      }
      return {
        binding: publicBinding(promoted, issuer),
        clientCredential: {
          type: "api_key",
          apiKey: parsed.data.apiKey,
          gatewayOrigin: issuer.origin
        }
      };
    } catch (error) {
      await this.store.deleteCandidate(userId);
      throw normalizeCloudError(error);
    }
  }

  async revalidate(userId: string): Promise<PublicAuthorizationBinding> {
    const { binding, issuer, apiKey } = await this.currentCredential(userId);
    const verified = await this.verifyWithApiKey(userId, issuer, apiKey, []);
    ensureSameSubject(binding, verified.authorization);
    const updated: AuthorizationBinding = {
      ...binding,
      capabilities: verified.authorization.capabilities,
      expiresAt: Date.parse(verified.authorization.expiresAt),
      updatedAt: this.now()
    };
    await this.store.updateActive(updated);
    return publicBinding(updated, issuer);
  }

  async requireCapability(
    userId: string,
    capability: AuthorizationCapability
  ): Promise<PublicAuthorizationBinding> {
    const { binding, issuer, apiKey } = await this.currentCredential(userId);
    const verified = await this.verifyWithApiKey(userId, issuer, apiKey, [capability]);
    ensureSameSubject(binding, verified.authorization);
    if (!verified.authorization.capabilities.includes(capability)) {
      throw new CloudAuthorizationError(403, "authorization_denied");
    }
    const updated: AuthorizationBinding = {
      ...binding,
      capabilities: verified.authorization.capabilities,
      expiresAt: Date.parse(verified.authorization.expiresAt),
      updatedAt: this.now()
    };
    await this.store.updateActive(updated);
    return publicBinding(updated, issuer);
  }

  async getBinding(userId: string): Promise<PublicAuthorizationBinding | null> {
    validateUserId(userId);
    const binding = await this.store.getBinding(userId);
    if (!binding) return null;
    const issuer = await this.requireIssuer(binding.issuerId);
    return publicBinding(binding, issuer);
  }

  async deleteBinding(userId: string): Promise<void> {
    validateUserId(userId);
    await this.store.deleteBinding(userId);
  }

  async close(): Promise<void> {
    await Promise.all([this.store.close(), this.ephemeral.close()]);
  }

  private async verifyWithApiKey(
    userId: string,
    issuer: TrustedIssuer,
    apiKey: string,
    requestedCapabilities: AuthorizationCapability[]
  ): Promise<VerifiedGatewayAuthorization> {
    const nonce = await this.freshNonce(userId);
    const response = await this.callGateway(
      issuer,
      new URL(issuer.verifyPath, issuer.origin).toString(),
      "verify",
      { Authorization: `Bearer ${apiKey}` },
      {
        protocolVersion: AUTHORIZATION_PROTOCOL_VERSION,
        nonce,
        ...(requestedCapabilities.length ? { requestedCapabilities } : {})
      }
    );
    if (response.status !== 200) throw gatewayStatusError(response.status);
    return this.verifyGatewayResponse(
      issuer,
      response.body,
      nonce,
      requestedCapabilities
    );
  }

  private verifyGatewayResponse(
    issuer: TrustedIssuer,
    response: unknown,
    nonce: string,
    requestedCapabilities: AuthorizationCapability[]
  ): VerifiedGatewayAuthorization {
    let authorization: SignedAuthorization;
    try {
      authorization = verifyAuthorization(response, {
        issuerId: issuer.issuerId,
        nonce,
        publicKeys: new Map(Object.entries(issuer.publicKeys)),
        now: this.now()
      });
    } catch (error) {
      if (error instanceof AuthorizationContractError) {
        throw new CloudAuthorizationError(502, "authorization_invalid");
      }
      throw error;
    }
    if (
      !authorization.active
      || authorization.capabilities.some(
        (capability) => !issuer.capabilities.includes(capability)
      )
      || requestedCapabilities.some(
        (capability) => !authorization.capabilities.includes(capability)
      )
    ) {
      throw new CloudAuthorizationError(403, "authorization_denied");
    }
    return { issuer, authorization };
  }

  private async bindingFromVerified(
    userId: string,
    apiKey: string,
    version: number,
    verified: VerifiedGatewayAuthorization,
    status: "pending" | "active",
    createdAt: number,
    updatedAt: number
  ): Promise<AuthorizationBinding> {
    const encrypted = await this.envelope.encrypt(apiKey, {
      userId,
      issuerId: verified.issuer.issuerId,
      version
    });
    return {
      userId,
      issuerId: verified.issuer.issuerId,
      subject: verified.authorization.subject,
      credential: encrypted,
      fingerprint: fingerprint(apiKey),
      capabilities: verified.authorization.capabilities,
      expiresAt: Date.parse(verified.authorization.expiresAt),
      status,
      version,
      createdAt,
      updatedAt
    };
  }

  private async currentCredential(userId: string): Promise<{
    binding: AuthorizationBinding;
    issuer: TrustedIssuer;
    apiKey: string;
  }> {
    validateUserId(userId);
    const binding = await this.store.getBinding(userId);
    if (!binding || binding.status !== "active") {
      throw new CloudAuthorizationError(401, "authorization_required");
    }
    const issuer = await this.requireIssuer(binding.issuerId);
    let apiKey: string;
    try {
      apiKey = await this.envelope.decrypt(binding.credential, {
        userId,
        issuerId: binding.issuerId,
        version: binding.version
      });
    } catch {
      throw new CloudAuthorizationError(503, "authorization_unavailable");
    }
    return { binding, issuer, apiKey };
  }

  private async requireIssuer(issuerId: string): Promise<TrustedIssuer> {
    const issuer = await this.store.getTrustedIssuer(issuerId);
    if (!issuer || !issuer.enabled) {
      throw new CloudAuthorizationError(400, "invalid_request");
    }
    return issuer;
  }

  private async freshNonce(userId: string): Promise<string> {
    const nonce = randomNonce(randomBytes(32));
    if (!await this.ephemeral.reserve(userId, nonce, this.now())) {
      throw new CloudAuthorizationError(429, "rate_limited");
    }
    return nonce;
  }

  private async callGateway(
    issuer: TrustedIssuer,
    target: string,
    operation: "verify" | "redeem" | "activate",
    headers: Record<string, string>,
    body: unknown
  ) {
    try {
      return await this.http.postJson(issuer, target, operation, headers, body);
    } catch (error) {
      if (error instanceof SafeHttpError) {
        const clientError = [
          "invalid_url",
          "issuer_not_allowed",
          "path_not_allowed",
          "ssrf_blocked",
          "redirect_rejected"
        ].includes(error.code);
        throw new CloudAuthorizationError(
          clientError ? 400 : 503,
          clientError ? "invalid_request" : "authorization_unavailable"
        );
      }
      throw error;
    }
  }
}

function publicBinding(
  binding: AuthorizationBinding,
  issuer: TrustedIssuer
): PublicAuthorizationBinding {
  return {
    issuerId: binding.issuerId,
    issuerName: issuer.displayName,
    subject: binding.subject,
    fingerprint: binding.fingerprint,
    capabilities: binding.capabilities,
    expiresAt: new Date(binding.expiresAt).toISOString(),
    status: binding.status
  };
}

function gatewayStatusError(status: number): CloudAuthorizationError {
  if (status === 401 || status === 403 || status === 409 || status === 410) {
    return new CloudAuthorizationError(403, "authorization_denied");
  }
  if (status === 429) return new CloudAuthorizationError(429, "rate_limited");
  return new CloudAuthorizationError(503, "authorization_unavailable");
}

function normalizeCloudError(error: unknown): CloudAuthorizationError {
  if (error instanceof CloudAuthorizationError) return error;
  if (error instanceof BindingConflictError) {
    return new CloudAuthorizationError(409, "authorization_conflict");
  }
  return new CloudAuthorizationError(503, "authorization_unavailable");
}

function ensureSameSubject(
  binding: AuthorizationBinding,
  authorization: SignedAuthorization
): void {
  if (
    binding.issuerId !== authorization.issuerId
    || binding.subject !== authorization.subject
  ) {
    throw new CloudAuthorizationError(502, "authorization_invalid");
  }
}

function validateUserId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new CloudAuthorizationError(400, "invalid_request");
  }
}

function validateSecret(value: string): void {
  if (!value || value.length < 32 || value.length > 512 || /\s/.test(value)) {
    throw new CloudAuthorizationError(400, "invalid_request");
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
