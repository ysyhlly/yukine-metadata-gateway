import {
  qqMusicArtistSearchRequest,
  qqMusicLyricsRequest,
  qqMusicSongSearchRequest
} from "../requests.js";
import type { MetadataProvider, ProviderSearchContext } from "../types.js";
import type { UpstreamJsonResult } from "../../types.js";
import { qqMusicLyricsResponseSchema, qqMusicResponseSchema } from "../../contracts/upstream.js";
import { validateUpstream } from "../validation.js";

export type QqMusicQuery =
  | { operation: "song-search"; query: URLSearchParams }
  | { operation: "song-lyrics"; songMid: string }
  | { operation: "artist-search"; query: URLSearchParams };

export class QqMusicProvider
implements MetadataProvider<QqMusicQuery, UpstreamJsonResult> {
  readonly name = "qqmusic" as const;
  readonly capabilities = ["lyrics-search", "artist-search"] as const;

  async search(query: QqMusicQuery, context: ProviderSearchContext): Promise<UpstreamJsonResult> {
    const url = query.operation === "song-search"
      ? qqMusicSongSearchRequest(query.query)
      : query.operation === "artist-search"
        ? qqMusicArtistSearchRequest(query.query)
        : qqMusicLyricsRequest(query.songMid);
    const schema = query.operation === "song-lyrics"
      ? qqMusicLyricsResponseSchema
      : qqMusicResponseSchema;
    return validateUpstream(
      await context.requestJson(this.name, url),
      schema
    );
  }
}
