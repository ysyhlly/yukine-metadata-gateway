import assert from "node:assert/strict";
import test from "node:test";
import { handleGatewayRequest } from "../src/core.js";
import type {
  GatewayContext,
  UpstreamJsonResult,
  UpstreamTransport
} from "../src/types.js";

const RECORDING_ID = "12345678-1234-4123-8123-123456789abc";
const RELEASE_GROUP_ID = "22345678-1234-4123-8123-123456789abc";
const RELEASE_ID = "32345678-1234-4123-8123-123456789abc";
const OTHER_RELEASE_GROUP_ID = "42345678-1234-4123-8123-123456789abc";

test("v2 recording search merges MusicBrainz and iTunes evidence", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.hostname === "musicbrainz.org") {
      return success(url, {
        recordings: [{
          id: RECORDING_ID,
          title: "Halo",
          score: 99,
          length: 240_000,
          "artist-credit": [{ artist: { id: "artist", name: "Beyoncé" } }],
          releases: [{ title: "I Am... Sasha Fierce" }]
        }]
      });
    }
    if (url.hostname === "itunes.apple.com") {
      return success(url, {
        results: [{
          trackId: 42,
          trackName: "Halo",
          artistId: 7,
          artistName: "Beyoncé",
          collectionName: "I Am... Sasha Fierce",
          trackTimeMillis: 241_000,
          artworkUrl100: "https://is1-ssl.mzstatic.com/halo.jpg"
        }]
      });
    }
    return failure(url, 500);
  });

  const response = await request(
    "/v2/recordings/search?title=Halo&artist=Beyonc%C3%A9",
    transport
  );
  const recordings = (response.body as {
    recordings: Array<{
      canonicalId: string;
      confidence: number;
      sources: Array<{ provider: string }>;
    }>;
  }).recordings;

  assert.equal(response.status, 200);
  assert.equal(recordings.length, 1);
  assert.equal(recordings[0]?.canonicalId, `recording:mbid:${RECORDING_ID}`);
  assert.deepEqual(recordings[0]?.sources.map((source) => source.provider), [
    "musicbrainz",
    "itunes"
  ]);
});

test("v2 validates present query parameters without echoing values", async () => {
  const transport = new FixtureTransport();
  const response = await request(
    "/v2/recordings/search?title=Private&limit=not-a-number",
    transport
  );

  assert.equal(response.status, 400);
  assert.equal((response.body as { error: string }).error, "invalid_request");
  assert.doesNotMatch(JSON.stringify(response.body), /Private|not-a-number/);
  assert.equal(transport.urls.length, 0);
});

test("v2 artist response attributes identity and enrichment sources", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.hostname === "musicbrainz.org" && url.pathname.endsWith("/artist/")) {
      return success(url, {
        artists: [{ id: RECORDING_ID, name: "Aimer", score: 100 }]
      });
    }
    if (url.hostname === "musicbrainz.org") {
      return success(url, {
        id: RECORDING_ID,
        name: "Aimer",
        relations: [{
          type: "wikidata",
          url: { resource: "https://www.wikidata.org/wiki/Q123" }
        }]
      });
    }
    if (url.hostname === "www.wikidata.org") {
      return success(url, {
        entities: {
          Q123: {
            claims: {},
            descriptions: { zh: { value: "日本女歌手" } }
          }
        }
      });
    }
    return failure(url, 500);
  });

  const response = await request("/v2/artists/search?name=Aimer", transport);
  const artist = (response.body as {
    artists: Array<{ canonicalId: string; sources: Array<{ provider: string }> }>;
  }).artists[0];

  assert.equal(response.status, 200);
  assert.equal(artist?.canonicalId, `artist:mbid:${RECORDING_ID}`);
  assert.deepEqual(artist?.sources.map((source) => source.provider), [
    "musicbrainz",
    "wikidata"
  ]);
});

