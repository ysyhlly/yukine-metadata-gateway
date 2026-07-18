import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { RequestTrace } from "../types.js";
import { DashboardMetrics, type DashboardWindow } from "./dashboard-metrics.js";
import {
  AsyncGate,
  AttemptLimiter,
  clearSessionCookie,
  hashPassword,
  hashToken,
  normalizeUsername,
  parseCookies,
  randomToken,
  safeTextEqual,
  SESSION_COOKIE_NAME,
  sessionCookie,
  validatePassword,
  verifyPassword,
  WorkQueueBusyError
} from "./dashboard-security.js";
import { DashboardStore, type SessionRecord } from "./dashboard-store.js";
import type { DashboardStoreAdapter } from "./dashboard-store-adapter.js";
import { PostgresDashboardStore } from "./postgres-dashboard-store.js";
import { dashboardPage, loginPage, setupPage } from "./dashboard-ui.js";
import type { RuntimeStatsProvider } from "./runtime-stats.js";

const EMPTY_TRACE: RequestTrace = { cacheHit: false, upstream: [] };
const MAX_BODY_BYTES = 16 * 1024;
const WINDOWS = new Set<DashboardWindow>(["15m", "1h", "24h"]);

export interface DashboardConfig {
  dbPath: string;
  publicOrigin: string;
  setupToken?: string;
  assetsPath: string;
  sessionIdleMs: number;
  sessionAbsoluteMs: number;
  retentionDays: number;
  scryptLogN?: number;
  backend?: "sqlite" | "external";
  databaseUrl?: string;
}

export interface DashboardResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
  trace: RequestTrace;
}

export class Dashboard {
  private readonly store: DashboardStoreAdapter;
  private readonly metrics: DashboardMetrics;
  private readonly setupLimiter = new AttemptLimiter(5, 15 * 60_000);
  private readonly loginLimiter = new AttemptLimiter(8, 15 * 60_000);
  private readonly passwordGate = new AsyncGate(2);
  private readonly mascot: Buffer;
  private readonly paperBackground: Buffer;
  private readonly initialization: Promise<void>;
  private setupToken?: string;

  constructor(
    private readonly config: DashboardConfig,
    runtimeStats: RuntimeStatsProvider | (() => { entries: number; maxEntries: number })
  ) {
    const runtimeStatsProvider = normalizeRuntimeStats(runtimeStats, config);
    this.store = config.backend === "external"
      ? new PostgresDashboardStore({
          url: requiredDatabaseUrl(config),
          sessionIdleMs: config.sessionIdleMs,
          sessionAbsoluteMs: config.sessionAbsoluteMs,
          metricsRetentionMs: config.retentionDays * 24 * 60 * 60_000
        })
      : new DashboardStore({
          path: config.dbPath,
          sessionIdleMs: config.sessionIdleMs,
          sessionAbsoluteMs: config.sessionAbsoluteMs,
          metricsRetentionMs: config.retentionDays * 24 * 60 * 60_000
    });
    try {
      if (
        this.store instanceof DashboardStore
        && !this.store.hasAdmin()
        && !config.setupToken
      ) {
        throw new Error("dashboard_setup_token_required");
      }
      this.setupToken = config.setupToken;
      this.mascot = readFileSync(join(config.assetsPath, "gateway-mascot.png"));
      this.paperBackground = readFileSync(join(config.assetsPath, "paper-petals-bg.jpg"));
      this.metrics = new DashboardMetrics(this.store, {
        retentionDays: config.retentionDays,
        runtimeStats: runtimeStatsProvider
      });
      this.initialization = this.initialize();
    } catch (error) {
      void this.store.close();
      throw error;
    }
  }

  async ready(): Promise<boolean> {
    try {
      await this.initialization;
      return await this.store.ready?.() ?? true;
    } catch {
      return false;
    }
  }

  async handle(
    request: IncomingMessage,
    url: URL,
    requestId: string,
    clientIp: string
  ): Promise<DashboardResponse | null> {
    const method = request.method || "GET";
    if (method === "GET" && url.pathname === "/favicon.ico") {
      return asset(this.mascot, "image/png");
    }
    if (!url.pathname.startsWith("/admin")) return null;
    await this.initialization;

    if (method === "GET" && url.pathname === "/admin/assets/gateway-mascot.png") {
      return asset(this.mascot, "image/png");
    }
    if (method === "GET" && url.pathname === "/admin/assets/paper-petals-bg.jpg") {
      return asset(this.paperBackground, "image/jpeg");
    }

    if (method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      if (!await this.store.hasAdmin()) return redirect("/admin/setup");
      const session = await this.session(request);
      if (!session) return redirect("/admin/login");
      return html(dashboardPage(randomToken(18)));
    }
    if (method === "GET" && url.pathname === "/admin/setup") {
      return await this.store.hasAdmin()
        ? redirect("/admin/login")
        : html(setupPage(randomToken(18)));
    }
    if (method === "GET" && url.pathname === "/admin/login") {
      if (!await this.store.hasAdmin()) return redirect("/admin/setup");
      return await this.session(request)
        ? redirect("/admin")
        : html(loginPage(randomToken(18)));
    }
    if (method === "POST" && url.pathname === "/admin/api/setup") {
      return this.setup(request, requestId, clientIp);
    }
    if (method === "POST" && url.pathname === "/admin/api/login") {
      return this.login(request, requestId, clientIp);
    }
    if (method === "GET" && url.pathname === "/admin/api/snapshot") {
      return this.snapshot(request, url, requestId);
    }
    if (method === "POST" && url.pathname === "/admin/api/logout") {
      return this.logout(request, requestId);
    }
    return json(404, { error: "not_found", requestId });
  }

