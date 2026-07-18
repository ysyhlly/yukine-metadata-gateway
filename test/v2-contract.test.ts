import assert from "node:assert/strict";
import test from "node:test";
import { handleGatewayRequest } from "../src/core.js";
import type {
  GatewayContext,
  UpstreamJsonResult,
  UpstreamTransport
} from "../src/types.js";

const RECORDING_ID = "12345678-1234-4123-8123-123456789abc";

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
});

test("v2 feature flag and v1 sunset headers preserve the release boundary", async () => {
  const disabled = await request(
    "/v2/recordings/search?title=Song",
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
