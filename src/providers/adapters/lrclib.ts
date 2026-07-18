import { lrclibExactRequest, lrclibSearchRequest } from "../requests.js";
import type { MetadataProvider, ProviderSearchContext } from "../types.js";
import type { UpstreamJsonResult } from "../../types.js";
import {
  lrclibExactResponseSchema,
  lrclibSearchResponseSchema
} from "../../contracts/upstream.js";
import { validateUpstream } from "../validation.js";

export type LrclibQuery =
  | { operation: "exact"; query: URLSearchParams }
  | { operation: "search"; query: URLSearchParams };

export class LrclibProvider
implements MetadataProvider<LrclibQuery, UpstreamJsonResult> {
  readonly name = "lrclib" as const;
  readonly capabilities = ["lyrics-search"] as const;

  async search(query: LrclibQuery, context: ProviderSearchContext): Promise<UpstreamJsonResult> {
    return validateUpstream(
      await context.requestJson(
        this.name,
        query.operation === "exact"
          ? lrclibExactRequest(query.query)
          : lrclibSearchRequest(query.query)
      ),
      query.operation === "exact"
        ? lrclibExactResponseSchema
        : lrclibSearchResponseSchema
    );
  }
}
