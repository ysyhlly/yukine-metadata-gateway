import { z } from "zod";

export const AUTHORIZATION_PROTOCOL_VERSION = "yukine-auth/v1" as const;
export const AUTHORIZATION_SIGNATURE_DOMAIN = "yukine-auth/v1\n";
export const AUTHORIZATION_CLOCK_SKEW_MS = 30_000;

export const capabilitySchema = z.enum([
  "official_metadata_gateway",
  "together_listening"
]);

export type AuthorizationCapability = z.infer<typeof capabilitySchema>;

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const nonceSchema = base64UrlSchema.length(43, "nonce_must_be_32_bytes");

export const authorizationRequestSchema = z.strictObject({
  protocolVersion: z.literal(AUTHORIZATION_PROTOCOL_VERSION),
  nonce: nonceSchema,
  requestedCapabilities: z.array(capabilitySchema).max(2).optional()
});

export const authorizationPayloadSchema = z.strictObject({
  protocolVersion: z.literal(AUTHORIZATION_PROTOCOL_VERSION),
  issuerId: z.string().min(1).max(128),
  subject: z.string().min(1).max(128),
  active: z.boolean(),
  capabilities: z.array(capabilitySchema).max(2),
  issuedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  nonce: nonceSchema
});

export const signatureSchema = z.strictObject({
  algorithm: z.literal("Ed25519"),
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  value: base64UrlSchema
});

export const signedAuthorizationSchema = authorizationPayloadSchema.extend({
  signature: signatureSchema
});

export const authorizationErrorSchema = z.strictObject({
  error: z.enum([
    "invalid_request",
    "invalid_authorization",
    "authorization_denied",
    "nonce_replay",
    "redemption_used",
    "redemption_expired",
    "activation_invalid",
    "rate_limited",
    "authorization_unavailable"
  ]),
  requestId: z.string()
});

export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
export type AuthorizationPayload = z.infer<typeof authorizationPayloadSchema>;
export type SignedAuthorization = z.infer<typeof signedAuthorizationSchema>;
export type AuthorizationError = z.infer<typeof authorizationErrorSchema>;

export function normalizeCapabilities(
  capabilities: readonly AuthorizationCapability[]
): AuthorizationCapability[] {
  return [...new Set(capabilities)].sort();
}
