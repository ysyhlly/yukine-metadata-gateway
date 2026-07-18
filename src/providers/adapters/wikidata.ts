import { wikidataEntitiesRequest } from "../requests.js";
import type { MetadataProvider, ProviderSearchContext } from "../types.js";
import type { UpstreamJsonResult } from "../../types.js";
import { wikidataResponseSchema } from "../../contracts/upstream.js";
import { validateUpstream } from "../validation.js";

export interface WikidataQuery {
  query: URLSearchParams;
}

export class WikidataProvider
implements MetadataProvider<WikidataQuery, UpstreamJsonResult> {
  readonly name = "wikidata" as const;
  readonly capabilities = ["artist-enrichment"] as const;

  async search(query: WikidataQuery, context: ProviderSearchContext): Promise<UpstreamJsonResult> {
    return validateUpstream(
      await context.requestJson(this.name, wikidataEntitiesRequest(query.query)),
      wikidataResponseSchema
    );
  }
}
