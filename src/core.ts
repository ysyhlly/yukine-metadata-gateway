import type {
  GatewayContext,
  GatewayRequest,
  GatewayResult,
  RequestTrace,
  UpstreamJsonResult
} from "./types.js";
import {
  albumQuerySchema,
  albumResponseSchema,
  artistQuerySchema,
  artistResponseSchema,
  lyricsQuerySchema,
  lyricsResponseSchema,
  queryObject,
  recordingQuerySchema,
  recordingResponseSchema,
  validationIssues
} from "./contracts/v2.js";
import { openapiDocument } from "./contracts/openapi.js";
import {
  resolveCanonicalRecordings,
  type SourceAttribution
} from "./identity/recording.js";
import {
  canonicalizeMusicBrainzRelease,
  canonicalizeMusicBrainzReleaseGroups,
  type CanonicalAlbum
} from "./identity/album.js";
import { providerManagerFor } from "./providers/manager.js";
import type { AttemptSummary, ProviderName } from "./providers/types.js";

interface ArtistEvidence {
  id: string;
  name: string;
  sortName?: string;
}

interface RecordingEvidence {
  provider: string;
  id: string;
  title: string;
  artists: ArtistEvidence[];
  album: string;
  coverUrl: string;
  durationMs?: number;
  isrc?: string;
  recordingMbid?: string;
  workMbid?: string;
  acoustId?: string;
  fingerprintVerified?: boolean;
  score: number;
}

interface ArtistProfileEnhancement {
  avatarUrl: string;
  description: string;
  providerId?: string;
}

interface NeteaseArtistMatch {
  id: string;
  avatarUrl: string;
}

const NETEASE_ENRICHMENT_TIMEOUT_MS = 2_500;
const ARTIST_SOURCES = Symbol("artistSources");
const LYRICS_MATCH = Symbol("lyricsMatch");

export async function handleGatewayRequest(
  request: GatewayRequest,
  context: GatewayContext
): Promise<GatewayResult> {
  const trace: RequestTrace = { cacheHit: false, upstream: [] };
  if (request.method !== "GET") return result({ error: "method_not_allowed" }, 405, trace);
  const url = new URL(request.url);
  try {
    if (url.pathname === "/health") {
      return result({
        ok: true,
        runtime: context.env.runtime,
        cache: context.env.cache,
        acoustid: Boolean(context.env.acoustidApiKey)
      }, 200, trace);
    }
    if (url.pathname === "/ready") {
      const ready = await context.ready?.() ?? true;
      return result({
        ready,
        runtime: context.env.runtime,
        state: context.env.cache
      }, ready ? 200 : 503, trace);
    }
    if (url.pathname === "/openapi.json") {
      return result(openapiDocument, 200, trace, 3_600);
    }
    if (url.pathname === "/v1/recordings/search") {
      return withV1Deprecation(
        await recordings(url.searchParams, request, context, trace),
        context
      );
    }
    if (url.pathname === "/v1/artists/search") {
      return withV1Deprecation(
        await artists(url.searchParams, request, context, trace),
        context
      );
    }
    if (url.pathname === "/v1/lyrics/search") {
      return withV1Deprecation(
        await lyrics(url.searchParams, request, context, trace),
        context
      );
    }
    if (context.env.v2Enabled !== false && url.pathname === "/v2/recordings/search") {
      return recordingsV2(url.searchParams, request, context, trace);
    }
    if (context.env.v2Enabled !== false && url.pathname === "/v2/artists/search") {
      return artistsV2(url.searchParams, request, context, trace);
    }
    if (context.env.v2Enabled !== false && url.pathname === "/v2/albums/search") {
      return albumsV2(url.searchParams, request, context, trace);
    }
    if (context.env.v2Enabled !== false && url.pathname === "/v2/lyrics/search") {
      return lyricsV2(url.searchParams, request, context, trace);
    }
    return result({ error: "not_found" }, 404, trace);
  } catch {
    return upstreamFailure(request.requestId, trace);
  }
}

