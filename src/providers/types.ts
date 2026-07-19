import type {
  GatewayRequest,
  RequestTrace,
  TelemetrySink,
  UpstreamTransport,
  UpstreamJsonResult
} from "../types.js";

export type ProviderName =
  | "musicbrainz"
  | "acoustid"
  | "itunes"
  | "wikidata"
  | "netease"
  | "lrclib"
  | "unknown";

export type ProviderCapability =
  | "recording-search"
  | "artist-search"
  | "album-search"
  | "artist-enrichment"
  | "lyrics-search";

export interface ProviderSearchContext {
  request: GatewayRequest;
  trace: RequestTrace;
  headers: Record<string, string>;
  defer?: (task: Promise<void>) => void;
  telemetry?: TelemetrySink;
  summary?: AttemptSummary;
  requestJson(
    provider: ProviderName,
    url: string,
    headers?: Record<string, string>
  ): Promise<UpstreamJsonResult>;
}

export interface MetadataProvider<Query, Result> {
  readonly name: ProviderName;
  readonly capabilities: readonly ProviderCapability[];
  search(query: Query, context: ProviderSearchContext): Promise<Result>;
}

export interface AttemptSummary {
  attempted: number;
  reachable: number;
}

export interface ProviderManagerDependencies {
  transport: UpstreamTransport;
}

export interface ProviderPolicy {
  concurrency: number;
  timeoutMs: number;
  failureThreshold: number;
  failureWindowMs: number;
  openMs: number;
}

export interface ProviderPassiveHealth {
  name: ProviderName;
  state: "closed" | "open" | "half_open";
  recentFailures: number;
  openedAt?: number;
}

export interface ProviderManager {
  search<Query>(
    provider: ProviderName,
    query: Query,
    context: Omit<ProviderSearchContext, "requestJson">
  ): Promise<UpstreamJsonResult>;
  health(): ProviderPassiveHealth[];
}

export interface DistributedProviderCoordinator {
  acquire(
    provider: ProviderName,
    policy: ProviderPolicy,
    signal: AbortSignal
  ): Promise<(() => void | Promise<void>) | null>;
  record(
    provider: ProviderName,
    policy: ProviderPolicy,
    result: UpstreamJsonResult
  ): Promise<void>;
}

export const DEFAULT_PROVIDER_POLICIES: Record<ProviderName, ProviderPolicy> = {
  musicbrainz: policy(1, 4_500),
  acoustid: policy(5, 4_500),
  itunes: policy(20, 3_500),
  wikidata: policy(5, 3_500),
  netease: policy(10, 2_500),
  lrclib: policy(10, 3_500),
  unknown: policy(10, 4_500)
};

function policy(concurrency: number, timeoutMs: number): ProviderPolicy {
  return {
    concurrency,
    timeoutMs,
    failureThreshold: 10,
    failureWindowMs: 60_000,
    openMs: 30_000
  };
}

export function providerForUrl(value: string): ProviderName {
  let host = "";
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host === "musicbrainz.org") return "musicbrainz";
  if (host === "api.acoustid.org") return "acoustid";
  if (host === "itunes.apple.com") return "itunes";
  if (host === "www.wikidata.org") return "wikidata";
  if (host === "music.163.com") return "netease";
  if (host === "lrclib.net") return "lrclib";
  return "unknown";
}
