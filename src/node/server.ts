import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { handleGatewayRequest } from "../core.js";
import { JsonFetchTransport } from "../transport.js";
import type { GatewayResult } from "../types.js";
import { loadNodeGatewayConfig, type NodeGatewayConfig } from "./config.js";
import { SqliteJsonCache } from "./sqlite-cache.js";

export function startNodeGateway(config: NodeGatewayConfig = loadNodeGatewayConfig()) {
  const cache = new SqliteJsonCache({
    path: config.cacheDbPath,
    ttlSeconds: config.cacheTtlSeconds,
    maxEntries: config.cacheMaxEntries
  });
  const transport = new JsonFetchTransport({
    timeoutMs: config.upstreamTimeoutMs,
    cache
  });
  const server = createServer(
    {
      maxHeaderSize: 64 * 1024,
      requestTimeout: config.requestTimeoutMs
    },
    async (request, response) => {
      await serveRequest(request, response, config, transport);
    }
  );
  server.headersTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.listen(config.port, config.host);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      cache.close();
      process.exitCode = 0;
    });
    setTimeout(() => {
      server.closeAllConnections();
    }, Math.min(5_000, config.requestTimeoutMs)).unref();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return { server, close, cache };
}

async function serveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: NodeGatewayConfig,
  transport: JsonFetchTransport
): Promise<void> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const origin = `http://${request.headers.host || `${config.host}:${config.port}`}`;
  const url = new URL(request.url || "/", origin);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  request.once("aborted", () => controller.abort());
  let gatewayResult: GatewayResult;
  try {
    gatewayResult = await handleGatewayRequest(
      {
        method: request.method || "GET",
        url: url.toString(),
        requestId,
        signal: controller.signal
      },
      {
        env: {
          acoustidApiKey: config.acoustidApiKey,
          appUserAgent: config.appUserAgent,
          runtime: "node",
          cache: "sqlite"
        },
        transport
      }
    );
  } catch {
    gatewayResult = {
      status: 502,
      body: { error: "upstream_failure", requestId },
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      },
      trace: { cacheHit: false, upstream: [] }
    };
  } finally {
    clearTimeout(timeout);
  }
  response.writeHead(gatewayResult.status, gatewayResult.headers);
  response.end(JSON.stringify(gatewayResult.body));
  process.stdout.write(`${JSON.stringify({
    requestId,
    route: url.pathname,
    status: gatewayResult.status,
    durationMs: Date.now() - startedAt,
    cacheHit: gatewayResult.trace.cacheHit,
    upstream: gatewayResult.trace.upstream
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startNodeGateway();
  } catch {
    process.stderr.write("metadata-gateway: cache_initialization_failed\n");
    process.exitCode = 1;
  }
}
