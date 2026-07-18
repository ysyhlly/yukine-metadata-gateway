import type {
  MetadataProvider,
  ProviderManager as ProviderManagerContract,
  ProviderManagerDependencies,
  ProviderName,
  ProviderPassiveHealth,
  ProviderSearchContext
} from "./types.js";
import type { UpstreamJsonResult } from "../types.js";
import { MusicBrainzProvider } from "./adapters/musicbrainz.js";
import { AcoustIdProvider } from "./adapters/acoustid.js";
import { ItunesProvider } from "./adapters/itunes.js";
import { WikidataProvider } from "./adapters/wikidata.js";
import { NeteaseProvider } from "./adapters/netease.js";
import { LrclibProvider } from "./adapters/lrclib.js";

type AnyProvider = MetadataProvider<never, UpstreamJsonResult>;

const PASSIVE_FAILURE_WINDOW_MS = 60_000;

export class DefaultProviderManager implements ProviderManagerContract {
  private readonly providers = new Map<ProviderName, AnyProvider>();
  private readonly failures = new Map<ProviderName, number[]>();

  constructor(private readonly dependencies: ProviderManagerDependencies) {
    for (const provider of [
      new MusicBrainzProvider(),
      new AcoustIdProvider(),
      new ItunesProvider(),
      new WikidataProvider(),
      new NeteaseProvider(),
      new LrclibProvider()
    ]) {
      this.providers.set(provider.name, provider as AnyProvider);
    }
  }

  async search<Query>(
    providerName: ProviderName,
    query: Query,
    context: Omit<ProviderSearchContext, "requestJson">
  ): Promise<UpstreamJsonResult> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      return {
        kind: "failure",
        status: 503,
        host: "unknown",
        provider: providerName,
        cacheHit: false,
        cacheState: "miss",
        cacheLayer: "none",
        outcome: "http"
      };
    }
    const providerContext: ProviderSearchContext = {
      ...context,
      requestJson: (name, url, extraHeaders = {}) => this.requestJson(
        name,
        url,
        {
          ...context.headers,
          ...traceContextHeaders(context.request),
          ...extraHeaders
        },
        context
      )
    };
    return provider.search(query as never, providerContext);
  }

  health(): ProviderPassiveHealth[] {
    const cutoff = Date.now() - PASSIVE_FAILURE_WINDOW_MS;
    return [...this.providers.keys()].map((name) => {
      const recentFailures = (this.failures.get(name) || []).filter((time) => time >= cutoff);
      this.failures.set(name, recentFailures);
      return {
        name,
        state: "closed",
        recentFailures: recentFailures.length
      };
    });
  }

  private async requestJson(
    provider: ProviderName,
    url: string,
    headers: Record<string, string>,
    context: Omit<ProviderSearchContext, "requestJson">
  ): Promise<UpstreamJsonResult> {
    const response = await this.dependencies.transport.getJson(
      url,
      headers,
      context.request.signal,
      { provider, defer: context.defer }
    );
    context.trace.cacheHit ||= response.cacheHit;
    const attempt = {
      host: response.host,
      status: response.status,
      provider,
      durationMs: response.durationMs,
      outcome: response.outcome,
      cacheState: response.cacheState,
      cacheLayer: response.cacheLayer
    };
    context.trace.upstream.push(attempt);
    context.telemetry?.recordProviderAttempt(attempt);
    if (context.summary) {
      context.summary.attempted += 1;
      if (response.kind !== "failure") context.summary.reachable += 1;
    }
    if (
      response.kind === "failure"
      && ["timeout", "network", "http"].includes(response.outcome || "")
    ) {
      const failures = this.failures.get(provider) || [];
      failures.push(Date.now());
      this.failures.set(provider, failures);
    }
    return response;
  }
}

function traceContextHeaders(
  request: ProviderSearchContext["request"]
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (
    request.traceparent
    && /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/iu.test(request.traceparent)
  ) {
    headers.traceparent = request.traceparent;
  }
  if (request.tracestate && request.tracestate.length <= 512) {
    headers.tracestate = request.tracestate;
  }
  return headers;
}

const managers = new WeakMap<object, DefaultProviderManager>();

export function providerManagerFor(
  dependencies: ProviderManagerDependencies
): DefaultProviderManager {
  const key = dependencies.transport as object;
  const existing = managers.get(key);
  if (existing) return existing;
  const manager = new DefaultProviderManager(dependencies);
  managers.set(key, manager);
  return manager;
}
