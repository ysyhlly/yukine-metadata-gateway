export interface AlbumArtistReference {
  id: string;
  name: string;
}

export interface AlbumSourceAttribution {
  provider: "musicbrainz";
  id: string;
  role: "identity";
}

export interface CanonicalAlbum {
  canonicalId: string;
  title: string;
  aliases: string[];
  artist: string;
  artists: AlbumArtistReference[];
  type: string;
  year?: number;
  identifiers: {
    releaseGroupMbid: string;
    releaseMbid?: string;
  };
  confidence: number;
  sources: AlbumSourceAttribution[];
}

export function canonicalizeMusicBrainzReleaseGroups(
  values: unknown[],
  options: {
    exact: boolean;
    releaseMbid?: string;
    limit: number;
  }
): CanonicalAlbum[] {
  const byReleaseGroup = new Map<string, CanonicalAlbum>();
  for (const value of values) {
    const album = albumFromReleaseGroup(value, options.exact, options.releaseMbid);
    if (!album) continue;
    const existing = byReleaseGroup.get(album.identifiers.releaseGroupMbid);
    if (!existing || album.confidence > existing.confidence) {
      byReleaseGroup.set(album.identifiers.releaseGroupMbid, album);
    }
  }
  return [...byReleaseGroup.values()]
    .sort((left, right) => {
      const confidence = right.confidence - left.confidence;
      if (confidence !== 0) return confidence;
      return left.canonicalId < right.canonicalId
        ? -1
        : left.canonicalId > right.canonicalId
          ? 1
          : 0;
    })
    .slice(0, options.limit);
}

export function canonicalizeMusicBrainzRelease(
  value: unknown,
  expectedReleaseGroupMbid?: string
): CanonicalAlbum[] {
  const release = object(value);
  const releaseMbid = mbid(release.id);
  const releaseGroup = object(release["release-group"]);
  const releaseGroupMbid = mbid(releaseGroup.id);
  if (
    !releaseMbid
    || !releaseGroupMbid
    || (
      expectedReleaseGroupMbid
      && releaseGroupMbid !== expectedReleaseGroupMbid.toLowerCase()
    )
  ) {
    return [];
  }
  const enrichedReleaseGroup = {
    ...releaseGroup,
    "artist-credit": array(releaseGroup, "artist-credit").length > 0
      ? array(releaseGroup, "artist-credit")
      : array(release, "artist-credit"),
    "first-release-date": string(releaseGroup["first-release-date"]) || string(release.date),
    releases: [{ id: releaseMbid, title: string(release.title) }]
  };
  const album = albumFromReleaseGroup(enrichedReleaseGroup, true, releaseMbid);
  return album ? [album] : [];
}

function albumFromReleaseGroup(
  value: unknown,
  exact: boolean,
  releaseMbid?: string
): CanonicalAlbum | null {
  const releaseGroup = object(value);
  const releaseGroupMbid = mbid(releaseGroup.id);
  const title = string(releaseGroup.title).trim();
  if (!releaseGroupMbid || !title) return null;

  const credits = array(releaseGroup, "artist-credit").map(object);
  const artists = credits.map((credit) => {
    const artist = object(credit.artist);
    return {
      id: string(artist.id),
      name: string(credit.name).trim() || string(artist.name).trim()
    };
  }).filter((artist) => artist.id && artist.name);
  const combinedArtist = credits.map((credit) => {
    const artist = object(credit.artist);
    const name = string(credit.name).trim() || string(artist.name).trim();
    return `${name}${string(credit.joinphrase)}`;
  }).join("").trim();

  const identifiers: CanonicalAlbum["identifiers"] = { releaseGroupMbid };
  if (releaseMbid) identifiers.releaseMbid = releaseMbid.toLowerCase();
  const year = releaseYear(releaseGroup["first-release-date"]);

  return {
    canonicalId: `album:mbid:${releaseGroupMbid}`,
    title,
    aliases: releaseAliases(releaseGroup, title),
    artist: combinedArtist || artists.map((artist) => artist.name).join(", "),
    artists,
    type: string(releaseGroup["primary-type"]).trim() || string(releaseGroup.type).trim(),
    ...(year === undefined ? {} : { year }),
    identifiers,
    confidence: exact ? 1 : clamp(number(releaseGroup.score, 0) / 100),
    sources: [{
      provider: "musicbrainz",
      id: releaseGroupMbid,
      role: "identity"
    }]
  };
}

function releaseAliases(releaseGroup: Record<string, unknown>, title: string): string[] {
  const aliases: string[] = [];
  const seen = new Set([normalized(title)]);
  for (const value of array(releaseGroup, "releases")) {
    const alias = string(object(value).title).trim();
    const key = normalized(alias);
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

function releaseYear(value: unknown): number | undefined {
  const match = string(value).match(/^(\d{4})(?:-|$)/u);
  if (!match) return undefined;
  const year = Number(match[1]);
  return Number.isInteger(year) && year > 0 ? year : undefined;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function mbid(value: unknown): string {
  const candidate = string(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(candidate)
    ? candidate
    : "";
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown, key: string): unknown[] {
  const target = object(value)[key];
  return Array.isArray(target) ? target : [];
}

function string(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function number(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