test("v2 album lookup maps a release group and derives aliases without inventing a release", async () => {
  const transport = new FixtureTransport((url) => success(url, {
    id: RELEASE_GROUP_ID.toUpperCase(),
    title: "Canonical Album",
    "primary-type": "Album",
    "first-release-date": "2024-03-01",
    "artist-credit": [{
      name: "Album Artist",
      artist: { id: "artist-id", name: "Album Artist" }
    }],
    releases: [
      { id: RELEASE_ID, title: "Canonical Album" },
      { id: "52345678-1234-4123-8123-123456789abc", title: "本地名称" },
      { id: "62345678-1234-4123-8123-123456789abc", title: "本地名称" },
      { id: "72345678-1234-4123-8123-123456789abc", title: "Other Language Name" }
    ]
  }));

  const response = await request(
    `/v2/albums/search?releaseGroupMbid=${RELEASE_GROUP_ID.toUpperCase()}`,
    transport
  );
  const album = (response.body as {
    albums: Array<{
      canonicalId: string;
      title: string;
      aliases: string[];
      artist: string;
      artists: Array<{ id: string; name: string }>;
      type: string;
      year: number;
      identifiers: { releaseGroupMbid: string; releaseMbid?: string };
      confidence: number;
      sources: Array<Record<string, unknown>>;
    }>;
  }).albums[0];

  assert.equal(response.status, 200);
  assert.equal(response.headers["Cache-Control"], "public, max-age=86400");
  assert.equal(album?.canonicalId, `album:mbid:${RELEASE_GROUP_ID}`);
  assert.equal(album?.title, "Canonical Album");
  assert.deepEqual(album?.aliases, ["本地名称", "Other Language Name"]);
  assert.equal(album?.artist, "Album Artist");
  assert.deepEqual(album?.artists, [{ id: "artist-id", name: "Album Artist" }]);
  assert.equal(album?.type, "Album");
  assert.equal(album?.year, 2024);
  assert.deepEqual(album?.identifiers, { releaseGroupMbid: RELEASE_GROUP_ID });
  assert.equal(album?.confidence, 1);
  assert.deepEqual(album?.sources, [{
    provider: "musicbrainz",
    id: RELEASE_GROUP_ID,
    role: "identity"
  }]);
  assert.equal(transport.urls[0]?.pathname, `/ws/2/release-group/${RELEASE_GROUP_ID}`);
  assert.equal(transport.urls[0]?.searchParams.get("inc"), "artist-credits releases");
});

test("v2 album release lookup preserves the release and rejects conflicting strong identifiers", async () => {
  const fixture = (url: URL) => success(url, {
    id: RELEASE_ID,
    title: "Local Edition",
    date: "2024-04-01",
    "artist-credit": [{
      name: "Album Artist",
      artist: { id: "artist-id", name: "Album Artist" }
    }],
    "release-group": {
      id: RELEASE_GROUP_ID,
      title: "Canonical Album",
      "primary-type": "Album"
    }
  });
  const matched = await request(
    `/v2/albums/search?releaseMbid=${RELEASE_ID}&title=Ignored`,
    new FixtureTransport(fixture)
  );
  const conflict = await request(
    `/v2/albums/search?releaseMbid=${RELEASE_ID}`
      + `&releaseGroupMbid=${OTHER_RELEASE_GROUP_ID}`,
    new FixtureTransport(fixture)
  );
  const wrongRelease = await request(
    `/v2/albums/search?releaseMbid=${RELEASE_ID}`,
    new FixtureTransport((url) => success(url, {
      ...objectFixture(fixture(url)),
      id: "52345678-1234-4123-8123-123456789abc"
    }))
  );
  const album = (matched.body as {
    albums: Array<{ aliases: string[]; identifiers: Record<string, string> }>;
  }).albums[0];

  assert.equal(matched.status, 200);
  assert.deepEqual(album?.aliases, ["Local Edition"]);
  assert.deepEqual(album?.identifiers, {
    releaseGroupMbid: RELEASE_GROUP_ID,
    releaseMbid: RELEASE_ID
  });
  assert.deepEqual(conflict.body, { albums: [] });
  assert.deepEqual(wrongRelease.body, { albums: [] });
});

test("v2 album text search returns every distinct candidate in deterministic confidence order", async () => {
  const firstId = "12345678-2234-4123-8123-123456789abc";
  const secondId = "22345678-2234-4123-8123-123456789abc";
  const thirdId = "32345678-2234-4123-8123-123456789abc";
  const transport = new FixtureTransport((url) => success(url, {
    "release-groups": [
      { id: thirdId, title: "Third", score: 91 },
      { id: secondId, title: "Second", score: 97 },
      { id: firstId, title: "First", score: 97 },
      { id: firstId, title: "Duplicate", score: 80 }
    ]
  }));

  const response = await request(
    "/v2/albums/search?title=Echo&artist=Artist&year=2024&type=Album",
    transport
  );
  const albums = (response.body as {
    albums: Array<{ canonicalId: string; confidence: number }>;
  }).albums;
  const upstreamQuery = transport.urls[0]?.searchParams.get("query") || "";

  assert.equal(response.status, 200);
  assert.deepEqual(albums.map((album) => album.canonicalId), [
    `album:mbid:${firstId}`,
    `album:mbid:${secondId}`,
    `album:mbid:${thirdId}`
  ]);
  assert.deepEqual(albums.map((album) => album.confidence), [0.97, 0.97, 0.91]);
  assert.match(upstreamQuery, /releasegroup:"Echo"/);
  assert.match(upstreamQuery, /artist:"Artist"/);
  assert.match(upstreamQuery, /firstreleasedate:2024\*/);
  assert.match(upstreamQuery, /primarytype:"Album"/);
  assert.equal(transport.urls[0]?.searchParams.get("limit"), "10");
});

