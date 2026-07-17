import type {
  GatewayContext,
  GatewayRequest,
  GatewayResult,
  RequestTrace,
  UpstreamJsonResult
} from "./types.js";

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

interface AttemptSummary {
  attempted: number;
  reachable: number;
}

const MB = "https://musicbrainz.org/ws/2/";
const ITUNES = "https://itunes.apple.com/search";
const ACOUSTID = "https://api.acoustid.org/v2/lookup";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const LRCLIB = "https://lrclib.net/api";

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
    if (url.pathname === "/v1/recordings/search") {
      return recordings(url.searchParams, request, context, trace);
    }
    if (url.pathname === "/v1/artists/search") {
      return artists(url.searchParams, request, context, trace);
    }
    if (url.pathname === "/v1/lyrics/search") {
      return lyrics(url.searchParams, request, context, trace);
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
      `${MB}recording/${recordingMbid}?inc=artists+isrcs+releases+work-rels&fmt=json`,
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
      `${MB}isrc/${encodeURIComponent(isrc)}?inc=artist-credits+releases+work-rels&fmt=json`,
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
      `${MB}recording/?query=${encodeURIComponent(clauses.join(" AND "))}&limit=${limit}&fmt=json`,
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
      `${MB}artist/${artistMbid}?inc=aliases+url-rels&fmt=json`,
      headers,
      request,
      context,
      trace,
      summary
    );
    if (response.kind === "success") values = [response.data];
  }
  if (values.length === 0 && name) {
    const query = encodeURIComponent(`artist:"${escapeLucene(name)}"`);
    const response = await upstream(
      `${MB}artist/?query=${query}&limit=${limit}&fmt=json`,
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
        `${MB}artist/${firstMbid}?inc=aliases+url-rels&fmt=json`,
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
      score: number(item.score, artistMbid ? 100 : 0) / 100
    };
  }).filter((item) => item.id && item.name);
  const firstResult = response[0];
  if (firstResult?.wikidataUrl) {
    firstResult.avatarUrl = await wikidataAvatarUrl(
      firstResult.wikidataUrl,
      headers,
      request,
      context,
      trace
    );
  }
  return result({ artists: response }, 200, trace, 86_400);
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
    upstream(`${LRCLIB}/get?${exactQuery}`, headers, request, context, trace, summary),
    upstream(`${LRCLIB}/search?${searchQuery}`, headers, request, context, trace, summary)
  ]);
  if (summary.reachable === 0) return upstreamFailure(request.requestId, trace);

  const records = [
    ...(exact.kind === "success" ? [exact.data] : []),
    ...(search.kind === "success" ? array(search.data) : [])
  ];
  const selected = records.map(object).find(hasLyrics);
  if (!selected) return result({ lyrics: null }, 200, trace, 3_600);
  return result({
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
  }, 200, trace, 3_600);
}

async function wikidataAvatarUrl(
  wikidataUrl: string,
  headers: Record<string, string>,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace
): Promise<string> {
  const match = wikidataUrl.match(/\/(Q\d+)(?:[/?#]|$)/i);
  const entityId = match?.[1]?.toUpperCase() || "";
  if (!/^Q\d+$/.test(entityId)) return "";
  const query = new URLSearchParams({
    action: "wbgetentities",
    ids: entityId,
    props: "claims",
    format: "json",
    formatversion: "2"
  });
  const response = await upstream(`${WIKIDATA_API}?${query}`, headers, request, context, trace);
  if (response.kind !== "success") return "";
  const body = object(response.data);
  const entity = object(object(body.entities)[entityId]);
  const imageClaim = object(array(object(entity.claims), "P18")[0]);
  const mainSnak = object(imageClaim.mainsnak);
  const fileName = string(object(mainSnak.datavalue).value).trim();
  if (!fileName) return "";
  return `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodeURIComponent(fileName)}?width=512`;
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
  const query = new URLSearchParams({
    client: key,
    duration: String(duration),
    fingerprint,
    meta: "recordings+recordingids+releasegroups+compress",
    format: "json"
  });
  const response = await upstream(`${ACOUSTID}?${query}`, headers, request, context, trace, summary);
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
  const term = [title, artist].filter(Boolean).join(" ");
  const response = await upstream(
    `${ITUNES}?media=music&entity=song&limit=${limit}&term=${encodeURIComponent(term)}`,
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
  url: string,
  headers: Record<string, string>,
  request: GatewayRequest,
  context: GatewayContext,
  trace: RequestTrace,
  summary?: AttemptSummary
): Promise<UpstreamJsonResult> {
  const response = await context.transport.getJson(url, headers, request.signal);
  trace.cacheHit ||= response.cacheHit;
  trace.upstream.push({ host: response.host, status: response.status });
  if (summary) {
    summary.attempted += 1;
    if (response.kind !== "failure") summary.reachable += 1;
  }
  return response;
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
