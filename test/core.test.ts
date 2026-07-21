import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { handleGatewayRequest } from "../src/core.js";
import type {
  GatewayContext,
  UpstreamJsonResult,
  UpstreamTransport
} from "../src/types.js";

const KRC_XOR_KEY = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];

function encodeKrc(text: string): string {
  const compressed = deflateSync(Buffer.from(text, "utf-8"));
  const xored = Buffer.alloc(compressed.length);
  for (let i = 0; i < compressed.length; i++) {
    xored[i] = compressed[i]! ^ KRC_XOR_KEY[i % KRC_XOR_KEY.length]!;
  }
  return xored.toString("base64");
}

const RECORDING_ID = "12345678-1234-4123-8123-123456789abc";
const RELEASE_ID = "87654321-4321-4321-8321-cba987654321";

test("health reports runtime capabilities without configuration details", async () => {
  const response = await request("/health", new FixtureTransport(), {
    runtime: "node",
    cache: "sqlite",
    acoustidApiKey: "secret"
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    runtime: "node",
    cache: "sqlite",
    acoustid: true
  });
  assert.doesNotMatch(JSON.stringify(response.body), /secret|path|query/i);
});

test("recording contract keeps fields and emits CAA cover only for declared front artwork", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.hostname === "musicbrainz.org") {
      return success(url, {
        recordings: [{
          id: RECORDING_ID,
          title: "Song",
          score: 98,
          "artist-credit": [{ artist: { id: "artist-id", name: "Artist" } }],
          releases: [
            { id: "not-a-uuid", title: "No cover", "cover-art-archive": { front: true } },
            { id: RELEASE_ID, title: "Album", "cover-art-archive": { front: true } }
          ]
        }]
      });
    }
    return failure(url, 500);
  });

  const response = await request("/v1/recordings/search?title=Song", transport);
  const recording = (response.body as { recordings: Array<Record<string, unknown>> }).recordings[0];

  assert.equal(response.status, 200);
  assert.equal(recording?.coverUrl, `https://coverartarchive.org/release/${RELEASE_ID}/front-500`);
  assert.equal(recording?.album, "No cover");
});

test("iTunes artwork accepts only HTTPS mzstatic subdomains", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.hostname === "musicbrainz.org") return success(url, { recordings: [] });
    return success(url, {
      results: [
        {
          trackId: 1,
          trackName: "Safe",
          artistId: 2,
          artistName: "Artist",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb.jpg"
        },
        {
          trackId: 3,
          trackName: "Unsafe",
          artistId: 4,
          artistName: "Artist",
          artworkUrl100: "https://images.example.com/cover.jpg"
        }
      ]
    });
  });

  const response = await request("/v1/recordings/search?title=Song", transport);
  const recordings = (response.body as { recordings: Array<{ coverUrl: string }> }).recordings;

  assert.equal(recordings[0]?.coverUrl, "https://is1-ssl.mzstatic.com/image/thumb.jpg");
  assert.equal(recordings[1]?.coverUrl, "");
});

test("Wikidata artist profile enrichment prefers Chinese descriptions", async () => {
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
            claims: {
              P18: [{ mainsnak: { datavalue: { value: "Aimer portrait.jpg" } } }]
            },
            descriptions: {
              en: { language: "en", value: "Japanese singer and lyricist" },
              zh: { language: "zh", value: "日本女歌手及作词家" }
            }
          }
        }
      });
    }
    return failure(url, 500);
  });

  const response = await request("/v1/artists/search?name=Aimer", transport);
  const artist = (response.body as {
    artists: Array<{ avatarUrl: string; description: string }>;
  }).artists[0];
  const wikidataRequest = transport.urls.find((url) => url.hostname === "www.wikidata.org");

  assert.equal(response.status, 200);
  assert.equal(
    artist?.avatarUrl,
    "https://commons.wikimedia.org/wiki/Special:Redirect/file/Aimer%20portrait.jpg?width=512"
  );
  assert.equal(artist?.description, "日本女歌手及作词家");
  assert.equal(wikidataRequest?.searchParams.get("props"), "claims|descriptions");
  assert.equal(wikidataRequest?.searchParams.get("languages"), "zh|zh-hans|zh-hant|en");
  assert.equal(transport.urls.some((url) => url.hostname === "music.163.com"), false);
});

