import assert from "node:assert/strict";
import test from "node:test";
import {
  BindingConflictError,
  PostgresCloudAuthorizationStore,
  type AuthorizationBinding,
  type TrustedIssuer
} from "../src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL enforces one current binding and issuer-subject uniqueness", {
  skip: !databaseUrl
}, async () => {
  const store = new PostgresCloudAuthorizationStore({ url: databaseUrl! });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const issuer = trustedIssuer(`issuer-${suffix}`);
  await store.initialize();
  await store.upsertTrustedIssuer(issuer);
  try {
    const first = binding(`user-a-${suffix}`, issuer.issuerId, `subject-${suffix}`);
    await store.replaceActive(first);
    assert.equal((await store.getBinding(first.userId))?.subject, first.subject);

    await assert.rejects(
      store.reserveCandidate(
        binding(`user-b-${suffix}`, issuer.issuerId, first.subject)
      ),
      (error) => error instanceof BindingConflictError
    );

    const replacement = binding(
      first.userId,
      issuer.issuerId,
      `replacement-${suffix}`
    );
    replacement.status = "pending";
    replacement.version = 2;
    await store.reserveCandidate(replacement);
    assert.equal((await store.getBinding(first.userId))?.subject, first.subject);
    const promoted = await store.promoteCandidate(first.userId, Date.now());
    assert.equal(promoted?.subject, replacement.subject);
    assert.equal((await store.getBinding(first.userId))?.subject, replacement.subject);
  } finally {
    await store.deleteBinding(`user-a-${suffix}`);
    await store.deleteBinding(`user-b-${suffix}`);
    await store.close();
  }
});

function trustedIssuer(issuerId: string): TrustedIssuer {
  return {
    issuerId,
    displayName: "Integration issuer",
    origin: "https://metadata.example.com",
    verifyPath: "/v1/authorization/verify",
    redeemPathPrefix: "/v1/authorization/redeem/",
    activatePath: "/v1/authorization/activate",
    capabilities: ["official_metadata_gateway", "together_listening"],
    publicKeys: { "key-1": "unused-in-store-test" },
    timeoutMs: 3_000,
    maxResponseBytes: 64 * 1024,
    enabled: true
  };
}

function binding(
  userId: string,
  issuerId: string,
  subject: string
): AuthorizationBinding {
  const now = Date.now();
  return {
    userId,
    issuerId,
    subject,
    credential: {
      version: 1,
      keyId: "test-kek",
      iv: "a",
      ciphertext: "b",
      tag: "c",
      wrappedDek: "d",
      wrapIv: "e",
      wrapTag: "f"
    },
    fingerprint: "0123456789abcdef",
    capabilities: ["official_metadata_gateway"],
    expiresAt: now + 60_000,
    status: "active",
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}
