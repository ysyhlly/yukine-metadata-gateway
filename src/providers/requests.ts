import {
  ACOUSTID_LOOKUP_API,
  ITUNES_SEARCH_API,
  LRCLIB_API,
  MUSICBRAINZ_API,
  NETEASE_ARTIST_INTRODUCTION_API,
  NETEASE_SEARCH_API,
  WIKIDATA_API
} from "./endpoints.js";

export function musicBrainzRecordingById(id: string): string {
  return `${MUSICBRAINZ_API}recording/${encodeURIComponent(id)}`
    + "?inc=artists+isrcs+releases+work-rels+work-level-rels+artist-rels&fmt=json";
}

export function musicBrainzRecordingsByIsrc(isrc: string): string {
  return `${MUSICBRAINZ_API}isrc/${encodeURIComponent(isrc)}`
    + "?inc=artist-credits+isrcs+releases+work-rels&fmt=json";
}

export function musicBrainzRecordingSearch(clauses: string[], limit: number): string {
  return `${MUSICBRAINZ_API}recording/?query=${encodeURIComponent(clauses.join(" AND "))}`
    + `&limit=${limit}&fmt=json`;
}

export function musicBrainzArtistById(id: string): string {
  return `${MUSICBRAINZ_API}artist/${encodeURIComponent(id)}?inc=aliases+url-rels&fmt=json`;
}

export function musicBrainzArtistSearch(query: string, limit: number): string {
  return `${MUSICBRAINZ_API}artist/?query=${encodeURIComponent(query)}`
    + `&limit=${limit}&fmt=json`;
}

export function musicBrainzReleaseGroupById(id: string): string {
  return `${MUSICBRAINZ_API}release-group/${encodeURIComponent(id)}`
    + "?inc=artist-credits+releases&fmt=json";
}

export function musicBrainzReleaseById(id: string): string {
  return `${MUSICBRAINZ_API}release/${encodeURIComponent(id)}`
    + "?inc=artist-credits+release-groups&fmt=json";
}

export function musicBrainzReleaseGroupSearch(clauses: string[], limit: number): string {
  return `${MUSICBRAINZ_API}release-group/?query=${encodeURIComponent(clauses.join(" AND "))}`
    + `&limit=${limit}&fmt=json`;
}

export function acoustIdLookupRequest(input: {
  client: string;
  duration: number;
  fingerprint: string;
}): string {
  const query = new URLSearchParams({
    client: input.client,
    duration: String(input.duration),
    fingerprint: input.fingerprint,
    meta: "recordings+recordingids+releasegroups+compress",
    format: "json"
  });
  return `${ACOUSTID_LOOKUP_API}?${query}`;
}

export function itunesRecordingSearch(
  title: string,
  artist: string,
  limit: number
): string {
  const query = new URLSearchParams({
    media: "music",
    entity: "song",
    limit: String(limit),
    term: [title, artist].filter(Boolean).join(" ")
  });
  return `${ITUNES_SEARCH_API}?${query}`;
}

export function wikidataEntitiesRequest(query: URLSearchParams): string {
  return `${WIKIDATA_API}?${query}`;
}

export function neteaseArtistSearchRequest(query: URLSearchParams): string {
  return `${NETEASE_SEARCH_API}?${query}`;
}

export function neteaseArtistIntroductionRequest(id: string): string {
  return `${NETEASE_ARTIST_INTRODUCTION_API}?${new URLSearchParams({ id })}`;
}

export function lrclibExactRequest(query: URLSearchParams): string {
  return `${LRCLIB_API}/get?${query}`;
}

export function lrclibSearchRequest(query: URLSearchParams): string {
  return `${LRCLIB_API}/search?${query}`;
}