async function recordings(
  params: URLSearchParams,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<GatewayResult> {
  const title = bounded(params.get("title"), 300);
  const artist = bounded(params.get("artist"), 300);
  const recordingMbid = uuid(params.get("recordingMbid"));
  const isrc = bounded(params.get("isrc"), 32).replace(/[^a-z0-9]/gi, "").toUpperCase();
  const fingerprint = bounded(params.get("fingerprint"), 16_384);
  const fingerprintDuration = integer(params.get("fingerprintDuration"), 1, 7_200);
  const limit = integer(params.get("limit"), 1, 25) || 12;
  if (!title && !recordingMbid && !isrc && !fingerprint) {
    return result({ error: "missing_query" }, 400, trace);
  }

  const headers = upstreamHeaders(context);
  const summary: AttemptSummary = { attempted: 0, reachable: 0 };
  const evidence: RecordingEvidence[] = [];
  if (recordingMbid) {
    const response = await upstream(
      "musicbrainz",
      { operation: "recording-by-id", id: recordingMbid },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") evidence.push(...mapMbRecordings([response.data], true));
  }
  if (evidence.length === 0 && isrc) {
    const response = await upstream(
      "musicbrainz",
      { operation: "recordings-by-isrc", isrc },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") {
      evidence.push(...mapMbRecordings(array(response.data, "recordings"), true));
    }
  }
  if (evidence.length === 0 && fingerprint && fingerprintDuration && context.env.acoustidApiKey) {
    const response = await acoustIdLookup(
      fingerprint,
      fingerprintDuration,
      context.env.acoustidApiKey,
      headers,
      request,
      context,
      trace,
      summary
    );
    evidence.push(...response);
  }
  if (evidence.length === 0 && title) {
    const clauses = [`recording:"${escapeLucene(title)}"`];
    if (artist) clauses.push(`artist:"${escapeLucene(artist)}"`);
    const response = await upstream(
      "musicbrainz",
      { operation: "recording-search", clauses, limit },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") {
      evidence.push(...mapMbRecordings(array(response.data, "recordings"), false));
    }
  }
  if (title && evidence.length === 0) {
    evidence.push(...await itunesLookup(title, artist, limit, headers, request, context, trace, summary));
  }
  if (evidence.length === 0 && summary.attempted > 0 && summary.reachable === 0) {
    return upstreamFailure(request.requestId, trace);
  }
  return result({ recordings: dedupeRecordings(evidence).slice(0, limit) }, 200, trace, 86_400);
}

async function recordingsV2(
  params: URLSearchParams,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<GatewayResult> {
  const parsed = recordingQuerySchema.safeParse(queryObject(params));
  if (!parsed.success) return invalidV2(request.requestId, parsed.error, trace);
  const query = parsed.data;
  const headers = upstreamHeaders(context);
  const summary: AttemptSummary = { attempted: 0, reachable: 0 };
  const evidence: RecordingEvidence[] = [];
  const isrc = query.isrc?.replace(/[^a-z0-9]/giu, "").toUpperCase() || "";

  if (query.recordingMbid) {
    const response = await upstream(
      "musicbrainz",
      { operation: "recording-by-id", id: query.recordingMbid },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") evidence.push(...mapMbRecordings([response.data], true));
  }
  if (isrc) {
    const response = await upstream(
      "musicbrainz",
      { operation: "recordings-by-isrc", isrc },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") {
      evidence.push(...mapMbRecordings(array(response.data, "recordings"), true));
    }
  }
  if (query.fingerprint && query.fingerprintDuration && context.env.acoustidApiKey) {
    evidence.push(...await acoustIdLookup(
      query.fingerprint,
      query.fingerprintDuration,
      context.env.acoustidApiKey,
      headers,
      request,
      context,
      trace,
      summary
    ));
  }

  const supplementTitle = query.title || evidence[0]?.title || "";
  const supplementArtist = query.artist || evidence[0]?.artists[0]?.name || "";
  if (supplementTitle) {
    const clauses = [`recording:"${escapeLucene(supplementTitle)}"`];
    if (supplementArtist) clauses.push(`artist:"${escapeLucene(supplementArtist)}"`);
    const [musicbrainz, itunes] = await Promise.all([
      upstream(
        "musicbrainz",
        { operation: "recording-search", clauses, limit: query.limit },
        headers,
        request,
        context,
        trace,
        summary
      ).then((response) => response.kind === "success"
        ? mapMbRecordings(array(response.data, "recordings"), false)
        : []),
      itunesLookup(
        supplementTitle,
        supplementArtist,
        query.limit,
        headers,
        request,
        context,
        trace,
        summary
      )
    ]);
    evidence.push(...musicbrainz, ...itunes);
  }
  if (evidence.length === 0 && summary.attempted > 0 && summary.reachable === 0) {
    return upstreamFailure(request.requestId, trace);
  }
  const canonical = resolveCanonicalRecordings(evidence).slice(0, query.limit);
  for (const recording of canonical) {
    context.telemetry?.recordIdentityDecision({
      entity: "recording",
      decision: recording.sources.length > 1
        ? "merged"
        : recording.possibleDuplicates.length
          ? "possible_duplicate"
          : "independent",
      confidence: recording.confidence
    });
  }
  const body = recordingResponseSchema.parse({ recordings: canonical });
  return result(body, 200, trace, 86_400);
}

async function albumsV2(
  params: URLSearchParams,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<GatewayResult> {
  const parsed = albumQuerySchema.safeParse(queryObject(params));
  if (!parsed.success) return invalidV2(request.requestId, parsed.error, trace);
  const query = parsed.data;
  const headers = upstreamHeaders(context);
  const summary: AttemptSummary = { attempted: 0, reachable: 0 };
  let albums: CanonicalAlbum[] = [];

  if (query.releaseMbid) {
    const response = await upstream(
      "musicbrainz",
      { operation: "release-by-id", id: query.releaseMbid },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") {
      const returnedReleaseMbid = string(object(response.data).id).toLowerCase();
      if (returnedReleaseMbid === query.releaseMbid) {
        albums = canonicalizeMusicBrainzRelease(response.data, query.releaseGroupMbid);
      }
    }
  } else if (query.releaseGroupMbid) {
    const response = await upstream(
      "musicbrainz",
      { operation: "release-group-by-id", id: query.releaseGroupMbid },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") {
      albums = canonicalizeMusicBrainzReleaseGroups([response.data], {
        exact: true,
        limit: query.limit
      });
    }
  } else if (query.title) {
    const clauses = [`releasegroup:"${escapeLucene(query.title)}"`];
    if (query.artist) clauses.push(`artist:"${escapeLucene(query.artist)}"`);
    if (query.year) clauses.push(`firstreleasedate:${query.year}*`);
    if (query.type) clauses.push(`primarytype:"${escapeLucene(query.type)}"`);
    const response = await upstream(
      "musicbrainz",
      { operation: "release-group-search", clauses, limit: query.limit },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") {
      albums = canonicalizeMusicBrainzReleaseGroups(
        array(response.data, "release-groups"),
        { exact: false, limit: query.limit }
      );
    }
  }

  if (albums.length === 0 && summary.attempted > 0 && summary.reachable === 0) {
    return upstreamFailure(request.requestId, trace);
  }
  for (const album of albums) {
    context.telemetry?.recordIdentityDecision({
      entity: "album",
      decision: "independent",
      confidence: album.confidence
    });
  }
  const body = albumResponseSchema.parse({ albums });
  return result(body, 200, trace, 86_400);
}

async function artists(
  params: URLSearchParams,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<GatewayResult> {
  const name = bounded(params.get("name"), 300);
  const artistMbid = uuid(params.get("artistMbid"));
  const limit = integer(params.get("limit"), 1, 25) || 10;
  if (!name && !artistMbid) return result({ error: "missing_query" }, 400, trace);
  const headers = upstreamHeaders(context);
  const summary: AttemptSummary = { attempted: 0, reachable: 0 };
  let values: unknown[] = [];
  if (artistMbid) {
    const response = await upstream(
      "musicbrainz",
      { operation: "artist-by-id", id: artistMbid },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") values = [response.data];
  }
  if (values.length === 0 && name) {
    const query = `artist:"${escapeLucene(name)}"`;
    const response = await upstream(
      "musicbrainz",
      { operation: "artist-search", query, limit },
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") values = array(response.data, "artists");
    const first = object(values[0]);
    const firstMbid = uuid(string(first.id));
    if (firstMbid) {
      const detail = await upstream(
        "musicbrainz",
        { operation: "artist-by-id", id: firstMbid },
        headers,
        request,
        context,
        trace
      );
      if (detail.kind === "success") {
        values = [{ ...object(detail.data), score: first.score }, ...values.slice(1)];
      }
    }
  }
  if (values.length === 0 && summary.attempted > 0 && summary.reachable === 0) {
    return upstreamFailure(request.requestId, trace);
  }
  const response = values.map((raw) => {
    const item = object(raw);
    const relations = array(item, "relations");
    const wikidata = relations.map(object).find((relation) => relation.type === "wikidata");
    return {
      provider: "musicbrainz",
      id: string(item.id),
      name: string(item.name),
      sortName: string(item["sort-name"]),
      aliases: array(item, "aliases").map((value) => string(object(value).name)).filter(Boolean),
      country: string(item.country),
      type: string(item.type).toUpperCase(),
      artistMbid: string(item.id),
      wikidataUrl: string(object(wikidata?.url).resource),
      avatarUrl: "",
      description: "",
      score: number(item.score, artistMbid ? 100 : 0) / 100
    };
  }).filter((item) => item.id && item.name);
  const sourceMetadata = new Map<string, SourceAttribution[]>();
  for (const item of response) {
    sourceMetadata.set(item.id, [{
      provider: "musicbrainz",
      id: item.id,
      role: "identity",
      matchedBy: [artistMbid ? "artist_mbid" : "name_search"],
      fields: [
        "name",
        "sortName",
        "aliases",
        "country",
        "type",
        "identifiers.artistMbid"
      ],
      confidence: clampScore(item.score)
    }]);
  }
  const firstResult = response[0];
  if (firstResult) {
    if (firstResult.wikidataUrl) {
      const enhancement = await wikidataArtistProfile(
        firstResult.wikidataUrl,
        headers,
        request,
        context,
        trace
      );
      firstResult.avatarUrl = enhancement.avatarUrl;
      firstResult.description = enhancement.description;
      const fields = [
        enhancement.avatarUrl ? "avatarUrl" : "",
        enhancement.description ? "description" : ""
      ].filter(Boolean);
      if (fields.length) {
        sourceMetadata.get(firstResult.id)?.push({
          provider: "wikidata",
          id: enhancement.providerId || wikidataEntityId(firstResult.wikidataUrl),
          role: "enrichment",
          matchedBy: ["wikidata_relation"],
          fields,
          confidence: 1
        });
      }
    }
    if (!firstResult.avatarUrl || !firstResult.description) {
      const supplement = await withRequestTimeout(
        request,
        NETEASE_ENRICHMENT_TIMEOUT_MS,
        (enrichmentRequest) => neteaseArtistProfile(
          name || firstResult.name,
          [firstResult.name, name, ...firstResult.aliases],
          !firstResult.description,
          enrichmentRequest,
          context,
          trace
        )
      );
      const fields: string[] = [];
      if (!firstResult.avatarUrl && supplement.avatarUrl) {
        firstResult.avatarUrl = supplement.avatarUrl;
        fields.push("avatarUrl");
      }
      if (!firstResult.description && supplement.description) {
        firstResult.description = supplement.description;
        fields.push("description");
      }
      if (fields.length) {
        sourceMetadata.get(firstResult.id)?.push({
          provider: "netease",
          id: supplement.providerId || "",
          role: "enrichment",
          matchedBy: ["exact_artist_name"],
          fields,
          confidence: 0.9
        });
      }
    }
  }
  const body = { artists: response };
  Object.defineProperty(body, ARTIST_SOURCES, {
    value: sourceMetadata,
    enumerable: false
  });
  return result(body, 200, trace, 86_400);
}

async function artistsV2(
  params: URLSearchParams,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<GatewayResult> {
  const parsed = artistQuerySchema.safeParse(queryObject(params));
  if (!parsed.success) return invalidV2(request.requestId, parsed.error, trace);
  const legacy = await artists(params, request, context, trace);
  if (legacy.status !== 200) return legacy;
  const body = legacy.body as Record<PropertyKey, unknown>;
  const metadata = body[ARTIST_SOURCES] instanceof Map
    ? body[ARTIST_SOURCES] as Map<string, SourceAttribution[]>
    : new Map<string, SourceAttribution[]>();
  const canonical = array(body, "artists").map((raw) => {
    const item = object(raw);
    const artistMbid = string(item.artistMbid);
    const wikidataUrl = string(item.wikidataUrl);
    const confidence = clampScore(number(item.score, 0));
    const id = string(item.id);
    return {
      canonicalId: artistMbid
        ? `artist:mbid:${encodeURIComponent(artistMbid.toLowerCase())}`
        : `artist:${encodeURIComponent(string(item.provider))}:${encodeURIComponent(id)}`,
      name: string(item.name),
      sortName: string(item.sortName),
      aliases: array(item, "aliases").map(string),
      country: string(item.country),
      type: string(item.type),
      identifiers: {
        ...(artistMbid ? { artistMbid } : {}),
        ...(wikidataUrl ? { wikidata: wikidataEntityId(wikidataUrl) } : {})
      },
      avatarUrl: string(item.avatarUrl),
      description: string(item.description),
      confidence,
      sources: metadata.get(id) || [{
        provider: string(item.provider),
        id,
        role: "identity" as const,
        matchedBy: ["provider_result"],
        fields: ["name"],
        confidence
      }]
    };
  });
  for (const artist of canonical) {
    context.telemetry?.recordIdentityDecision({
      entity: "artist",
      decision: artist.sources.length > 1 ? "merged" : "independent",
      confidence: artist.confidence
    });
  }
  return result(artistResponseSchema.parse({ artists: canonical }), 200, trace, 86_400);
}

async function lyrics(
  params: URLSearchParams,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<GatewayResult> {
  const title = bounded(params.get("title"), 300);
  const artist = bounded(params.get("artist"), 300);
  const album = bounded(params.get("album"), 300);
  const durationMs = integer(params.get("durationMs"), 1, 7_200_000);
  if (!title) return result({ error: "missing_query" }, 400, trace);

  const exactQuery = new URLSearchParams({ track_name: title });
  const searchQuery = new URLSearchParams({ track_name: title });
  if (artist) {
    exactQuery.set("artist_name", artist);
    searchQuery.set("artist_name", artist);
  }
  if (album) {
    exactQuery.set("album_name", album);
    searchQuery.set("album_name", album);
  }
  if (durationMs) exactQuery.set("duration", String(Math.round(durationMs / 1_000)));
  const summary: AttemptSummary = { attempted: 0, reachable: 0 };
  const headers = upstreamHeaders(context);
  const [exact, search] = await Promise.all([
    upstream(
      "lrclib",
      { operation: "exact", query: exactQuery },
      headers,
      request,
      context,
      trace,
      summary
    ),
    upstream(
      "lrclib",
      { operation: "search", query: searchQuery },
      headers,
      request,
      context,
      trace,
      summary
    )
  ]);
  if (summary.reachable === 0) return upstreamFailure(request.requestId, trace);

  const exactSelected = exact.kind === "success" && hasLyrics(object(exact.data))
    ? object(exact.data)
    : undefined;
  const searchSelected = search.kind === "success"
    ? array(search.data).map(object).find(hasLyrics)
    : undefined;
  const selected = exactSelected || searchSelected;
  if (!selected) return result({ lyrics: null }, 200, trace, 3_600);
  const body = {
    lyrics: {
      provider: "lrclib",
      id: string(selected.id),
      title: string(selected.trackName),
      artist: string(selected.artistName),
      album: string(selected.albumName),
      durationMs: Math.max(0, Math.round(number(selected.duration, 0) * 1_000)),
      syncedLyrics: string(selected.syncedLyrics),
      plainLyrics: string(selected.plainLyrics)
    }
  };
  Object.defineProperty(body, LYRICS_MATCH, {
    value: exactSelected ? "exact_metadata" : "search",
    enumerable: false
  });
  return result(body, 200, trace, 3_600);
}

async function lyricsV2(
  params: URLSearchParams,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<GatewayResult> {
  const parsed = lyricsQuerySchema.safeParse(queryObject(params));
  if (!parsed.success) return invalidV2(request.requestId, parsed.error, trace);
  const legacy = await lyrics(params, request, context, trace);
  if (legacy.status !== 200) return legacy;
  const body = legacy.body as Record<PropertyKey, unknown>;
  const rawLyrics = object(body.lyrics);
  if (!Object.keys(rawLyrics).length) {
    return result(lyricsResponseSchema.parse({ lyrics: null }), 200, trace, 3_600);
  }
  const id = string(rawLyrics.id);
  const match = typeof body[LYRICS_MATCH] === "string" ? String(body[LYRICS_MATCH]) : "search";
  const confidence = match === "exact_metadata" ? 1 : 0.8;
  const canonical = {
    canonicalId: `lyrics:${encodeURIComponent(string(rawLyrics.provider))}:${encodeURIComponent(id)}`,
    title: string(rawLyrics.title),
    artist: string(rawLyrics.artist),
    album: string(rawLyrics.album),
    durationMs: Math.max(0, Math.round(number(rawLyrics.durationMs, 0))),
    syncedLyrics: string(rawLyrics.syncedLyrics),
    plainLyrics: string(rawLyrics.plainLyrics),
    confidence,
    sources: [{
      provider: string(rawLyrics.provider),
      id,
      role: "identity" as const,
      matchedBy: [match],
      fields: [
        "title",
        "artist",
        "album",
        "durationMs",
        "syncedLyrics",
        "plainLyrics"
      ],
      confidence
    }]
  };
  context.telemetry?.recordIdentityDecision({
    entity: "lyrics",
    decision: "independent",
    confidence
  });
  return result(lyricsResponseSchema.parse({ lyrics: canonical }), 200, trace, 3_600);
}

async function wikidataArtistProfile(
  wikidataUrl: string,
  headers: Record<string, string>,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<ArtistProfileEnhancement> {
  const match = wikidataUrl.match(/\/(Q\d+)(?:[/?#]|$)/i);
  const entityId = match?.[1]?.toUpperCase() || "";
  if (!/^Q\d+$/.test(entityId)) return emptyArtistProfile();
  const query = new URLSearchParams({
    action: "wbgetentities",
    ids: entityId,
    props: "claims|descriptions",
    languages: "zh|zh-hans|zh-hant|en",
    languagefallback: "1",
    format: "json",
    formatversion: "2"
  });
  const response = await upstream(
    "wikidata",
    { query },
    headers,
    request,
    context,
    trace
  );
  if (response.kind !== "success") return emptyArtistProfile();
  const body = object(response.data);
  const entity = object(object(body.entities)[entityId]);
  const imageClaim = object(array(object(entity.claims), "P18")[0]);
  const mainSnak = object(imageClaim.mainsnak);
  const fileName = string(object(mainSnak.datavalue).value).trim();
  return {
    avatarUrl: fileName
      ? `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(fileName)}?width=512`
      : "",
    description: wikidataDescription(entity),
    providerId: entityId
  };
}

function wikidataDescription(entity: Record<string, unknown>): string {
  const descriptions = object(entity.descriptions);
  for (const language of ["zh-hans", "zh", "zh-hant", "en"]) {
    const value = string(object(descriptions[language]).value).trim();
    if (value) return value.slice(0, 1_000);
  }
  return "";
}

function emptyArtistProfile(): ArtistProfileEnhancement {
  return { avatarUrl: "", description: "", providerId: "" };
}

async function withRequestTimeout<T>(
  request: GatewayRequest,
  timeoutMs: number,
  operation: (request: GatewayRequest) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  if (request.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  try {
    return await operation({ ...request, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abort);
  }
}

async function neteaseArtistProfile(
  queryName: string,
  acceptedNames: string[],
  needsDescription: boolean,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<ArtistProfileEnhancement> {
  const query = new URLSearchParams({
    s: queryName,
    type: "100",
    limit: "5",
    offset: "0",
    total: "true"
  });
  const headers = neteaseHeaders(context);
  const search = await upstream(
    "netease",
    { operation: "artist-search", query },
    headers,
    request,
    context,
    trace
  );
  if (search.kind !== "success") return emptyArtistProfile();
  const body = object(search.data);
  if (number(body.code, 0) !== 200) return emptyArtistProfile();
  const match = exactNeteaseArtist(array(object(body.result), "artists"), acceptedNames);
  if (!match) return emptyArtistProfile();
  if (!needsDescription) {
    return { avatarUrl: match.avatarUrl, description: "", providerId: match.id };
  }

  const detail = await upstream(
    "netease",
    { operation: "artist-introduction", id: match.id },
    headers,
    request,
    context,
    trace
  );
  if (detail.kind !== "success") {
    return { avatarUrl: match.avatarUrl, description: "", providerId: match.id };
  }
  const detailBody = object(detail.data);
  if (number(detailBody.code, 0) !== 200) {
    return { avatarUrl: match.avatarUrl, description: "", providerId: match.id };
  }
  const briefDescription = cleanArtistDescription(detailBody.briefDesc);
  const introduction = array(detailBody, "introduction")
    .map((value) => cleanArtistDescription(object(value).txt))
    .find(Boolean) || "";
  return {
    avatarUrl: match.avatarUrl,
    description: briefDescription || introduction,
    providerId: match.id
  };
}

function exactNeteaseArtist(values: unknown[], acceptedNames: string[]): NeteaseArtistMatch | undefined {
  const names = new Set(acceptedNames.map(normalizedArtistName).filter(Boolean));
  const match = values
    .map(object)
    .find((value) => names.has(normalizedArtistName(string(value.name))));
  if (!match) return undefined;
  const id = string(match.id).trim();
  if (!/^[1-9]\d{0,18}$/.test(id)) return undefined;
  return {
    id,
    avatarUrl: trustedNeteaseImage(string(match.picUrl))
      || trustedNeteaseImage(string(match.img1v1Url))
  };
}

function normalizedArtistName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, "");
}

function trustedNeteaseImage(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:"
      || !host.endsWith(".music.126.net")
      || url.username
      || url.password
      || (url.port && url.port !== "443")
    ) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function cleanArtistDescription(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, 5_000)
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

async function acoustIdLookup(
  fingerprint: string,
  duration: number,
  key: string,
  headers: Record<string, string>,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace,
  summary: AttemptSummary
): Promise<RecordingEvidence[]> {
  const response = await upstream(
    "acoustid",
    { client: key, duration, fingerprint },
    headers,
    request,
    context,
    trace,
    summary
  );
  if (response.kind !== "success") return [];
  const root = object(response.data);
  if (root.status !== "ok") return [];
  const output: RecordingEvidence[] = [];
  for (const rawResult of array(root, "results")) {
    const value = object(rawResult);
    const confidence = number(value.score, 0);
    const acoustId = string(value.id);
    for (const rawRecording of array(value, "recordings")) {
      const recording = object(rawRecording);
      const mbid = string(recording.id);
      if (!mbid || !string(recording.title)) continue;
      output.push({
        provider: "acoustid",
        id: acoustId || mbid,
        title: string(recording.title),
        artists: array(recording, "artists").map((raw) => {
          const artist = object(raw);
          return { id: string(artist.id), name: string(artist.name) };
        }),
        album: string(object(array(recording, "releasegroups")[0]).title),
        coverUrl: "",
        durationMs: duration * 1_000,
        recordingMbid: mbid,
        acoustId,
        fingerprintVerified: true,
        score: confidence
      });
    }
  }
  return output;
}

function mapMbRecordings(values: unknown[], exact: boolean): RecordingEvidence[] {
  return values.map((raw) => {
    const item = object(raw);
    const credits = array(item, "artist-credit");
    const relations = array(item, "relations").map(object);
    const work = relations.find((relation) => relation.type === "performance");
    const releases = array(item, "releases").map(object);
    const release = releases[0] || {};
    const artworkRelease = releases.find((candidate) =>
      object(candidate["cover-art-archive"]).front === true
      && Boolean(uuid(string(candidate.id)))
    );
    const artworkReleaseId = uuid(string(artworkRelease?.id));
    return {
      provider: "musicbrainz",
      id: string(item.id),
      title: string(item.title),
      artists: credits.map((rawCredit) => {
        const credit = object(rawCredit);
        const artist = object(credit.artist);
        return {
          id: string(artist.id),
          name: string(credit.name) || string(artist.name),
          sortName: string(artist["sort-name"])
        };
      }),
      album: string(release.title),
      coverUrl: artworkReleaseId
        ? `https://coverartarchive.org/release/${artworkReleaseId}/front-500`
        : "",
      durationMs: number(item.length, 0),
      isrc: string(array(item, "isrcs")[0]),
      recordingMbid: string(item.id),
      workMbid: string(object(work?.work).id),
      score: exact ? 1 : number(item.score, 0) / 100
    };
  }).filter((item) => item.id && item.title);
}

async function itunesLookup(
  title: string,
  artist: string,
  limit: number,
  headers: Record<string, string>,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace,
  summary: AttemptSummary
): Promise<RecordingEvidence[]> {
  const response = await upstream(
    "itunes",
    { title, artist, limit },
    headers,
    request,
    context,
    trace,
    summary
  );
  if (response.kind !== "success") return [];
  return array(response.data, "results").map((raw, index) => {
    const item = object(raw);
    return {
      provider: "itunes",
      id: string(item.trackId),
      title: string(item.trackName),
      artists: [{ id: string(item.artistId), name: string(item.artistName) }],
      album: string(item.collectionName),
      coverUrl: trustedItunesArtwork(string(item.artworkUrl100)),
      durationMs: number(item.trackTimeMillis, 0),
      score: Math.max(0, 0.75 - index * 0.01)
    };
  }).filter((item) => item.id && item.title);
}

async function upstream(
  provider: ProviderName,
  query: unknown,
  headers: Record<string, string>,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace,
  summary?: AttemptSummary
): Promise<UpstreamJsonResult> {
  return providerManagerFor({ transport: context.transport }).search(provider, query, {
    request,
    trace,
    headers,
    defer: context.defer,
    telemetry: context.telemetry,
    summary
  });
}

function invalidV2(
  requestId: string,
  error: Parameters<typeof validationIssues>[0],
  trace: RequestTrace
): GatewayResult {
  return result({
    error: "invalid_request",
    requestId,
    issues: validationIssues(error)
  }, 400, trace);
}

function withV1Deprecation(
  response: GatewayResult,
  context: GatewayContext
): GatewayResult {
  if (!context.env.v1SunsetDate) return response;
  return {
    ...response,
    headers: {
      ...response.headers,
      Deprecation: "true",
      Sunset: context.env.v1SunsetDate,
      Link: '</openapi.json>; rel="service-desc"'
    }
  };
}

function wikidataEntityId(value: string): string {
  return value.match(/\/(Q\d+)(?:[/?#]|$)/iu)?.[1]?.toUpperCase() || "";
}

function clampScore(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function dedupeRecordings(values: RecordingEvidence[]): RecordingEvidence[] {
  const seen = new Set<string>();
  return values
    .sort((a, b) => b.score - a.score)
    .filter((value) => {
      const key = value.recordingMbid || `${value.provider}:${value.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function trustedItunesArtwork(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase().endsWith(".mzstatic.com")
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function hasLyrics(value: Record<string, unknown>): boolean {
  return string(value.syncedLyrics).trim().length > 0 || string(value.plainLyrics).trim().length > 0;
}

function upstreamHeaders(context: GatewayContext): Record<string, string> {
  return { Accept: "application/json", "User-Agent": context.env.appUserAgent };
}

function neteaseHeaders(context: GatewayContext): Record<string, string> {
  return {
    ...upstreamHeaders(context),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://music.163.com/"
  };
}

function upstreamFailure(requestId: string, trace: RequestTrace): GatewayResult {
  return result({ error: "upstream_failure", requestId }, 502, trace);
}

function result(
  body: unknown,
  status: number,
  trace: RequestTrace,
  maxAge = 0
): GatewayResult {
  return {
    status,
    body,
    trace,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  };
}

function bounded(value: string | null, max: number): string {
  return (value || "").trim().slice(0, max);
}

function uuid(value: string | null): string {
  const candidate = bounded(value, 64).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)
    ? candidate
    : "";
}

function integer(value: string | null, min: number, max: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : 0;
}

function escapeLucene(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown, key?: string): unknown[] {
  const target = key ? object(value)[key] : value;
  return Array.isArray(target) ? target : [];
}

function string(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function number(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