test("Wikidata artist profile uses English description when Chinese is unavailable", async () => {
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
            descriptions: {
              en: { language: "en", value: "Japanese singer and lyricist" }
            }
          }
        }
      });
    }
    return failure(url, 500);
  });

  const response = await request("/v1/artists/search?name=Aimer", transport);
  const artist = (response.body as {
    artists: Array<{ avatarUrl: string; description: string }>;
  }).artists[0];

  assert.equal(response.status, 200);
  assert.equal(artist?.avatarUrl, "");
  assert.equal(artist?.description, "Japanese singer and lyricist");
});

test("NetEase supplements missing artist avatar and description after an exact match", async () => {
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
        aliases: [{ name: "エメ" }],
        relations: [{
          type: "wikidata",
          url: { resource: "https://www.wikidata.org/wiki/Q123" }
        }]
      });
    }
    if (url.hostname === "www.wikidata.org") {
      return success(url, { entities: { Q123: { claims: {}, descriptions: {} } } });
    }
    if (url.pathname === "/api/cloudsearch/pc") {
      return success(url, {
        code: 200,
        result: {
          artists: [{
            id: 16152,
            name: "Aimer",
            picUrl: "https://p1.music.126.net/portrait.jpg"
          }]
        }
      });
    }
    if (url.pathname === "/api/artist/introduction") {
      return success(url, {
        code: 200,
        briefDesc: "Aimer 是一名日本女歌手及作词家。"
      });
    }
    return failure(url, 500);
  });

  const response = await request("/v1/artists/search?name=Aimer", transport);
  const artist = (response.body as {
    artists: Array<{ avatarUrl: string; description: string }>;
  }).artists[0];
  const searchRequest = transport.urls.find((url) => url.pathname === "/api/cloudsearch/pc");
  const detailRequest = transport.urls.find((url) => url.pathname === "/api/artist/introduction");

  assert.equal(response.status, 200);
  assert.equal(artist?.avatarUrl, "https://p1.music.126.net/portrait.jpg");
  assert.equal(artist?.description, "Aimer 是一名日本女歌手及作词家。");
  assert.equal(searchRequest?.searchParams.get("type"), "100");
  assert.equal(searchRequest?.searchParams.get("limit"), "5");
  assert.equal(detailRequest?.searchParams.get("id"), "16152");
});

test("NetEase fills only a missing avatar without replacing Wikidata description", async () => {
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
            descriptions: {
              zh: { language: "zh", value: "来自 Wikidata 的介绍" }
            }
          }
        }
      });
    }
    if (url.pathname === "/api/cloudsearch/pc") {
      return success(url, {
        code: 200,
        result: {
          artists: [{
            id: 16152,
            name: "Aimer",
            picUrl: "https://p1.music.126.net/portrait.jpg"
          }]
        }
      });
    }
    return failure(url, 500);
  });

  const response = await request("/v1/artists/search?name=Aimer", transport);
  const artist = (response.body as {
    artists: Array<{ avatarUrl: string; description: string }>;
  }).artists[0];

  assert.equal(response.status, 200);
  assert.equal(artist?.avatarUrl, "https://p1.music.126.net/portrait.jpg");
  assert.equal(artist?.description, "来自 Wikidata 的介绍");
  assert.equal(
    transport.urls.some((url) => url.pathname === "/api/artist/introduction"),
    false
  );
});

