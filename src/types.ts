export type GatewayRuntime = "worker" | "node";

export interface GatewayEnvironment {
  acoustidApiKey?: string;
  appUserAgent: string;
  runtime: GatewayRuntime;
  cache: "cloudflare" | "sqlite" | "redis";
  v2Enabled?: boolean;
  v1SunsetDate?: string;
}

export interface UpstreamAttempt {
  host: string;
  status: number;
  provider?: string;
  durationMs?: number;
  outcome?: UpstreamOutcome;
  cacheState?: CacheState;
  cacheLayer?: CacheLayer;
}

export interface RequestTrace {
  cacheHit: boolean;
  upstream: UpstreamAttempt[];
}

export type UpstreamJsonResult =
  | {
      kind: "success";
      data: unknown;
      status: number;
      host: string;
      provider?: string;
      cacheHit: boolean;
      cacheState?: CacheState;
      cacheLayer?: CacheLayer;
      durationMs?: number;
      outcome?: "success";
    }
  | {
      kind: "not_found";
      status: 404;
      host: string;
      provider?: string;
      cacheHit: false;
      cacheState?: "miss";
      cacheLayer?: CacheLayer;
      durationMs?: number;
      outcome?: "not_found";
    }
  | {
      kind: "failure";
      status: number;
      host: string;
      provider?: string;
      cacheHit: false;
      cacheState?: "miss";
      cacheLayer?: CacheLayer;
      durationMs?: number;
      outcome?: Exclude<UpstreamOutcome, "success" | "not_found">;
    };

export type CacheState = "fresh" | "stale" | "miss";
export type CacheLayer = "memory" | "sqlite" | "redis" | "cloudflare" | "none";

export type UpstreamOutcome =
  | "success"
  | "not_found"
  | "timeout"
  | "aborted"
  | "network"
  | "http"
  | "parse"
  | "response_too_large"
  | "circuit_open";

export interface UpstreamRequestOptions {
  provider?: string;
  defer?: (task: Promise<void>) => void;
}

export interface UpstreamTransport {
  getJson(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
    options?: UpstreamRequestOptions
  ): Promise<UpstreamJsonResult>;
}

export interface GatewayRequest {
  method: string;
  url: string;
  requestId: string;
  signal?: AbortSignal;
  traceparent?: string;
  tracestate?: string;
}

export interface GatewayContext {
  env: GatewayEnvironment;
  transport: UpstreamTransport;
  defer?: (task: Promise<void>) => void;
  ready?: () => boolean | Promise<boolean>;
  telemetry?: TelemetrySink;
}

export interface GatewayResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  trace: RequestTrace;
}

export interface CacheEntry {
  body: string;
  freshness: Exclude<CacheState, "miss">;
  freshUntil: number;
  staleUntil: number;
}

export interface TelemetrySink {
  recordProviderAttempt(attempt: UpstreamAttempt): void;
  recordGatewayRequest(input: {
    route: string;
    status: number;
    durationMs: number;
    runtime: GatewayRuntime;
    cache: GatewayEnvironment["cache"];
    trace: RequestTrace;
  }): void;
  recordIdentityDecision(input: {
    entity: "recording" | "artist" | "lyrics";
    decision: "merged" | "independent" | "possible_duplicate";
    confidence: number;
  }): void;
  shutdown?(): void | Promise<void>;
}

export interface UpstreamJsonCache {
  get(url: string, now: number): CacheEntry | null | Promise<CacheEntry | null>;
  put(url: string, body: string, now: number): void | Promise<void>;
  close(): void | Promise<void>;
  delete?(url: string): void | Promise<void>;
  ready?(): boolean | Promise<boolean>;
  acquireRefreshLease?(
    url: string,
    ttlMs: number
  ): Promise<(() => void | Promise<void>) | null>;
}
