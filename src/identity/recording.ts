export interface RecordingArtistEvidence {
  id: string;
  name: string;
  sortName?: string;
}

export interface RecordingEvidenceLike {
  provider: string;
  id: string;
  title: string;
  artists: RecordingArtistEvidence[];
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

export interface SourceAttribution {
  provider: string;
  id: string;
  role: "identity" | "metadata" | "enrichment";
  matchedBy: string[];
  fields: string[];
  confidence: number;
}

export interface CanonicalRecording {
  canonicalId: string;
  title: string;
  artists: RecordingArtistEvidence[];
  album: string;
  coverUrl: string;
  durationMs?: number;
  identifiers: {
    recordingMbid?: string;
    workMbid?: string;
    isrc?: string;
    acoustId?: string;
  };
  fingerprintVerified: boolean;
  confidence: number;
  sources: SourceAttribution[];
  possibleDuplicates: Array<{ canonicalId: string; confidence: number }>;
}

interface Match {
  confidence: number;
  matchedBy: string[];
  blocked: boolean;
}

interface Group {
  evidence: RecordingEvidenceLike[];
  matchBySource: Map<string, Match>;
}

const VERSION_PATTERNS: Array<[string, RegExp]> = [
  ["radio_edit", /\bradio\s+edit\b/giu],
  ["live", /\blive\b/giu],
  ["remix", /\bremix(?:ed)?\b/giu],
  ["acoustic", /\bacoustic\b/giu],
  ["instrumental", /\binstrumental\b/giu],
  ["karaoke", /\bkaraoke\b/giu],
  ["remaster", /\bremaster(?:ed)?(?:\s+\d{2,4})?\b/giu]
];

export function resolveCanonicalRecordings(
  values: RecordingEvidenceLike[]
): CanonicalRecording[] {
  const ordered = [...values].sort(compareEvidence);
  const groups: Group[] = [];
  for (const value of ordered) {
    let selected: { group: Group; match: Match } | undefined;
    for (const group of groups) {
      const match = matchRecordings(group.evidence[0]!, value);
      if (!match.blocked && match.confidence >= 0.9) {
        if (!selected || match.confidence > selected.match.confidence) {
          selected = { group, match };
        }
      }
    }
    if (selected) {
      selected.group.evidence.push(value);
      selected.group.matchBySource.set(sourceKey(value), selected.match);
    } else {
      groups.push({
        evidence: [value],
        matchBySource: new Map([[sourceKey(value), {
          confidence: clamp(value.score),
          matchedBy: ["provider_result"],
          blocked: false
        }]])
      });
    }
  }

  const canonical = groups.map(canonicalizeGroup);
  for (let left = 0; left < groups.length; left += 1) {
    for (let right = left + 1; right < groups.length; right += 1) {
      const match = matchRecordings(groups[left]!.evidence[0]!, groups[right]!.evidence[0]!);
      if (!match.blocked && match.confidence >= 0.7 && match.confidence < 0.9) {
        canonical[left]!.possibleDuplicates.push({
          canonicalId: canonical[right]!.canonicalId,
          confidence: round(match.confidence)
        });
        canonical[right]!.possibleDuplicates.push({
          canonicalId: canonical[left]!.canonicalId,
          confidence: round(match.confidence)
        });
      }
    }
  }
  return canonical.sort((a, b) => b.confidence - a.confidence);
}

export function matchRecordings(
  left: RecordingEvidenceLike,
  right: RecordingEvidenceLike
): Match {
  const leftMbid = normalizeId(left.recordingMbid);
  const rightMbid = normalizeId(right.recordingMbid);
  if (leftMbid && rightMbid) {
    return leftMbid === rightMbid
      ? match(1, "recording_mbid")
      : blocked();
  }
  const leftIsrc = normalizeIsrc(left.isrc);
  const rightIsrc = normalizeIsrc(right.isrc);
  if (leftIsrc && rightIsrc) {
    return leftIsrc === rightIsrc ? match(0.99, "isrc") : blocked();
  }
  if (
    left.fingerprintVerified
    && right.fingerprintVerified
    && left.acoustId
    && right.acoustId
  ) {
    return left.acoustId === right.acoustId ? match(0.98, "acoustid") : blocked();
  }

  const leftTitle = normalizeMetadataText(left.title);
  const rightTitle = normalizeMetadataText(right.title);
  if (!sameVersions(leftTitle.versions, rightTitle.versions)) return blocked();
  const title = similarity(leftTitle.text, rightTitle.text);
  const artist = similarity(
    normalizeMetadataText(left.artists[0]?.name || "").text,
    normalizeMetadataText(right.artists[0]?.name || "").text
  );
  if (title < 0.92 || artist < 0.92) {
    return { confidence: round(title * 0.4 + artist * 0.4), matchedBy: [], blocked: false };
  }
  const hasBothDurations = positive(left.durationMs) && positive(right.durationMs);
  if (hasBothDurations && Math.abs(left.durationMs! - right.durationMs!) > 3_000) {
    return blocked();
  }
  const duration = hasBothDurations
    ? Math.max(0, 1 - Math.abs(left.durationMs! - right.durationMs!) / 3_000)
    : 0;
  const confidence = title * 0.4 + artist * 0.4 + duration * 0.2;
  return {
    confidence: round(hasBothDurations ? confidence : Math.min(0.89, confidence)),
    matchedBy: hasBothDurations
      ? ["title", "artist", "duration"]
      : ["title", "artist"],
    blocked: false
  };
}

export function normalizeMetadataText(value: string): {
  text: string;
  versions: string[];
} {
  let normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  const versions: string[] = [];
  for (const [version, pattern] of VERSION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(normalized)) versions.push(version);
    pattern.lastIndex = 0;
    normalized = normalized.replace(pattern, " ");
  }
  normalized = normalized
    .replace(/\b(?:feat|featuring|ft)\.?\s+.+$/giu, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return { text: normalized, versions: [...new Set(versions)].sort() };
}

function canonicalizeGroup(group: Group): CanonicalRecording {
  const values = [...group.evidence].sort(compareEvidence);
  const primary = values[0]!;
  const mbid = first(values.map((value) => normalizeId(value.recordingMbid)));
  const isrc = first(values.map((value) => normalizeIsrc(value.isrc)));
  const acoustId = first(values.map((value) => normalizeId(value.acoustId)));
  const workMbid = first(values.map((value) => normalizeId(value.workMbid)));
  const cover = values.find((value) =>
    value.provider === "musicbrainz" && value.coverUrl
  )?.coverUrl || values.find((value) => value.coverUrl)?.coverUrl || "";
  const sources = values.map((value) => {
    const sourceMatch = group.matchBySource.get(sourceKey(value));
    return {
      provider: value.provider,
      id: value.id,
      role: value === primary ? "identity" as const : "metadata" as const,
      matchedBy: sourceMatch?.matchedBy || ["provider_result"],
      fields: sourceFields(value),
      confidence: round(sourceMatch?.confidence ?? value.score)
    };
  });
  return {
    canonicalId: canonicalId(primary, mbid, isrc, acoustId),
    title: primary.title,
    artists: primary.artists,
    album: primary.album,
    coverUrl: cover,
    ...(positive(primary.durationMs) ? { durationMs: primary.durationMs } : {}),
    identifiers: {
      ...(mbid ? { recordingMbid: mbid } : {}),
      ...(workMbid ? { workMbid } : {}),
      ...(isrc ? { isrc } : {}),
      ...(acoustId ? { acoustId } : {})
    },
    fingerprintVerified: values.some((value) => value.fingerprintVerified),
    confidence: round(Math.max(...sources.map((source) => source.confidence))),
    sources,
    possibleDuplicates: []
  };
}

function canonicalId(
  primary: RecordingEvidenceLike,
  mbid: string,
  isrc: string,
  acoustId: string
): string {
  if (mbid) return `recording:mbid:${encodeURIComponent(mbid)}`;
  if (isrc) return `recording:isrc:${encodeURIComponent(isrc)}`;
  if (primary.fingerprintVerified && acoustId) {
    return `recording:acoustid:${encodeURIComponent(acoustId)}`;
  }
  return `recording:${encodeURIComponent(primary.provider)}:${encodeURIComponent(primary.id)}`;
}

function compareEvidence(left: RecordingEvidenceLike, right: RecordingEvidenceLike): number {
  return providerPriority(left.provider) - providerPriority(right.provider)
    || right.score - left.score
    || sourceKey(left).localeCompare(sourceKey(right));
}

function providerPriority(provider: string): number {
  if (provider === "musicbrainz") return 0;
  if (provider === "acoustid") return 1;
  if (provider === "itunes") return 2;
  return 3;
}

function sourceFields(value: RecordingEvidenceLike): string[] {
  return [
    value.title ? "title" : "",
    value.artists.length ? "artists" : "",
    value.album ? "album" : "",
    value.coverUrl ? "coverUrl" : "",
    positive(value.durationMs) ? "durationMs" : "",
    value.recordingMbid ? "identifiers.recordingMbid" : "",
    value.workMbid ? "identifiers.workMbid" : "",
    value.isrc ? "identifiers.isrc" : "",
    value.acoustId ? "identifiers.acoustId" : ""
  ].filter(Boolean);
}

function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const previous = Array.from({ length: rightPoints.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= leftPoints.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= rightPoints.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (
          leftPoints[leftIndex - 1] === rightPoints[rightIndex - 1] ? 0 : 1
        )
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return 1 - previous[rightPoints.length]! / Math.max(leftPoints.length, rightPoints.length);
}

function match(confidence: number, matchedBy: string): Match {
  return { confidence, matchedBy: [matchedBy], blocked: false };
}

function blocked(): Match {
  return { confidence: 0, matchedBy: [], blocked: true };
}

function sameVersions(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeId(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") || "";
}

function normalizeIsrc(value: string | undefined): string {
  return value?.replace(/[^a-z0-9]/giu, "").toUpperCase() || "";
}

function sourceKey(value: RecordingEvidenceLike): string {
  return `${value.provider}\u0000${value.id}`;
}

function first(values: string[]): string {
  return values.find(Boolean) || "";
}

function positive(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function round(value: number): number {
  return Math.round(clamp(value) * 10_000) / 10_000;
}
