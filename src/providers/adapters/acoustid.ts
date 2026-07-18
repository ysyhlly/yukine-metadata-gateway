import { acoustIdLookupRequest } from "../requests.js";
import type { MetadataProvider, ProviderSearchContext } from "../types.js";
import type { UpstreamJsonResult } from "../../types.js";
import { acoustIdResponseSchema } from "../../contracts/upstream.js";
import { validateUpstream } from "../validation.js";

export interface AcoustIdQuery {
  client: string;
  duration: number;
  fingerprint: string;
}

export class AcoustIdProvider
implements MetadataProvider<AcoustIdQuery, UpstreamJsonResult> {
  readonly name = "acoustid" as const;
  readonly capabilities = ["recording-search"] as const;

  async search(query: AcoustIdQuery, context: ProviderSearchContext): Promise<UpstreamJsonResult> {
    return validateUpstream(
      await context.requestJson(this.name, acoustIdLookupRequest(query)),
      acoustIdResponseSchema
    );
  }
}
