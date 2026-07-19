import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  CloudAuthorizationError,
  CloudAuthorizationService
} from "./authorization-service.js";
import { CredentialEnvelope, FileKekProvider } from "./credential-crypto.js";
import { RedisEphemeralStore } from "./ephemeral.js";
import {
  PostgresCloudAuthorizationStore,
  type CloudAuthorizationStore
} from "./store.js";
import type { TrustedIssuer } from "./types.js";

const MAX_BODY_BYTES = 16 * 1024;
const issuerSchema = z.strictObject({
  issuerId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(80),
  origin: z.string().url(),
  verifyPath: z.string().startsWith("/"),
  redeemPathPrefix: z.string().startsWith("/"),
  activatePath: z.string().startsWith("/"),
  capabilities: z.array(z.enum([
    "official_metadata_gateway",
    "together_listening"
  ])).min(1),
  publicKeys: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().min(100).max(10_000),
  maxResponseBytes: z.number().int().min(1_024).max(1024 * 1024),
  enabled: z.boolean(),
  allowPrivateForTests: z.boolean().optional()
});

export interface CloudTestHostOptions {
  host: string;
  port: number;
  service: CloudAuthorizationService;
  store: CloudAuthorizationStore;
}

export function startCloudTestHost(options: CloudTestHostOptions) {
  if (process.env.NODE_ENV !== "test" || !isLoopbackHost(options.host)) {
    throw new Error("cloud_test_host_requires_test_loopback");
  }
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || `${options.host}:${options.port}`}`
    );
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/ready") {
        send(response, await options.store.ready() ? 200 : 503, {
          ready: await options.store.ready()
        });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/__test/v1/trusted-issuers") {
        const body = issuerSchema.parse(await readJson(request));
        await options.store.upsertTrustedIssuer(trustedIssuerFromInput(body));
        send(response, 201, { ok: true });
        return;
      }
      const userId = singleHeader(request.headers["x-test-user-id"]);
      if (!userId || !url.pathname.startsWith("/__test/v1/me/authorization")) {
        request.resume();
        send(response, 404, { error: "not_found", requestId });
        return;
      }
      if (request.method === "GET" && url.pathname === "/__test/v1/me/authorization") {
        send(response, 200, {
          authorization: await options.service.getBinding(userId)
        });
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/__test/v1/me/authorization") {
        request.resume();
        await options.service.deleteBinding(userId);
        send(response, 204, null);
        return;
      }
      if (request.method === "PUT" && url.pathname === "/__test/v1/me/authorization") {
        const body = await readJson(request);
        if (body.mode === "api_key") {
          const binding = await options.service.bindApiKey(userId, {
            issuerId: String(body.issuerId || ""),
            apiKey: String(body.apiKey || "")
          });
          send(response, 200, { authorization: binding });
          return;
        }
        if (body.mode === "redemption_url") {
          const result = await options.service.redeemAndBind(userId, {
            issuerId: String(body.issuerId || ""),
            url: String(body.url || "")
          });
          send(response, 200, result);
          return;
        }
        throw new CloudAuthorizationError(400, "invalid_request");
      }
      if (
        request.method === "POST"
        && url.pathname === "/__test/v1/me/authorization/revalidate"
      ) {
        request.resume();
        send(response, 200, {
          authorization: await options.service.revalidate(userId)
        });
        return;
      }
      if (
        request.method === "POST"
        && url.pathname === "/__test/v1/me/authorization/require"
      ) {
        const body = await readJson(request);
        const capability = body.capability === "official_metadata_gateway"
          ? "official_metadata_gateway"
          : body.capability === "together_listening"
            ? "together_listening"
            : null;
        if (!capability) throw new CloudAuthorizationError(400, "invalid_request");
        send(response, 200, {
          authorization: await options.service.requireCapability(userId, capability)
        });
        return;
      }
      request.resume();
      send(response, 404, { error: "not_found", requestId });
    } catch (error) {
      request.resume();
      if (error instanceof CloudAuthorizationError) {
        send(response, error.status, { error: error.code, requestId });
        return;
      }
      if (error instanceof z.ZodError || (error as Error).message === "invalid_request") {
        send(response, 400, { error: "invalid_request", requestId });
        return;
      }
      send(response, 500, { error: "internal_error", requestId });
    }
  });
  server.listen(options.port, options.host);
  return {
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await options.service.close();
    }
  };
}

async function startFromEnvironment() {
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(process.env.PORT || "8790", 10);
  const databaseUrl = required(process.env.DATABASE_URL, "database_url_required");
  const redisUrl = required(process.env.REDIS_URL, "redis_url_required");
  const kekFile = required(process.env.CLOUD_KEK_FILE, "cloud_kek_file_required");
  const store = new PostgresCloudAuthorizationStore({ url: databaseUrl });
  const service = new CloudAuthorizationService({
    store,
    ephemeral: new RedisEphemeralStore(redisUrl),
    envelope: new CredentialEnvelope(
      new FileKekProvider(process.env.CLOUD_KEK_KEY_ID?.trim() || "local-v1", kekFile)
    )
  });
  await service.initialize();
  const seedFile = process.env.CLOUD_TRUSTED_ISSUER_SEED_FILE?.trim();
  if (seedFile) {
    const seed = issuerSchema.parse(
      JSON.parse(readFileSync(seedFile, "utf8")) as unknown
    );
    await store.upsertTrustedIssuer(trustedIssuerFromInput(seed));
  }
  startCloudTestHost({ host, port, service, store });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = singleHeader(request.headers["content-type"]) || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new Error("invalid_request");
  }
  const declared = Number.parseInt(
    singleHeader(request.headers["content-length"]) || "0",
    10
  );
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error("invalid_request");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("invalid_request");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_request");
  }
  return parsed as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(status === 204 ? undefined : JSON.stringify(body));
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1"
    || host === "::1"
    || host === "localhost"
    || (
      host === "0.0.0.0"
      && process.env.CLOUD_TEST_CONTAINER?.trim().toLowerCase() === "true"
    );
}

function required(value: string | undefined, error: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(error);
  return normalized;
}

function trustedIssuerFromInput(
  body: z.infer<typeof issuerSchema>
): TrustedIssuer {
  return {
    issuerId: body.issuerId,
    displayName: body.displayName,
    origin: body.origin,
    verifyPath: body.verifyPath,
    redeemPathPrefix: body.redeemPathPrefix,
    activatePath: body.activatePath,
    capabilities: body.capabilities,
    publicKeys: body.publicKeys,
    timeoutMs: body.timeoutMs,
    maxResponseBytes: body.maxResponseBytes,
    enabled: body.enabled,
    ...(body.allowPrivateForTests === undefined
      ? {}
      : { allowPrivateForTests: body.allowPrivateForTests })
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startFromEnvironment().catch(() => {
    process.stderr.write("yukine-cloud-test-host: initialization_failed\n");
    process.exitCode = 1;
  });
}
