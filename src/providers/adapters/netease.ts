import {
  neteaseArtistIntroductionRequest,
  neteaseArtistSearchRequest
} from "../requests.js";
import type { MetadataProvider, ProviderSearchContext } from "../types.js";
import type { UpstreamJsonResult } from "../../types.js";
import { neteaseResponseSchema } from "../../contracts/upstream.js";
import { validateUpstream } from "../validation.js";

export type NeteaseQuery =
  | { operation: "artist-search"; query: URLSearchParams }
  | { operation: "artist-introduction"; id: string };

export class NeteaseProvider
implements MetadataProvider<NeteaseQuery, UpstreamJsonResult> {
  readonly name = "netease" as const;
  readonly capabilities = ["artist-enrichment"] as const;

  async search(query: NeteaseQuery, context: ProviderSearchContext): Promise<UpstreamJsonResult> {
    return validateUpstream(
      await context.requestJson(
        this.name,
        query.operation === "artist-search"
          ? neteaseArtistSearchRequest(query.query)
          : neteaseArtistIntroductionRequest(query.id)
      ),
      neteaseResponseSchema
    );
  }
}
