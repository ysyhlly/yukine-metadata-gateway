import { itunesRecordingSearch } from "../requests.js";
import type { MetadataProvider, ProviderSearchContext } from "../types.js";
import type { UpstreamJsonResult } from "../../types.js";
import { itunesResponseSchema } from "../../contracts/upstream.js";
import { validateUpstream } from "../validation.js";

export interface ItunesQuery {
  title: string;
  artist: string;
  limit: number;
}

export class ItunesProvider
implements MetadataProvider<ItunesQuery, UpstreamJsonResult> {
  readonly name = "itunes" as const;
  readonly capabilities = ["recording-search"] as const;

  async search(query: ItunesQuery, context: ProviderSearchContext): Promise<UpstreamJsonResult> {
    return validateUpstream(
      await context.requestJson(
        this.name,
        itunesRecordingSearch(query.title, query.artist, query.limit)
      ),
      itunesResponseSchema
    );
  }
}
