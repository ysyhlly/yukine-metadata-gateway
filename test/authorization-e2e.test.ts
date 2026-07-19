import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes
} from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CloudAuthorizationError,
  CloudAuthorizationService,
  CredentialEnvelope,
  FileKekProvider,
  InMemoryCloudAuthorizationStore,
  InMemoryEphemeralStore,
  SafeIssuerHttpClient,
  type TrustedIssuer
} from "../yukine-cloud/src/index.js";
import type { NodeGatewayConfig } from "../src/node/config.js";
import { startNodeGateway } from "../src/node/server.js";
import type { SafeJsonResponse } from "../yukine-cloud/src/safe-http.js";

test("API key, redemption, forged response, and capability paths close end to end", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yukine-authorization-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const config: NodeGatewayConfig = {
    host: "127.0.0.1",
    port,
    cacheDbPath: join(directory, "cache.sqlite"),
    cacheTtlSeconds: 60,
    cacheStaleSeconds: 60,
    cacheMaxEntries: 100,
    memoryCacheMaxEntries: 10,
    upstreamTimeoutMs: 500,
    requestTimeoutMs: 2_000,
    maxConcurrentRequests: 20,
    maxRequestsPerSecond: 100,
    appUserAgent: "Yukine-Authorization-Test/1.0",
    stateBackend: "sqlite",
    dashboard: {
      dbPath: join(directory, "dashboard.sqlite"),
      publicOrigin: "http://localhost",
      setupToken: "authorization-test-setup-token-32-characters",
      assetsPath: join(process.cwd(), "assets"),
      sessionIdleMs: 30 * 60_000,
      sessionAbsoluteMs: 8 * 60 * 60_000,
      retentionDays: 30,
      backend: "sqlite"
    },
    authorization: {
      issuerId: "official-test",
      keyId: "test-key-1",
      privateKeyPem,
      credentialPepper: randomBytes(32),
      publicOrigin: origin,
      dbPath: join(directory, "authorization.sqlite"),
      backend: "sqlite"
    }
  };
  const runtime = startNodeGateway(config);
  await onceListening(runtime.server);
  assert.equal(await runtime.ready(), true);
  assert.ok(runtime.authorization);

  const issuer: TrustedIssuer = {
    issuerId: "official-test",
    displayName: "YUKINE 测试官方网关",
    origin,
    verifyPath: "/v1/authorization/verify",
    redeemPathPrefix: "/v1/authorization/redeem/",
    activatePath: "/v1/authorization/activate",
    capabilities: ["official_metadata_gateway", "together_listening"],
    publicKeys: { "test-key-1": publicKeyPem },
    timeoutMs: 1_000,
    maxResponseBytes: 64 * 1024,
    enabled: true,
    allowPrivateForTests: true
  };
  const cloudStore = new InMemoryCloudAuthorizationStore();
  await cloudStore.upsertTrustedIssuer(issuer);
  const kekPath = join(directory, "kek");
  writeFileSync(kekPath, randomBytes(32));
  const cloud = new CloudAuthorizationService({
    store: cloudStore,
    ephemeral: new InMemoryEphemeralStore(100),
    envelope: new CredentialEnvelope(new FileKekProvider("test-kek", kekPath))
  });

  try {
    const setup = await fetch(`${origin}/admin/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({
        username: "admin",
        password: "authorization-dashboard-password",
        setupToken: "authorization-test-setup-token-32-characters"
      })
    });
    assert.equal(setup.status, 201);
    const login = await fetch(`${origin}/admin/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({
        username: "admin",
        password: "authorization-dashboard-password"
      })
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0]!;
    const initialSnapshotResponse = await fetch(`${origin}/admin/api/snapshot`, {
      headers: { Cookie: cookie }
    });
    const initialSnapshot = await initialSnapshotResponse.json() as {
      csrfToken: string;
    };
    const adminHeaders = {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      Cookie: cookie,
      "X-CSRF-Token": initialSnapshot.csrfToken
    };
    const createSubject = await fetch(`${origin}/admin/api/authorization/subjects`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        label: "双能力",
        capabilities: ["official_metadata_gateway", "together_listening"],
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString()
      })
    });
    assert.equal(createSubject.status, 201);
    const both = (await createSubject.json() as { subject: { id: string } }).subject;
    const issueKey = await fetch(
      `${origin}/admin/api/authorization/subjects/${both.id}/api-keys`,
      { method: "POST", headers: adminHeaders, body: "{}" }
    );
    assert.equal(issueKey.status, 201);
    const apiKey = (await issueKey.json() as {
      credential: { value: string; fingerprint: string };
    }).credential;
    const dashboardHtml = await (await fetch(`${origin}/admin`, {
      headers: { Cookie: cookie }
    })).text();
    assert.match(dashboardHtml, /id="panel-authorization"/);
    assert.match(dashboardHtml, /请立即复制/);
    const authorizationSnapshot = await (await fetch(`${origin}/admin/api/snapshot`, {
      headers: { Cookie: cookie }
    })).json() as {
      authorization: { subjects: Array<{ id: string }> };
    };
    assert.equal(authorizationSnapshot.authorization.subjects[0]?.id, both.id);

    const bound = await cloud.bindApiKey("user-1", {
      issuerId: issuer.issuerId,
      apiKey: apiKey.value
    });
    assert.deepEqual(bound.capabilities, [
      "official_metadata_gateway",
      "together_listening"
    ]);
    assert.equal(JSON.stringify(await cloudStore.getBinding("user-1")).includes(apiKey.value), false);

    const noKeyMetadata = await fetch(`${origin}/v2/lyrics/search?title=test`);
    assert.equal(noKeyMetadata.status, 401);
    const authorizedMetadata = await fetch(`${origin}/v2/lyrics/search`, {
      headers: { Authorization: `Bearer ${apiKey.value}` }
    });
    assert.equal(authorizedMetadata.status, 400);
    const noKeyAlbumMetadata = await fetch(`${origin}/v2/albums/search?title=test`);
    assert.equal(noKeyAlbumMetadata.status, 401);
    const authorizedAlbumMetadata = await fetch(`${origin}/v2/albums/search`, {
      headers: { Authorization: `Bearer ${apiKey.value}` }
    });
    assert.equal(authorizedAlbumMetadata.status, 400);

    const replayNonce = randomBytes(32).toString("base64url");
    const firstVerify = await fetch(`${origin}/v1/authorization/verify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.value}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        protocolVersion: "yukine-auth/v1",
        nonce: replayNonce
      })
    });
    assert.equal(firstVerify.status, 200);
    const replay = await fetch(`${origin}/v1/authorization/verify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.value}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        protocolVersion: "yukine-auth/v1",
        nonce: replayNonce
      })
    });
    assert.equal(replay.status, 409);

    const redeemSubject = await runtime.authorization.createSubject({
      label: "兑换能力",
      capabilities: ["official_metadata_gateway"],
      expiresAt: Date.now() + 60 * 60_000
    });
    const redemption = await runtime.authorization.issueRedemption(
      redeemSubject.id,
      Date.now() + 15 * 60_000
    );
    const deniedRedemption = await fetch(redemption.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "yukine-auth/v1",
        nonce: randomBytes(32).toString("base64url"),
        requestedCapabilities: ["not_a_real_capability"]
      })
    });
    assert.equal(deniedRedemption.status, 400);
    const capabilityDeniedRedemption = await fetch(redemption.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "yukine-auth/v1",
        nonce: randomBytes(32).toString("base64url"),
        requestedCapabilities: ["official_metadata_gateway", "together_listening"]
      })
    });
    assert.equal(capabilityDeniedRedemption.status, 403);
    const acceptedRedemption = await fetch(redemption.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "yukine-auth/v1",
        nonce: randomBytes(32).toString("base64url"),
        requestedCapabilities: ["official_metadata_gateway"]
      })
    });
    assert.equal(acceptedRedemption.status, 200);
    const pending = await acceptedRedemption.json() as {
      activationToken: string;
    };
    const activated = await fetch(`${origin}/v1/authorization/activate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pending.activationToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        protocolVersion: "yukine-auth/v1",
        nonce: randomBytes(32).toString("base64url")
      })
    });
    assert.equal(activated.status, 200);

    const cloudRedemption = await runtime.authorization.issueRedemption(
      redeemSubject.id,
      Date.now() + 15 * 60_000
    );
    const redeemed = await cloud.redeemAndBind("user-2", {
      issuerId: issuer.issuerId,
      url: cloudRedemption.value
    });
    assert.match(redeemed.clientCredential.apiKey, /^yk_api_/);
    assert.equal(redeemed.binding.status, "active");
    await assert.rejects(
      cloud.redeemAndBind("user-3", {
        issuerId: issuer.issuerId,
        url: cloudRedemption.value
      }),
      (error) => error instanceof CloudAuthorizationError
        && error.code === "authorization_denied"
    );

    const forgedStore = new InMemoryCloudAuthorizationStore();
    await forgedStore.upsertTrustedIssuer(issuer);
    const realHttp = new SafeIssuerHttpClient();
    const forgedHttp = {
      async postJson(...args: Parameters<SafeIssuerHttpClient["postJson"]>): Promise<SafeJsonResponse> {
        const response = await realHttp.postJson(...args);
        if (
          response.status === 200
          && response.body
          && typeof response.body === "object"
          && "signature" in response.body
        ) {
          return {
            ...response,
            body: { ...(response.body as Record<string, unknown>), active: false }
          };
        }
        return response;
      }
    };
    const forgedCloud = new CloudAuthorizationService({
      store: forgedStore,
      ephemeral: new InMemoryEphemeralStore(100),
      envelope: new CredentialEnvelope(new FileKekProvider("test-kek", kekPath)),
      httpClient: forgedHttp as SafeIssuerHttpClient
    });
    await assert.rejects(
      forgedCloud.bindApiKey("forged-user", {
        issuerId: issuer.issuerId,
        apiKey: apiKey.value
      }),
      (error) => error instanceof CloudAuthorizationError
        && error.code === "authorization_invalid"
    );
    assert.equal(await forgedStore.getBinding("forged-user"), null);

    const metadataOnly = await runtime.authorization.createSubject({
      label: "仅元数据",
      capabilities: ["official_metadata_gateway"],
      expiresAt: Date.now() + 60 * 60_000
    });
    const metadataOnlyKey = await runtime.authorization.issueApiKey(metadataOnly.id);
    await cloud.bindApiKey("metadata-user", {
      issuerId: issuer.issuerId,
      apiKey: metadataOnlyKey.value
    });
    await assert.rejects(
      cloud.requireCapability("metadata-user", "together_listening"),
      (error) => error instanceof CloudAuthorizationError
        && error.code === "authorization_denied"
    );

    const togetherOnly = await runtime.authorization.createSubject({
      label: "仅一起听",
      capabilities: ["together_listening"],
      expiresAt: Date.now() + 60 * 60_000
    });
    const togetherOnlyKey = await runtime.authorization.issueApiKey(togetherOnly.id);
    await cloud.bindApiKey("together-user", {
      issuerId: issuer.issuerId,
      apiKey: togetherOnlyKey.value
    });
    assert.equal(
      (await cloud.requireCapability("together-user", "together_listening"))
        .capabilities.includes("together_listening"),
      true
    );
    const deniedMetadata = await fetch(`${origin}/v2/lyrics/search?title=test`, {
      headers: { Authorization: `Bearer ${togetherOnlyKey.value}` }
    });
    assert.equal(deniedMetadata.status, 403);

    await assert.rejects(
      cloud.bindApiKey("copy-user", {
        issuerId: issuer.issuerId,
        apiKey: apiKey.value
      }),
      (error) => error instanceof CloudAuthorizationError
        && error.code === "authorization_conflict"
    );
    const authDbBytes = readFileSync(join(directory, "authorization.sqlite"), "latin1");
    assert.equal(authDbBytes.includes(apiKey.value), false);
  } finally {
    await cloud.close();
    runtime.close();
    await onceClosed(runtime.server);
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function onceListening(server: ReturnType<typeof startNodeGateway>["server"]): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function onceClosed(server: ReturnType<typeof startNodeGateway>["server"]): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once("close", resolve));
}