test("NetEase rejects untrusted artist images and sanitizes introduction fallback", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.hostname === "musicbrainz.org" && url.pathname.endsWith("/artist/")) {
      return success(url, {
        artists: [{ id: RECORDING_ID, name: "Aimer", score: 100 }]
      });
    }
    if (url.hostname === "musicbrainz.org") {
      return success(url, { id: RECORDING_ID, name: "Aimer" });
    }
    if (url.pathname === "/api/cloudsearch/pc") {
      return success(url, {
        code: 200,
        result: {
          artists: [
            { id: 1, name: "Not Aimer", picUrl: "https://p1.music.126.net/wrong.jpg" },
            { id: 16152, name: "Aimer", picUrl: "https://images.example.com/portrait.jpg" }
          ]
        }
      });
    }
    if (url.pathname === "/api/artist/introduction") {
      return success(url, {
        code: 200,
        briefDesc: "",
        introduction: [{ txt: "<b>日本歌手</b>\u0000及作词家" }]
      });
    }
    return failure(url, 500);
  });

  const response = await request("/v1/artists/search?name=Aimer", transport);
  const artist = (response.body as {
    artists: Array<{ avatarUrl: string; description: string }>;
  }).artists[0];

  assert.equal(response.status, 200);
  assert.equal(artist?.avatarUrl, "");
  assert.equal(artist?.description, "日本歌手 及作词家");
});

test("NetEase ignores non-matching artist search results", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.hostname === "musicbrainz.org" && url.pathname.endsWith("/artist/")) {
      return success(url, {
        artists: [{ id: RECORDING_ID, name: "Aimer", score: 100 }]
      });
    }
    if (url.hostname === "musicbrainz.org") {
      return success(url, { id: RECORDING_ID, name: "Aimer" });
    }
    if (url.pathname === "/api/cloudsearch/pc") {
      return success(url, {
        code: 200,
        result: {
          artists: [{
            id: 999,
            name: "AIMERS",
            picUrl: "https://p1.music.126.net/wrong.jpg"
          }]
        }
      });
    }
    return failure(url, 500);
  });

  const response = await request("/v1/artists/search?name=Aimer", transport);
  const artist = (response.body as {
    artists: Array<{ avatarUrl: string; description: string }>;
  }).artists[0];

  assert.equal(response.status, 200);
  assert.equal(artist?.avatarUrl, "");
  assert.equal(artist?.description, "");
  assert.equal(
    transport.urls.some((url) => url.pathname === "/api/artist/introduction"),
    false
  );
});

test("artist detail enhancement failure preserves the successful base result", async () => {
  let calls = 0;
  const transport = new FixtureTransport((url) => {
    calls += 1;
    if (calls === 1) {
      return success(url, { artists: [{ id: RECORDING_ID, name: "Artist", score: 95 }] });
    }
    return failure(url, 503);
  });

  const response = await request("/v1/artists/search?name=Artist", transport);
  const artists = (response.body as {
    artists: Array<{ avatarUrl: string; description: string }>;
  }).artists;

  assert.equal(response.status, 200);
  assert.equal(artists.length, 1);
  assert.equal(artists[0]?.avatarUrl, "");
  assert.equal(artists[0]?.description, "");
});

test("lyrics races exact and search and selects the first usable record", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, { id: 1, trackName: "Song", syncedLyrics: "", plainLyrics: "" });
    }
    return success(url, [{
      id: 2,
      trackName: "Song",
      artistName: "Artist",
      albumName: "Album",
      duration: 180.25,
      syncedLyrics: "[00:01.00]Hello",
      plainLyrics: "Hello"
    }]);
  });

  const response = await request(
    "/v1/lyrics/search?title=Song&artist=Artist&album=Album&durationMs=180250",
    transport
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    lyrics: {
      provider: "lrclib",
      id: "2",
      title: "Song",
      artist: "Artist",
      album: "Album",
      durationMs: 180_250,
      syncedLyrics: "[00:01.00]Hello",
      plainLyrics: "Hello"
    }
  });
  assert.equal(transport.urls.length, 5);
});

