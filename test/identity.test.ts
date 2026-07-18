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
