import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadNodeGatewayConfig } from "../src/node/config.js";

test("Node config keeps SQLite as the zero-dependency default", () => {
  const config = loadNodeGatewayConfig({});

  assert.equal(config.stateBackend, "sqlite");
  assert.equal(config.cacheStaleSeconds, 86_400);
  assert.equal(config.memoryCacheMaxEntries, 1_000);
  assert.equal(config.redisUrl, undefined);
  assert.equal(config.databaseUrl, undefined);
  assert.ok(config.instanceId);
  assert.equal(config.appVersion, "1.0.0");
  assert.equal(config.appRevision, "unknown");
});

test("external state requires both Redis and PostgreSQL URLs", () => {
  assert.throws(
    () => loadNodeGatewayConfig({ STATE_BACKEND: "external" }),
    /external_state_requires/
  );
  assert.throws(
    () => loadNodeGatewayConfig({
      STATE_BACKEND: "external",
      REDIS_URL: "redis://localhost:6379"
    }),
    /external_state_requires/
  );

  const config = loadNodeGatewayConfig({
    STATE_BACKEND: "external",
    REDIS_URL: "redis://localhost:6379",
    DATABASE_URL: "postgres://localhost/yukine"
  });

  assert.equal(config.stateBackend, "external");
  assert.equal(config.redisUrl, "redis://localhost:6379");
  assert.equal(config.databaseUrl, "postgres://localhost/yukine");
});

test("OpenTelemetry remains opt-in", () => {
  const disabled = loadNodeGatewayConfig({});
  const enabled = loadNodeGatewayConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    OTEL_SERVICE_NAME: "metadata-test"
  });

  assert.equal(disabled.otelEndpoint, undefined);
  assert.equal(enabled.otelEndpoint, "http://collector:4318");
  assert.equal(enabled.otelServiceName, "metadata-test");
});

test("runtime identity can be fixed by deployment metadata", () => {
  const config = loadNodeGatewayConfig({
    INSTANCE_ID: "gateway-a",
    APP_VERSION: "2.4.1",
    APP_REVISION: "release-20260719"
  });

  assert.equal(config.instanceId, "gateway-a");
  assert.equal(config.appVersion, "2.4.1");
  assert.equal(config.appRevision, "release-20260719");
});

test("trusted authorization is opt-in and fails closed without mounted secrets", () => {
  assert.equal(loadNodeGatewayConfig({}).authorization, undefined);
  assert.throws(
    () => loadNodeGatewayConfig({ AUTHORIZATION_ENABLED: "true" }),
    /authorization_issuer_id_required/
  );

  const directory = mkdtempSync(join(tmpdir(), "yukine-config-auth-"));
  const privateKeyPath = join(directory, "signing.pem");
  const pepperPath = join(directory, "pepper");
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    privateKeyPath,
    privateKey.export({ format: "pem", type: "pkcs8" })
  );
  writeFileSync(pepperPath, randomBytes(32));
  const config = loadNodeGatewayConfig({
    AUTHORIZATION_ENABLED: "true",
    AUTHORIZATION_ISSUER_ID: "official-staging",
    AUTHORIZATION_KEY_ID: "signing-2026-07",
    AUTHORIZATION_PRIVATE_KEY_FILE: privateKeyPath,
    AUTHORIZATION_CREDENTIAL_PEPPER_FILE: pepperPath,
    AUTHORIZATION_PUBLIC_ORIGIN: "https://metadata.example.com",
    CACHE_DB_PATH: join(directory, "cache.sqlite")
  });
  assert.equal(config.authorization?.issuerId, "official-staging");
  assert.equal(config.authorization?.credentialPepper.byteLength, 32);
  assert.equal(
    config.authorization?.dbPath,
    join(directory, "authorization.sqlite")
  );
});
