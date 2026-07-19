import type {
  AuthorizationCapability,
  SignedAuthorization
} from "@yukine/authorization-contract";

export interface TrustedIssuer {
  issuerId: string;
  displayName: string;
  origin: string;
  verifyPath: string;
  redeemPathPrefix: string;
  activatePath: string;
  capabilities: AuthorizationCapability[];
  publicKeys: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
  enabled: boolean;
  allowPrivateForTests?: boolean;
}

export interface EncryptedCredential {
  version: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapTag: string;
}

export type BindingStatus = "pending" | "active";

export interface AuthorizationBinding {
  userId: string;
  issuerId: string;
  subject: string;
  credential: EncryptedCredential;
  fingerprint: string;
  capabilities: AuthorizationCapability[];
  expiresAt: number;
  status: BindingStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface PublicAuthorizationBinding {
  issuerId: string;
  issuerName: string;
  subject: string;
  fingerprint: string;
  capabilities: AuthorizationCapability[];
  expiresAt: string;
  status: BindingStatus;
}

export interface VerifiedGatewayAuthorization {
  issuer: TrustedIssuer;
  authorization: SignedAuthorization;
}