test("v2 album validation, empty results, not found, and upstream failures keep stable semantics", async () => {
  const missing = await request("/v2/albums/search?artist=Only", new FixtureTransport());
  const invalid = await request(
    "/v2/albums/search?title=Private&year=nope&limit=26&extra=secret",
    new FixtureTransport()
  );
  const empty = await request(
    "/v2/albums/search?title=None&limit=25",
    new FixtureTransport((url) => success(url, { "release-groups": [] }))
  );
  const notFoundResponse = await request(
    `/v2/albums/search?releaseGroupMbid=${RELEASE_GROUP_ID}`,
    new FixtureTransport(notFound)
  );
  const unavailable = await request(
    "/v2/albums/search?title=Private",
    new FixtureTransport((url) => failure(url, 503))
  );

  assert.equal(missing.status, 400);
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(JSON.stringify(invalid.body), /Private|nope|secret/);
  assert.deepEqual(empty.body, { albums: [] });
  assert.deepEqual(notFoundResponse.body, { albums: [] });
  assert.equal(unavailable.status, 502);
  assert.deepEqual(unavailable.body, {
    error: "upstream_failure",
    requestId: "request-v2"
  });
  assert.doesNotMatch(JSON.stringify(unavailable.body), /Private/);
});

test("v2 lyrics preserves null semantics and exact match attribution", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 180,
        plainLyrics: "Hello"
      });
    }
    return success(url, []);
  });

  const response = await request("/v2/lyrics/search?title=Song", transport);
  const lyrics = (response.body as {
    lyrics: { canonicalId: string; sources: Array<{ matchedBy: string[] }> };
  }).lyrics;

  assert.equal(response.status, 200);
  assert.equal(lyrics.canonicalId, "lyrics:lrclib:1");
  assert.deepEqual(lyrics.sources[0]?.matchedBy, ["exact_metadata"]);
});

test("readiness and OpenAPI are available in the shared runtime", async () => {
  const unavailable = await request("/ready", new FixtureTransport(), {
    ready: () => false
  });
  const specification = await request("/openapi.json", new FixtureTransport());

  assert.equal(unavailable.status, 503);
  assert.equal((specification.body as { openapi: string }).openapi, "3.1.0");
  assert.ok((specification.body as { paths: Record<string, unknown> }).paths[
    "/v2/recordings/search"
  ]);
  assert.ok((specification.body as { paths: Record<string, unknown> }).paths[
    "/v2/albums/search"
  ]);
});

test("v2 feature flag and v1 sunset headers preserve the release boundary", async () => {
  const disabled = await request(
    "/v2/albums/search?title=Album",
    new FixtureTransport(),
    {
      env: {
        appUserAgent: "GatewayTest/2.0",
        runtime: "worker",
        cache: "cloudflare",
        v2Enabled: false
      }
    }
  );
  const sunset = await request(
    "/v1/lyrics/search",
    new FixtureTransport(),
    {
      env: {
        appUserAgent: "GatewayTest/2.0",
        runtime: "worker",
        cache: "cloudflare",
        v1SunsetDate: "Wed, 21 Oct 2026 07:28:00 GMT"
      }
    }
  );

  assert.equal(disabled.status, 404);
  assert.equal(sunset.headers.Deprecation, "true");
  assert.equal(sunset.headers.Sunset, "Wed, 21 Oct 2026 07:28:00 GMT");
  assert.equal(sunset.headers.Link, '</openapi.json>; rel="service-desc"');
});

async function request(
  path: string,
  transport: UpstreamTransport,
  overrides: Partial<GatewayContext> = {}
) {
  return handleGatewayRequest(
    {
      method: "GET",
      url: `https://gateway.example${path}`,
      requestId: "request-v2"
    },
    {
      transport,
      env: {
        appUserAgent: "GatewayTest/2.0",
        runtime: "worker",
        cache: "cloudflare",
        acoustidApiKey: undefined
      },
      ...overrides
    }
  );
}

class FixtureTransport implements UpstreamTransport {
  readonly urls: URL[] = [];

  constructor(
    private readonly responder: (url: URL) => UpstreamJsonResult = (url) => success(url, {})
  ) {}

  async getJson(url: string): Promise<UpstreamJsonResult> {
    const parsed = new URL(url);
    this.urls.push(parsed);
    return this.responder(parsed);
  }
}

function success(url: URL, data: unknown): UpstreamJsonResult {
  return { kind: "success", data, status: 200, host: url.hostname, cacheHit: false };
}

function failure(url: URL, status: number): UpstreamJsonResult {
  return { kind: "failure", status, host: url.hostname, cacheHit: false };
}

function notFound(url: URL): UpstreamJsonResult {
  return { kind: "not_found", status: 404, host: url.hostname, cacheHit: false };
}

function objectFixture(result: UpstreamJsonResult): Record<string, unknown> {
  return result.kind === "success" && result.data && typeof result.data === "object"
    ? result.data as Record<string, unknown>
    : {};
}
