import type {
  UpstreamJsonCache,
  UpstreamJsonResult,
  UpstreamTransport
} from "./types.js";

const MUSICBRAINZ_HOST = "musicbrainz.org";
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface JsonFetchTransportOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  musicBrainzIntervalMs?: number;
  cloudflareCache?: boolean;
  cache?: UpstreamJsonCache;
}

export class JsonFetchTransport implements UpstreamTransport {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly musicBrainzIntervalMs: number;
  private readonly cloudflareCache: boolean;
  private readonly cache?: UpstreamJsonCache;
  private musicBrainzTail: Promise<void> = Promise.resolve();
  private nextMusicBrainzAt = 0;

  constructor(options: JsonFetchTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 4_500;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.musicBrainzIntervalMs = options.musicBrainzIntervalMs ?? 1_100;
    this.cloudflareCache = options.cloudflareCache ?? false;
    this.cache = options.cache;
  }

  async getJson(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal
  ): Promise<UpstreamJsonResult> {
    const host = safeHost(url);
    const now = Date.now();
    const cached = this.cache?.get(url, now);
    if (cached !== null && cached !== undefined) {
      try {
        return { kind: "success", data: JSON.parse(cached), status: 200, host, cacheHit: true };
      } catch {
        // A corrupt cache row is treated as a miss and replaced only after a successful fetch.
      }
    }

    try {
      await this.waitForMusicBrainz(host, signal);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      try {
        const init: RequestInit & { cf?: { cacheTtl: number; cacheEverything: boolean } } = {
          headers,
          signal: controller.signal
        };
        if (this.cloudflareCache) {
          init.cf = { cacheTtl: 3_600, cacheEverything: true };
        }
        const response = await fetch(url, init);
        if (response.status === 404) {
          return { kind: "not_found", status: 404, host, cacheHit: false };
        }
        if (!response.ok) {
          return { kind: "failure", status: response.status, host, cacheHit: false };
        }
        const body = await readBoundedBody(response, this.maxResponseBytes);
        const data = JSON.parse(body);
        this.cache?.put(url, JSON.stringify(data), Date.now());
        return { kind: "success", data, status: response.status, host, cacheHit: false };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    } catch {
      return { kind: "failure", status: 0, host, cacheHit: false };
    }
  }

  private async waitForMusicBrainz(host: string, signal?: AbortSignal): Promise<void> {
    if (host !== MUSICBRAINZ_HOST) return;
    let release = (): void => {};
    const previous = this.musicBrainzTail;
    this.musicBrainzTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.nextMusicBrainzAt - Date.now());
      if (waitMs > 0) await abortableDelay(waitMs, signal);
      this.nextMusicBrainzAt = Date.now() + this.musicBrainzIntervalMs;
    } finally {
      release();
    }
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > maxBytes) throw new Error("upstream_response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const value = await reader.read();
    if (value.done) break;
    size += value.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("upstream_response_too_large");
    }
    chunks.push(value.value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "invalid";
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(complete, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
