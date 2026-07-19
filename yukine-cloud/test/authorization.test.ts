import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CredentialEnvelope,
  FileKekProvider,
  InMemoryCloudAuthorizationStore,
  BindingConflictError,
  SafeIssuerHttpClient,
  validateIssuerUrl,
  SafeHttpError,
  type AuthorizationBinding,
  type TrustedIssuer
} from "../src/index.js";

test("credential envelope decrypts only with matching user, issuer, and version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yukine-cloud-crypto-"));
  const keyPath = join(directory, "kek");
  writeFileSync(keyPath, randomBytes(32));
  const envelope = new CredentialEnvelope(new FileKekProvider("test-v1", keyPath));
  const context = { userId: "user-1", issuerId: "issuer-1", version: 4 };
  const encrypted = await envelope.encrypt("yk_api_secret-value", context);

  assert.equal(await envelope.decrypt(encrypted, context), "yk_api_secret-value");
  await assert.rejects(
    envelope.decrypt(encrypted, { ...context, userId: "user-2" })
  );
  assert.equal(JSON.stringify(encrypted).includes("secret-value"), false);
});

test("issuer URL validation rejects query tokens, similar prefixes, and non-HTTPS origins", () => {
  const issuer = trustedIssuer();
  assert.equal(
    validateIssuerUrl(
      issuer,
      "https://metadata.example.com/v1/authorization/redeem/id.secret",
      "redeem"
    ).pathname,
    "/v1/authorization/redeem/id.secret"
  );
  for (const target of [
    "http://metadata.example.com/v1/authorization/redeem/id.secret",
    "https://metadata.example.com/v1/authorization/redeem-evil/id.secret",
    "https://metadata.example.com/v1/authorization/redeem/id.secret?token=x",
    "https://user:pass@metadata.example.com/v1/authorization/redeem/id.secret"
  ]) {
    assert.throws(
      () => validateIssuerUrl(issuer, target, "redeem"),
      (error) => error instanceof SafeHttpError
    );
  }
});

test("one issuer subject cannot be reserved by two users", async () => {
  const store = new InMemoryCloudAuthorizationStore();
  await store.upsertTrustedIssuer(trustedIssuer());
  await store.replaceActive(binding("user-1"));
  await assert.rejects(
    store.reserveCandidate(binding("user-2")),
    (error) => error instanceof BindingConflictError
  );
});

test("safe HTTP client blocks private destinations before connecting", async () => {
  const issuer = {
    ...trustedIssuer(),
    origin: "https://127.0.0.1"
  };
  await assert.rejects(
    new SafeIssuerHttpClient().postJson(
      issuer,
      `${issuer.origin}${issuer.verifyPath}`,
      "verify",
      {},
      {}
    ),
    (error) => error instanceof SafeHttpError && error.code === "ssrf_blocked"
  );
});

test("safe HTTP client rejects redirects, oversized bodies, and timeouts", async (context) => {
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/redirect")) {
      response.writeHead(302, { Location: "http://127.0.0.1/elsewhere" });
      response.end();
      return;
    }
    if (request.url?.endsWith("/large")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ value: "x".repeat(256) }));
      return;
    }
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      }
    }, 200);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const issuer: TrustedIssuer = {
    ...trustedIssuer(),
    origin: `http://127.0.0.1:${address.port}`,
    allowPrivateForTests: true,
    timeoutMs: 50,
    maxResponseBytes: 64
  };
  const client = new SafeIssuerHttpClient();

  for (const [suffix, code] of [
    ["redirect", "redirect_rejected"],
    ["large", "response_too_large"],
    ["timeout", "authorization_timeout"]
  ] as const) {
    await assert.rejects(
      client.postJson(
        {
          ...issuer,
          timeoutMs: suffix === "timeout" ? 50 : 1_000
        },
        `${issuer.origin}${issuer.redeemPathPrefix}${suffix}`,
        "redeem",
        {},
        {}
      ),
      (error) => error instanceof SafeHttpError && error.code === code
    );
  }
});

function trustedIssuer(): TrustedIssuer {
  return {
    issuerId: "issuer-1",
    displayName: "Issuer",
    origin: "https://metadata.example.com",
    verifyPath: "/v1/authorization/verify",
    redeemPathPrefix: "/v1/authorization/redeem/",
    activatePath: "/v1/authorization/activate",
    capabilities: ["official_metadata_gateway", "together_listening"],
    publicKeys: { "key-1": "public-key" },
    timeoutMs: 3_000,
    maxResponseBytes: 64 * 1024,
    enabled: true
  };
}

function binding(userId: string): AuthorizationBinding {
  return {
    userId,
    issuerId: "issuer-1",
    subject: "shared-subject",
    credential: {
      version: 1,
      keyId: "key-1",
      iv: "a",
      ciphertext: "b",
      tag: "c",
      wrappedDek: "d",
      wrapIv: "e",
      wrapTag: "f"
    },
    fingerprint: "fingerprint",
    capabilities: ["official_metadata_gateway"],
    expiresAt: Date.now() + 60_000,
    status: "active",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}
