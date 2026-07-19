import {
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject
} from "node:crypto";
import {
  AUTHORIZATION_CLOCK_SKEW_MS,
  AUTHORIZATION_SIGNATURE_DOMAIN,
  authorizationPayloadSchema,
  normalizeCapabilities,
  signedAuthorizationSchema,
  type AuthorizationPayload,
  type SignedAuthorization
} from "./schema.js";
export * from "./schema.js";

export interface VerifyAuthorizationOptions {
  issuerId: string;
  nonce: string;
  publicKeys: ReadonlyMap<string, string | KeyObject>;
  now?: number;
  clockSkewMs?: number;
}

export class AuthorizationContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AuthorizationContractError";
  }
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
}

export function authorizationSigningBytes(
  payload: AuthorizationPayload
): Uint8Array {
  const { signature: _signature, ...unsigned } = payload as AuthorizationPayload & {
    signature?: unknown;
  };
  const parsed = authorizationPayloadSchema.parse({
    ...unsigned,
    capabilities: normalizeCapabilities(unsigned.capabilities)
  });
  return new TextEncoder().encode(
    AUTHORIZATION_SIGNATURE_DOMAIN + canonicalizeJson(parsed)
  );
}

export function signAuthorization(
  payload: AuthorizationPayload,
  privateKey: string | KeyObject,
  keyId: string
): SignedAuthorization {
  const normalized = authorizationPayloadSchema.parse({
    ...payload,
    capabilities: normalizeCapabilities(payload.capabilities)
  });
  const signature = nodeSign(
    null,
    authorizationSigningBytes(normalized),
    typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey
  );
  return signedAuthorizationSchema.parse({
    ...normalized,
    signature: {
      algorithm: "Ed25519",
      keyId,
      value: signature.toString("base64url")
    }
  });
}

export function verifyAuthorization(
  input: unknown,
  options: VerifyAuthorizationOptions
): SignedAuthorization {
  const parsed = signedAuthorizationSchema.safeParse(input);
  if (!parsed.success) throw new AuthorizationContractError("invalid_response");
  const response = parsed.data;
  if (response.issuerId !== options.issuerId) {
    throw new AuthorizationContractError("issuer_mismatch");
  }
  if (response.nonce !== options.nonce) {
    throw new AuthorizationContractError("nonce_mismatch");
  }
  const key = options.publicKeys.get(response.signature.keyId);
  if (!key) throw new AuthorizationContractError("unknown_key_id");
  const valid = nodeVerify(
    null,
    authorizationSigningBytes(response),
    typeof key === "string" ? createPublicKey(key) : key,
    Buffer.from(response.signature.value, "base64url")
  );
  if (!valid) throw new AuthorizationContractError("invalid_signature");

  const now = options.now ?? Date.now();
  const skew = options.clockSkewMs ?? AUTHORIZATION_CLOCK_SKEW_MS;
  const issuedAt = Date.parse(response.issuedAt);
  const expiresAt = Date.parse(response.expiresAt);
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > skew) {
    throw new AuthorizationContractError("issued_at_out_of_window");
  }
  if (!Number.isFinite(expiresAt) || expiresAt < now - skew || expiresAt <= issuedAt) {
    throw new AuthorizationContractError("authorization_expired");
  }
  return response;
}

export function randomNonce(random: Uint8Array): string {
  if (random.byteLength !== 32) {
    throw new AuthorizationContractError("nonce_must_be_32_bytes");
  }
  return Buffer.from(random).toString("base64url");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuthorizationContractError("non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort(compareUtf16)
      .map((key) => `${canonicalize(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new AuthorizationContractError("unsupported_json_value");
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new AuthorizationContractError("invalid_unicode");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new AuthorizationContractError("invalid_unicode");
    }
  }
}
