export type GatewayRuntime = "worker" | "node";

export interface GatewayEnvironment {
  acoustidApiKey?: string;
  appUserAgent: string;
  runtime: GatewayRuntime;
  cache: "cloudflare" | "sqlite";
}

export interface UpstreamAttempt {
  host: string;
  status: number;
}

export interface RequestTrace {
  cacheHit: boolean;
  upstream: UpstreamAttempt[];
}

export type UpstreamJsonResult =
  | { kind: "success"; data: unknown; status: number; host: string; cacheHit: boolean }
  | { kind: "not_found"; status: 404; host: string; cacheHit: false }
  | { kind: "failure"; status: number; host: string; cacheHit: false };

export interface UpstreamTransport {
  getJson(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal
  ): Promise<UpstreamJsonResult>;
}

export interface GatewayRequest {
  method: string;
  url: string;
  requestId: string;
  signal?: AbortSignal;
}

export interface GatewayContext {
  env: GatewayEnvironment;
  transport: UpstreamTransport;
}

export interface GatewayResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  trace: RequestTrace;
}

export interface UpstreamJsonCache {
  get(url: string, now: number): string | null;
  put(url: string, body: string, now: number): void;
  close(): void;
}
