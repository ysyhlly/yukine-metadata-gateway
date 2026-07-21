import {
  kugouLyricsDownloadRequest,
  kugouLyricsSearchRequest,
  kugouSongSearchRequest
} from "../requests.js";
import type { MetadataProvider, ProviderSearchContext } from "../types.js";
import type { UpstreamJsonResult } from "../../types.js";
import {
  kugouLyricsDownloadResponseSchema,
  kugouLyricsSearchResponseSchema,
  kugouResponseSchema
} from "../../contracts/upstream.js";
import { validateUpstream } from "../validation.js";

export type KugouQuery =
  | { operation: "song-search"; query: URLSearchParams }
  | { operation: "lyrics-search"; hash: string; durationMs: number }
  | { operation: "lyrics-download"; id: string; accessKey: string };

export class KugouProvider
implements MetadataProvider<KugouQuery, UpstreamJsonResult> {
  readonly name = "kugou" as const;
  readonly capabilities = ["lyrics-search"] as const;

  async search(query: KugouQuery, context: ProviderSearchContext): Promise<UpstreamJsonResult> {
    const url = query.operation === "song-search"
      ? kugouSongSearchRequest(query.query)
      : query.operation === "lyrics-search"
        ? kugouLyricsSearchRequest(query.hash, query.durationMs)
        : kugouLyricsDownloadRequest(query.id, query.accessKey);
    const schema = query.operation === "song-search"
      ? kugouResponseSchema
      : query.operation === "lyrics-search"
        ? kugouLyricsSearchResponseSchema
        : kugouLyricsDownloadResponseSchema;
    return validateUpstream(
      await context.requestJson(this.name, url),
      schema
    );
  }
}
