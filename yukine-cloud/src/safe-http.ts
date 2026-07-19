import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { TrustedIssuer } from "./types.js";

export type IssuerOperation = "verify" | "redeem" | "activate";

export interface SafeJsonResponse {
  status: number;
  body: unknown;
}

export class SafeHttpError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SafeHttpError";
  }
}

export class SafeIssuerHttpClient {
  async postJson(
    issuer: TrustedIssuer,
    target: string,
    operation: IssuerOperation,
    headers: Record<string, string>,
    body: unknown
  ): Promise<SafeJsonResponse> {
    const startedAt = Date.now();
    const url = validateIssuerUrl(issuer, target, operation);
    const addresses = await withDeadline(
      resolveAddresses(url.hostname),
      issuer.timeoutMs
    );
    if (!issuer.allowPrivateForTests && addresses.some((entry) => isBlockedAddress(entry.address))) {
      throw new SafeHttpError("ssrf_blocked");
    }
    const selected = addresses[0];
    if (!selected) throw new SafeHttpError("dns_unavailable");
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    const remainingMs = Math.max(1, issuer.timeoutMs - (Date.now() - startedAt));
    return new Promise<SafeJsonResponse>((resolve, reject) => {
      const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = requestFn({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        method: "POST",
        path: url.pathname,
        servername: url.hostname,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(encoded.length),
          ...headers
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, selected.address, selected.family);
        }
      }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400) {
          response.resume();
          reject(new SafeHttpError("redirect_rejected"));
          return;
        }
        const declared = Number.parseInt(String(response.headers["content-length"] || "0"), 10);
        if (Number.isFinite(declared) && declared > issuer.maxResponseBytes) {
          response.resume();
          reject(new SafeHttpError("response_too_large"));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > issuer.maxResponseBytes) {
            response.destroy(new SafeHttpError("response_too_large"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", reject);
        response.once("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            resolve({ status, body: parsed });
          } catch {
            reject(new SafeHttpError("invalid_json_response"));
          }
        });
      });
      const deadline = setTimeout(() => {
        request.destroy(new SafeHttpError("authorization_timeout"));
      }, remainingMs);
      deadline.unref();
      request.once("close", () => clearTimeout(deadline));
      request.once("error", reject);
      request.end(encoded);
    });
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new SafeHttpError("authorization_timeout")),
          timeoutMs
        );
        timeout.unref();
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function validateIssuerUrl(
  issuer: TrustedIssuer,
  target: string,
  operation: IssuerOperation
): URL {
  let url: URL;
  let configuredOrigin: URL;
  try {
    url = new URL(target);
    configuredOrigin = new URL(issuer.origin);
  } catch {
    throw new SafeHttpError("invalid_url");
  }
  const allowedProtocol = issuer.allowPrivateForTests ? ["https:", "http:"] : ["https:"];
  if (
    !allowedProtocol.includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.origin !== configuredOrigin.origin
  ) {
    throw new SafeHttpError("issuer_not_allowed");
  }
  if (operation === "verify" && url.pathname !== issuer.verifyPath) {
    throw new SafeHttpError("path_not_allowed");
  }
  if (operation === "activate" && url.pathname !== issuer.activatePath) {
    throw new SafeHttpError("path_not_allowed");
  }
  if (operation === "redeem") {
    const prefix = issuer.redeemPathPrefix.endsWith("/")
      ? issuer.redeemPathPrefix
      : `${issuer.redeemPathPrefix}/`;
    const suffix = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : "";
    if (!suffix || suffix.includes("/") || !/^[A-Za-z0-9._-]+$/.test(suffix)) {
      throw new SafeHttpError("path_not_allowed");
    }
  }
  return url;
}

async function resolveAddresses(
  hostname: string
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const literal = isIP(hostname);
  if (literal) return [{ address: hostname, family: literal as 4 | 6 }];
  const results = await lookup(hostname, { all: true, verbatim: true });
  if (!results.length) throw new SafeHttpError("dns_unavailable");
  return results.map((entry) => ({
    address: entry.address,
    family: entry.family as 4 | 6
  }));
}

const blocked = new BlockList();
for (const [address, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["2001:db8::", 32, "ipv6"]
] as const) {
  blocked.addSubnet(address, prefix, type);
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    if (address.toLowerCase().startsWith("::ffff:")) {
      const mapped = address.slice(address.lastIndexOf(":") + 1);
      return isIP(mapped) === 4 && blocked.check(mapped, "ipv4");
    }
    return blocked.check(address, "ipv6");
  }
  return true;
}
