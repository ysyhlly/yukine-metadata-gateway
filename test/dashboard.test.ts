import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { DashboardMetrics } from "../src/node/dashboard-metrics.js";
import { DashboardStore } from "../src/node/dashboard-store.js";
import { startNodeGateway } from "../src/node/server.js";

const PUBLIC_ORIGIN = "http://localhost";
const SETUP_TOKEN = "setup-token-with-at-least-thirty-two-characters";

test("fresh dashboard storage refuses to start without a bootstrap token", async (context) => {
  const directory = await temporaryDirectory();
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  assert.throws(() => startNodeGateway({
    ...baseConfig(directory),
    dashboard: {
      ...dashboardConfig(directory),
      setupToken: undefined
    }
  }));
});

test("dashboard setup, login, metrics snapshot and logout are protected", async (context) => {
  const directory = await temporaryDirectory();
  const runtime = startNodeGateway({
    ...baseConfig(directory),
    dashboard: dashboardConfig(directory)
  });
  context.after(async () => {
    if (runtime.server.listening) {
      runtime.close();
      await once(runtime.server, "close");
    }
    await rm(directory, { recursive: true, force: true });
  });
  if (!runtime.server.listening) await once(runtime.server, "listening");
  const address = runtime.server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const setupPage = await fetch(`${origin}/admin/setup`);
  assert.equal(setupPage.status, 200);
  assert.equal(setupPage.headers.get("cache-control"), "no-store");
  assert.match(setupPage.headers.get("content-security-policy") || "", /script-src 'nonce-/);
  assert.match(await setupPage.text(), /history\.replaceState/);

  const oversized = await fetch(`${origin}/admin/api/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PUBLIC_ORIGIN
    },
    body: JSON.stringify({ padding: "x".repeat(17 * 1024) })
  });
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(`${origin}/health`)).status, 200);

  const wrongOrigin = await fetch(`${origin}/admin/api/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.invalid"
    },
    body: JSON.stringify({
      username: "admin",
      password: "high-entropy-password",
      setupToken: SETUP_TOKEN
    })
  });
  assert.equal(wrongOrigin.status, 403);

  const setup = await fetch(`${origin}/admin/api/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PUBLIC_ORIGIN
    },
    body: JSON.stringify({
      username: "admin",
      password: "high-entropy-password",
      setupToken: SETUP_TOKEN
    })
  });
  assert.equal(setup.status, 201);

  const secondSetup = await fetch(`${origin}/admin/api/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PUBLIC_ORIGIN
    },
    body: JSON.stringify({
      username: "other",
      password: "another-secure-password",
      setupToken: SETUP_TOKEN
    })
  });
  assert.equal(secondSetup.status, 409);

  const failedLogin = await fetch(`${origin}/admin/api/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PUBLIC_ORIGIN
    },
    body: JSON.stringify({ username: "admin", password: "wrong-password-value" })
  });
  assert.equal(failedLogin.status, 401);

  const login = await fetch(`${origin}/admin/api/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PUBLIC_ORIGIN
    },
    body: JSON.stringify({ username: "admin", password: "high-entropy-password" })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") || "";
  assert.match(setCookie, /__Host-yukine_gateway_session=/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(";")[0]!;
  const rawSessionToken = cookie.slice(cookie.indexOf("=") + 1);

  runtime.dashboard?.record(
    "/v1/recordings/search",
    200,
    42,
    {
      cacheHit: true,
      upstream: [{ host: "musicbrainz.org", status: 200 }]
    }
  );

  const unauthorized = await fetch(`${origin}/admin/api/snapshot?window=1h`);
  assert.equal(unauthorized.status, 401);

  const snapshotResponse = await fetch(`${origin}/admin/api/snapshot?window=1h`, {
    headers: { Cookie: cookie }
  });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json() as {
    csrfToken: string;
    summary: { requests: number; cacheHitRate: number };
    routes: Array<{ route: string }>;
  };
  assert.equal(snapshot.summary.requests, 1);
  assert.equal(snapshot.summary.cacheHitRate, 1);
  assert.equal(snapshot.routes[0]?.route, "/v1/recordings/search");

  const badLogout = await fetch(`${origin}/admin/api/logout`, {
    method: "POST",
    headers: {
      Origin: PUBLIC_ORIGIN,
      Cookie: cookie,
      "X-CSRF-Token": "wrong"
    }
  });
  assert.equal(badLogout.status, 403);

  const logout = await fetch(`${origin}/admin/api/logout`, {
    method: "POST",
    headers: {
      Origin: PUBLIC_ORIGIN,
      Cookie: cookie,
      "X-CSRF-Token": snapshot.csrfToken
    }
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);

  const revoked = await fetch(`${origin}/admin/api/snapshot`, {
    headers: { Cookie: cookie }
  });
  assert.equal(revoked.status, 401);

  const storedBytes = databaseBytes(join(directory, "dashboard.sqlite"));
  assert.doesNotMatch(
    storedBytes,
    /high-entropy-password|setup-token-with-at-least|admin\/api\/setup/
  );
  assert.equal(storedBytes.includes(rawSessionToken), false);
});

test("dashboard metrics survive reopening the same SQLite file", async (context) => {
  const directory = await temporaryDirectory();
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "dashboard.sqlite");
  const options = {
    path,
    sessionIdleMs: 30 * 60_000,
    sessionAbsoluteMs: 8 * 60 * 60_000,
    metricsRetentionMs: 30 * 24 * 60 * 60_000
  };
  const firstStore = new DashboardStore(options);
  const firstMetrics = new DashboardMetrics(firstStore, {
    retentionDays: 30,
    cacheStats: () => ({ entries: 2, maxEntries: 10 })
  });
  firstMetrics.record(
    "/v1/lyrics/search",
    200,
    80,
    { cacheHit: false, upstream: [{ host: "lrclib.net", status: 200 }] }
  );
  firstMetrics.close();
  firstStore.close();

  const reopenedStore = new DashboardStore(options);
  const reopenedMetrics = new DashboardMetrics(reopenedStore, {
    retentionDays: 30,
    cacheStats: () => ({ entries: 2, maxEntries: 10 })
  });
  const snapshot = reopenedMetrics.snapshot("1h");
  assert.equal(snapshot.summary.requests, 1);
  assert.equal(snapshot.routes[0]?.route, "/v1/lyrics/search");
  assert.equal(snapshot.upstream[0]?.host, "lrclib.net");
  reopenedMetrics.close();
  reopenedStore.close();
});

function baseConfig(directory: string) {
  return {
    host: "127.0.0.1",
    port: 0,
    cacheDbPath: join(directory, "cache.sqlite"),
    cacheTtlSeconds: 3_600,
    cacheMaxEntries: 10_000,
    upstreamTimeoutMs: 500,
    requestTimeoutMs: 2_000,
    appUserAgent: "GatewayDashboardTest/1.0"
  };
}

function dashboardConfig(directory: string) {
  return {
    dbPath: join(directory, "dashboard.sqlite"),
    publicOrigin: PUBLIC_ORIGIN,
    setupToken: SETUP_TOKEN,
    assetsPath: resolve("assets"),
    sessionIdleMs: 30 * 60_000,
    sessionAbsoluteMs: 8 * 60 * 60_000,
    retentionDays: 30,
    scryptLogN: 12
  };
}

function databaseBytes(path: string): string {
  let combined = "";
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      combined += readFileSync(candidate).toString("latin1");
    } catch {
      // Optional SQLite sidecar.
    }
  }
  return combined;
}

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "yukine-dashboard-"));
}
