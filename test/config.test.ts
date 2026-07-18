import assert from "node:assert/strict";
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
