import assert from "node:assert/strict";
import test from "node:test";
import {
  matchRecordings,
  normalizeMetadataText,
  resolveCanonicalRecordings,
  type RecordingEvidenceLike
} from "../src/identity/recording.js";

test("identity resolver merges conservative title artist and duration matches", () => {
  const values = [
    evidence({
      provider: "itunes",
      id: "2",
      title: "Halo",
      artists: [{ id: "b", name: "Beyoncé" }],
      durationMs: 241_000,
      score: 0.75
    }),
    evidence({
      provider: "musicbrainz",
      id: "mb",
      title: "Halo",
      artists: [{ id: "a", name: "Beyoncé" }],
      durationMs: 240_000,
      recordingMbid: "12345678-1234-4123-8123-123456789abc",
      score: 0.98
    })
  ];

  const resolved = resolveCanonicalRecordings(values);

  assert.equal(resolved.length, 1);
  assert.equal(
    resolved[0]?.canonicalId,
    "recording:mbid:12345678-1234-4123-8123-123456789abc"
  );
  assert.deepEqual(resolved[0]?.sources.map((source) => source.provider), [
    "musicbrainz",
    "itunes"
  ]);
});

test("identity resolver never merges version or strong identifier conflicts", () => {
  const studio = evidence({
    id: "studio",
    title: "Halo",
    recordingMbid: "12345678-1234-4123-8123-123456789abc"
  });
  const live = evidence({
    provider: "itunes",
    id: "live",
    title: "Halo (Live)",
    recordingMbid: "87654321-4321-4321-8321-cba987654321"
  });

  assert.equal(matchRecordings(studio, live).blocked, true);
  assert.equal(resolveCanonicalRecordings([studio, live]).length, 2);
});

test("missing duration caps text matches below the automatic merge threshold", () => {
  const left = evidence({ id: "left", durationMs: undefined });
  const right = evidence({ provider: "itunes", id: "right", durationMs: undefined });

  const match = matchRecordings(left, right);
  const resolved = resolveCanonicalRecordings([left, right]);

  assert.equal(match.confidence, 0.8);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0]?.possibleDuplicates.length, 1);
});

test("identity resolver matches any shared ISRC while retaining the primary legacy value", () => {
  const left = evidence({
    id: "left",
    isrc: "USAAA1000001",
    isrcs: ["USAAA1000001", "JPAAA1000002"]
  });
  const right = evidence({
    provider: "itunes",
    id: "right",
    isrc: "GBAAA1000003",
    isrcs: ["GBAAA1000003", "JP-AAA-10-00002"]
  });

  const resolved = resolveCanonicalRecordings([right, left]);

  assert.equal(matchRecordings(left, right).confidence, 0.99);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.identifiers.isrc, "USAAA1000001");
  assert.deepEqual(resolved[0]?.isrcs, [
    "USAAA1000001",
    "JPAAA1000002",
    "GBAAA1000003"
  ]);
});

test("normalization preserves version meaning while normalizing Unicode text", () => {
  const normalized = normalizeMetadataText("  Ｈａｌｏ（Live） feat. Guest ");

  assert.equal(normalized.text, "halo");
  assert.deepEqual(normalized.versions, ["live"]);
});

test("resolver output is deterministic regardless of provider result order", () => {
  const values = [
    evidence({ provider: "itunes", id: "2", durationMs: 181_000 }),
    evidence({
      provider: "musicbrainz",
      id: "1",
      recordingMbid: "12345678-1234-4123-8123-123456789abc",
      durationMs: 180_000
    })
  ];

  assert.deepEqual(
    resolveCanonicalRecordings(values),
    resolveCanonicalRecordings([...values].reverse())
  );
});

test("resolver exposes multi-value recording and work metadata while retaining legacy identifiers", () => {
  const verifiedAt = 1_784_420_000_000;
  const resolved = resolveCanonicalRecordings([evidence({
    isrc: "us-rc1-76-07839",
    isrcs: ["USRC17607839", "JPABC1234567", "US-RC1-76-07839"],
    workIdentifiers: [
      {
        type: "MUSICBRAINZ_WORK_ID",
        namespace: "",
        value: "WORK-UUID",
        source: "musicbrainz",
        confidence: 1,
        verifiedAt
      },
      {
        type: "ISWC",
        namespace: "iswc",
        value: "t-123.456.789-0",
        source: "musicbrainz",
        confidence: 1,
        verifiedAt
      }
    ],
    workCredits: [{
      artistId: "ARTIST-MBID",
      name: "作者名",
      role: "COMPOSER",
      source: "musicbrainz",
      confidence: 0.9,
      verifiedAt
    }]
  })])[0];

  assert.deepEqual(resolved?.identifiers, {
    workMbid: "work-uuid",
    isrc: "USRC17607839"
  });
  assert.deepEqual(resolved?.isrcs, ["USRC17607839", "JPABC1234567"]);
  assert.deepEqual(resolved?.workIdentifiers, [
    {
      type: "MUSICBRAINZ_WORK_ID",
      namespace: "",
      value: "work-uuid",
      source: "musicbrainz",
      confidence: 1,
      verifiedAt
    },
    {
      type: "ISWC",
      namespace: "iswc",
      value: "T-123.456.789-0",
      source: "musicbrainz",
      confidence: 1,
      verifiedAt
    }
  ]);
  assert.deepEqual(resolved?.workCredits, [{
    artistId: "artist-mbid",
    name: "作者名",
    role: "COMPOSER",
    source: "musicbrainz",
    confidence: 0.9,
    verifiedAt
  }]);
  assert.deepEqual(resolved?.sources[0]?.fields.filter((field) =>
    ["isrcs", "workIdentifiers", "workCredits"].includes(field)
  ), ["isrcs", "workIdentifiers", "workCredits"]);
});

function evidence(overrides: Partial<RecordingEvidenceLike> = {}): RecordingEvidenceLike {
  return {
    provider: "musicbrainz",
    id: "id",
    title: "Song",
    artists: [{ id: "artist", name: "Artist" }],
    album: "Album",
    coverUrl: "",
    durationMs: 180_000,
    score: 0.95,
    ...overrides
  };
}