test("lyrics enriches word-by-word from netease when yrc available", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 180,
        syncedLyrics: "[00:01.00]Hello",
        plainLyrics: "Hello"
      });
    }
    if (url.pathname === "/api/cloudsearch/pc") {
      return success(url, {
        code: 200,
        result: { songs: [{ id: 12345, name: "Song" }] }
      });
    }
    if (url.pathname === "/api/song/lyric") {
      return success(url, {
        code: 200,
        lrc: { lyric: "[00:01.00]Hello" },
        yrc: { lyric: "[00:01.00](0,500)H(500,300)e(800,200)llo" }
      });
    }
    return success(url, []);
  });

  const response = await request(
    "/v1/lyrics/search?title=Song&artist=Artist",
    transport
  );
  const lyrics = (response.body as { lyrics: Record<string, unknown> }).lyrics;

  assert.equal(response.status, 200);
  assert.equal(lyrics.syncedLyrics, "[00:01.00]Hello");
  assert.equal(lyrics.wordLyrics, "[00:01.00](0,500)H(500,300)e(800,200)llo");
  assert.equal(lyrics.wordLyricsSource, "netease");
});

test("lyrics gracefully degrades when netease lyrics unavailable", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 180,
        syncedLyrics: "[00:01.00]Hello",
        plainLyrics: "Hello"
      });
    }
    if (url.hostname === "music.163.com") {
      return failure(url, 503);
    }
    return success(url, []);
  });

  const response = await request(
    "/v1/lyrics/search?title=Song&artist=Artist",
    transport
  );
  const lyrics = (response.body as { lyrics: Record<string, unknown> }).lyrics;

  assert.equal(response.status, 200);
  assert.equal(lyrics.syncedLyrics, "[00:01.00]Hello");
  assert.equal(lyrics.wordLyrics, undefined);
  assert.equal(lyrics.wordLyricsSource, undefined);
});

test("netease song search mismatch returns no wordLyrics", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 180,
        syncedLyrics: "[00:01.00]Hello",
        plainLyrics: "Hello"
      });
    }
    if (url.pathname === "/api/cloudsearch/pc") {
      return success(url, {
        code: 200,
        result: { songs: [{ id: 99999, name: "Completely Different Title" }] }
      });
    }
    return success(url, []);
  });

  const response = await request(
    "/v1/lyrics/search?title=Song&artist=Artist",
    transport
  );
  const lyrics = (response.body as { lyrics: Record<string, unknown> }).lyrics;

  assert.equal(response.status, 200);
  assert.equal(lyrics.syncedLyrics, "[00:01.00]Hello");
  assert.equal(lyrics.wordLyrics, undefined);
});

test("wordLyrics truncated at 64KB boundary", async () => {
  const longYrc = "[00:01.00]" + "x".repeat(70_000);
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 180,
        syncedLyrics: "[00:01.00]Hello",
        plainLyrics: "Hello"
      });
    }
    if (url.pathname === "/api/cloudsearch/pc") {
      return success(url, {
        code: 200,
        result: { songs: [{ id: 12345, name: "Song" }] }
      });
    }
    if (url.pathname === "/api/song/lyric") {
      return success(url, {
        code: 200,
        yrc: { lyric: longYrc }
      });
    }
    return success(url, []);
  });

  const response = await request(
    "/v1/lyrics/search?title=Song&artist=Artist",
    transport
  );
  const lyrics = (response.body as { lyrics: Record<string, unknown> }).lyrics;

  assert.equal(response.status, 200);
  assert.equal((lyrics.wordLyrics as string).length, 65_536);
});