  record(
    route: string,
    status: number,
    durationMs: number,
    trace: RequestTrace,
    now = Date.now()
  ): void {
    this.metrics.record(route, status, durationMs, trace, now);
  }

  async close(): Promise<void> {
    await this.metrics.close();
    await this.store.close();
  }

  private async setup(
    request: IncomingMessage,
    requestId: string,
    clientIp: string
  ): Promise<DashboardResponse> {
    if (await this.store.hasAdmin()) {
      return json(409, { error: "setup_complete", requestId });
    }
    const originError = this.checkOrigin(request, requestId);
    if (originError) return originError;
    const rate = this.setupLimiter.check(clientIp);
    if (!rate.allowed) return rateLimited(requestId, rate.retryAfterSeconds);

    const parsed = await readJson(request, requestId);
    if ("response" in parsed) return parsed.response;
    const username = normalizeUsername(parsed.body.username);
    const password = validatePassword(parsed.body.password);
    const suppliedToken = typeof parsed.body.setupToken === "string"
      ? parsed.body.setupToken
      : "";
    if (
      !username
      || !password
      || !this.setupToken
      || !safeTextEqual(suppliedToken, this.setupToken)
    ) {
      return json(400, { error: "invalid_setup", requestId });
    }

    let passwordHash: string;
    try {
      passwordHash = await this.passwordGate.run(
        () => hashPassword(password, { logN: this.config.scryptLogN })
      );
    } catch (error) {
      if (error instanceof WorkQueueBusyError) return busy(requestId);
      throw error;
    }
    if (!await this.store.createAdmin(username, passwordHash, Date.now())) {
      return json(409, { error: "setup_complete", requestId });
    }
    this.setupToken = undefined;
    this.setupLimiter.reset(clientIp);
    return json(201, { ok: true });
  }

  private async login(
    request: IncomingMessage,
    requestId: string,
    clientIp: string
  ): Promise<DashboardResponse> {
    if (!await this.store.hasAdmin()) {
      return json(409, { error: "setup_required", requestId });
    }
    const originError = this.checkOrigin(request, requestId);
    if (originError) return originError;
    const rate = this.loginLimiter.check(clientIp);
    if (!rate.allowed) return rateLimited(requestId, rate.retryAfterSeconds);

    const parsed = await readJson(request, requestId);
    if ("response" in parsed) return parsed.response;
    const username = normalizeUsername(parsed.body.username);
    const password = validatePassword(parsed.body.password);
    const admin = await this.store.getAdmin();
    if (!username || !password || !admin) {
      return json(401, { error: "invalid_credentials", requestId });
    }
    let passwordMatches: boolean;
    try {
      passwordMatches = await this.passwordGate.run(
        () => verifyPassword(password, admin.passwordHash)
      );
    } catch (error) {
      if (error instanceof WorkQueueBusyError) return busy(requestId);
      throw error;
    }
    if (!passwordMatches || !safeTextEqual(username, admin.username)) {
      return json(401, { error: "invalid_credentials", requestId });
    }

    const token = randomToken();
    const csrfToken = randomToken();
    await this.store.createSession({
      tokenHash: hashToken(token),
      csrfToken,
      sessionVersion: admin.sessionVersion,
      createdAt: Date.now()
    });
    this.loginLimiter.reset(clientIp);
    const response = json(200, { ok: true });
    response.headers["Set-Cookie"] = sessionCookie(
      token,
      Math.floor(this.config.sessionAbsoluteMs / 1_000)
    );
    return response;
  }

  private async snapshot(
    request: IncomingMessage,
    url: URL,
    requestId: string
  ): Promise<DashboardResponse> {
    const session = await this.session(request);
    if (!session) return json(401, { error: "authentication_required", requestId });
    const requestedWindow = url.searchParams.get("window") || "1h";
    const window = WINDOWS.has(requestedWindow as DashboardWindow)
      ? requestedWindow as DashboardWindow
      : "1h";
    return json(200, {
      ...await this.metrics.snapshot(window),
      csrfToken: session.csrfToken
    });
  }

