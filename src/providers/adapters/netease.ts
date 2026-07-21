import {
  neteaseArtistIntroductionRequest,
  neteaseArtistSearchRequest,
  neteaseLyricsRequest,
  neteaseSongSearchRequest
} from "../requests.js";
import type { MetadataProvider, ProviderSearchContext } from "../types.js";
import type { UpstreamJsonResult } from "../../types.js";
import { neteaseLyricsResponseSchema, neteaseResponseSchema } from "../../contracts/upstream.js";
import { validateUpstream } from "../validation.js";

export type NeteaseQuery =
  | { operation: "artist-search"; query: URLSearchParams }
  | { operation: "artist-introduction"; id: string }
  | { operation: "song-search"; query: URLSearchParams }
  | { operation: "song-lyrics"; id: string };

export class NeteaseProvider
implements MetadataProvider<NeteaseQuery, UpstreamJsonResult> {
  readonly name = "netease" as const;
  readonly capabilities = ["artist-enrichment", "lyrics-search"] as const;

  async search(query: NeteaseQuery, context: ProviderSearchContext): Promise<UpstreamJsonResult> {
    const url = query.operation === "artist-search"
      ? neteaseArtistSearchRequest(query.query)
      : query.operation === "artist-introduction"
        ? neteaseArtistIntroductionRequest(query.id)
        : query.operation === "song-search"
          ? neteaseSongSearchRequest(query.query)
          : neteaseLyricsRequest(query.id);
    const schema = query.operation === "song-lyrics"
      ? neteaseLyricsResponseSchema
      : neteaseResponseSchema;
    return validateUpstream(
      await context.requestJson(this.name, url),
      schema
    );
  }
}