test("lyrics enriches word-by-word from QQ Music when QRC available", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 180,
        syncedLyrics: "[00:01.00]Hello",
        plainLyrics: "Hello"
      });
    }
    if (url.hostname === "c.y.qq.com" && url.pathname.includes("client_search_cp")) {
      return success(url, {
        code: 0,
        data: { song: { list: [{ songname: "Song", songmid: "abc123mid" }] } }
      });
    }
    if (url.hostname === "c.y.qq.com" && url.pathname.includes("fcg_query_lyric_new")) {
      return success(url, {
        code: 0,
        lyric: "[00:01.00]<0,500>H<500,300>e<800,200>llo QRC"
      });
    }
    return success(url, []);
  });

  const response = await request(
    "/v1/lyrics/search?title=Song&artist=Artist",
    transport
  );
  const lyrics = (response.body as { lyrics: Record<string, unknown> }).lyrics;

  assert.equal(response.status, 200);
  assert.equal(lyrics.wordLyrics, "[00:01.00]<0,500>H<500,300>e<800,200>llo QRC");
  assert.equal(lyrics.wordLyricsSource, "qqmusic");
});

test("lyrics enriches word-by-word from Kugou when KRC available", async () => {
  const krcContent = "[00:01.00]<0,500>H<500,300>e<800,200>llo KRC";
  const encodedKrc = encodeKrc(krcContent);
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 180,
        syncedLyrics: "[00:01.00]Hello",
        plainLyrics: "Hello"
      });
    }
    if (url.hostname === "mobilecdn.kugou.com") {
      return success(url, {
        status: 1,
        data: { info: [{ songname: "Song", hash: "ABC123HASH", duration: 180 }] }
      });
    }
    if (url.hostname === "krcs.kugou.com" && url.pathname === "/search") {
      return success(url, {
        status: 200,
        candidates: [{ id: "lyric-id-1", accesskey: "key123" }]
      });
    }
    if (url.hostname === "krcs.kugou.com" && url.pathname === "/download") {
      return success(url, {
        status: 200,
        content: encodedKrc
      });
    }
    return success(url, []);
  });

  const response = await request(
    "/v1/lyrics/search?title=Song&artist=Artist",
    transport
  );
  const lyrics = (response.body as { lyrics: Record<string, unknown> }).lyrics;

  assert.equal(response.status, 200);
  assert.equal(lyrics.wordLyrics, krcContent);
  assert.equal(lyrics.wordLyricsSource, "kugou");
});

test("lyrics selects best word lyrics when multiple sources return results", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 180,
        syncedLyrics: "[00:01.00]Hello",
        plainLyrics: "Hello"
      });
    }
    if (url.pathname === "/api/cloudsearch/pc") {
      return success(url, {
        code: 200,
        result: { songs: [{ id: 12345, name: "Song" }] }
      });
    }
    if (url.pathname === "/api/song/lyric") {
      return success(url, {
        code: 200,
        yrc: { lyric: "[00:01.00](0,500)Short" }
      });
    }
    if (url.hostname === "c.y.qq.com" && url.pathname.includes("client_search_cp")) {
      return success(url, {
        code: 0,
        data: { song: { list: [{ songname: "Song", songmid: "abc123mid" }] } }
      });
    }
    if (url.hostname === "c.y.qq.com" && url.pathname.includes("fcg_query_lyric_new")) {
      return success(url, {
        code: 0,
        lyric: "[00:01.00]<0,500>This is a much longer QRC lyrics content that should win<500,300>"
      });
    }
    return success(url, []);
  });

  const response = await request(
    "/v1/lyrics/search?title=Song&artist=Artist",
    transport
  );
  const lyrics = (response.body as { lyrics: Record<string, unknown> }).lyrics;

  assert.equal(response.status, 200);
  assert.equal(lyrics.wordLyricsSource, "qqmusic");
  assert.ok((lyrics.wordLyrics as string).includes("much longer"));
});