  private async logout(
    request: IncomingMessage,
    requestId: string
  ): Promise<DashboardResponse> {
    const originError = this.checkOrigin(request, requestId);
    if (originError) return originError;
    const session = await this.session(request);
    const suppliedCsrf = header(request, "x-csrf-token");
    if (!session || !suppliedCsrf || !safeTextEqual(suppliedCsrf, session.csrfToken)) {
      return json(403, { error: "forbidden", requestId });
    }
    await this.store.revokeSession(session.tokenHash, Date.now());
    const response = json(200, { ok: true });
    response.headers["Set-Cookie"] = clearSessionCookie();
    return response;
  }

  private async session(request: IncomingMessage): Promise<SessionRecord | null> {
    const token = parseCookies(header(request, "cookie")).get(SESSION_COOKIE_NAME);
    if (!token || token.length > 128) return null;
    return this.store.resolveSession(hashToken(token), Date.now());
  }

  private checkOrigin(
    request: IncomingMessage,
    requestId: string
  ): DashboardResponse | null {
    const origin = header(request, "origin");
    return origin === this.config.publicOrigin
      ? null
      : json(403, { error: "forbidden", requestId });
  }

  private async initialize(): Promise<void> {
    if (this.store instanceof PostgresDashboardStore) await this.store.initialize();
    if (!await this.store.hasAdmin() && !this.config.setupToken) {
      throw new Error("dashboard_setup_token_required");
    }
  }
}

function requiredDatabaseUrl(config: DashboardConfig): string {
  if (!config.databaseUrl) throw new Error("dashboard_database_url_required");
  return config.databaseUrl;
}

function normalizeRuntimeStats(
  value: RuntimeStatsProvider | (() => { entries: number; maxEntries: number }),
  config: DashboardConfig
): RuntimeStatsProvider {
  if (typeof value !== "function") return value;
  const startedAt = Date.now();
  return {
    snapshot: () => {
      const now = Date.now();
      const cache = value();
      return {
        instanceId: "test-instance",
        version: "1.0.0",
        revision: "unknown",
        runtime: "node",
        stateBackend: config.backend === "external" ? "external" : "sqlite",
        ready: true,
        heartbeatAt: now,
        startedAt,
        uptimeSeconds: Math.max(0, Math.floor((now - startedAt) / 1_000)),
        cache: {
          l1: {
            layer: "memory",
            entries: 0,
            maxEntries: 0,
            connected: true
          },
          l2: {
            layer: config.backend === "external" ? "redis" : "sqlite",
            entries: cache.entries,
            maxEntries: cache.maxEntries,
            connected: true
          }
        },
        singleflight: { flights: 0, waiters: 0 },
        ingress: {
          active: 0,
          limit: 0,
          requestsThisSecond: 0,
          rateLimit: 0
        },
        providers: []
      };
    }
  };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(
  request: IncomingMessage,
  requestId: string
): Promise<
  | { body: Record<string, unknown> }
  | { response: DashboardResponse }
> {
  const contentType = header(request, "content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { response: json(415, { error: "unsupported_media_type", requestId }) };
  }
  const declaredLength = Number.parseInt(header(request, "content-length") || "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    request.resume();
    return { response: json(413, { error: "payload_too_large", requestId }) };
  }
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        request.resume();
        return { response: json(413, { error: "payload_too_large", requestId }) };
      }
      chunks.push(buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { response: json(400, { error: "invalid_request", requestId }) };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { response: json(400, { error: "invalid_request", requestId }) };
  }
}

function html(body: string): DashboardResponse {
  const nonceMatch = body.match(/<script nonce="([^"]+)">/);
  const nonce = nonceMatch?.[1] || "";
  return {
    status: 200,
    body,
    trace: EMPTY_TRACE,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",
        "connect-src 'self'"
      ].join("; "),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  };
}

function json(status: number, body: unknown): DashboardResponse {
  return {
    status,
    body: JSON.stringify(body),
    trace: EMPTY_TRACE,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  };
}

function asset(body: Buffer, contentType: string): DashboardResponse {
  return {
    status: 200,
    body,
    trace: EMPTY_TRACE,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400, immutable",
      "Content-Length": String(body.length),
      "X-Content-Type-Options": "nosniff"
    }
  };
}

function redirect(location: string): DashboardResponse {
  return {
    status: 303,
    body: "",
    trace: EMPTY_TRACE,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Content-Length": "0",
      "Referrer-Policy": "no-referrer"
    }
  };
}

function rateLimited(requestId: string, retryAfterSeconds: number): DashboardResponse {
  const response = json(429, { error: "rate_limited", requestId });
  response.headers["Retry-After"] = String(retryAfterSeconds);
  return response;
}

function busy(requestId: string): DashboardResponse {
  const response = json(503, { error: "temporarily_unavailable", requestId });
  response.headers["Retry-After"] = "3";
  return response;
}