test("lyrics gracefully degrades when QQ Music and Kugou unavailable", async () => {
  const transport = new FixtureTransport((url) => {
    if (url.pathname.endsWith("/get")) {
      return success(url, {
        id: 1,
        trackName: "Song",
        artistName: "Artist",
        albumName: "Album",
        duration: 180,
        syncedLyrics: "[00:01.00]Hello",
        plainLyrics: "Hello"
      });
    }
    if (url.pathname === "/api/cloudsearch/pc") {
      return success(url, {
        code: 200,
        result: { songs: [{ id: 12345, name: "Song" }] }
      });
    }
    if (url.pathname === "/api/song/lyric") {
      return success(url, {
        code: 200,
        yrc: { lyric: "[00:01.00](0,500)H(500,300)e(800,200)llo" }
      });
    }
    if (url.hostname === "c.y.qq.com" || url.hostname.endsWith("kugou.com")) {
      return failure(url, 503);
    }
    return success(url, []);
  });

  const response = await request(
    "/v1/lyrics/search?title=Song&artist=Artist",
    transport
  );
  const lyrics = (response.body as { lyrics: Record<string, unknown> }).lyrics;

  assert.equal(response.status, 200);
  assert.equal(lyrics.wordLyrics, "[00:01.00](0,500)H(500,300)e(800,200)llo");
  assert.equal(lyrics.wordLyricsSource, "netease");
});

test("known 404 and valid empty lyrics are 200 null", async () => {
  let calls = 0;
  const transport = new FixtureTransport((url) => {
    calls += 1;
    return calls === 1
      ? { kind: "not_found", status: 404, host: url.hostname, cacheHit: false }
      : success(url, []);
  });

  const response = await request("/v1/lyrics/search?title=Missing", transport);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { lyrics: null });
});

test("all upstream failures return stable 502 without leaking the query", async () => {
  const response = await request(
    "/v1/lyrics/search?title=Private%20Title",
    new FixtureTransport((url) => failure(url, 429))
  );

  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: "upstream_failure", requestId: "request-1" });
  assert.doesNotMatch(JSON.stringify(response.body), /Private/);
});

test("lyrics title is required and bounded inputs never reach logs or response bodies", async () => {
  const response = await request("/v1/lyrics/search?artist=A", new FixtureTransport());

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "missing_query" });
});

test("shared core returns identical recording JSON for Worker and Node contexts", async () => {
  const fixture = (url: URL) => success(url, { recordings: [] });
  const worker = await request(
    "/v1/recordings/search?title=Song",
    new FixtureTransport(fixture),
    { runtime: "worker", cache: "cloudflare" }
  );
  const node = await request(
    "/v1/recordings/search?title=Song",
    new FixtureTransport(fixture),
    { runtime: "node", cache: "sqlite" }
  );

  assert.equal(worker.status, node.status);
  assert.deepEqual(worker.body, node.body);
});

test("shared core returns identical album JSON for Worker and Node contexts", async () => {
  const fixture = (url: URL) => success(url, { "release-groups": [] });
  const worker = await request(
    "/v2/albums/search?title=Album",
    new FixtureTransport(fixture),
    { runtime: "worker", cache: "cloudflare" }
  );
  const node = await request(
    "/v2/albums/search?title=Album",
    new FixtureTransport(fixture),
    { runtime: "node", cache: "sqlite" }
  );

  assert.equal(worker.status, node.status);
  assert.deepEqual(worker.body, node.body);
});

async function request(
  path: string,
  transport: UpstreamTransport,
  overrides: Partial<GatewayContext["env"]> = {}
) {
  return handleGatewayRequest(
    {
      method: "GET",
      url: `https://gateway.example${path}`,
      requestId: "request-1"
    },
    {
      transport,
      env: {
        appUserAgent: "GatewayTest/1.0",
        runtime: overrides.runtime ?? "worker",
        cache: overrides.cache ?? "cloudflare",
        acoustidApiKey: overrides.acoustidApiKey
      }
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
