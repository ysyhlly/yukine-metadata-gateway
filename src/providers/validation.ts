import type { z } from "zod";
import type { UpstreamJsonResult } from "../types.js";

export function validateUpstream(
  response: UpstreamJsonResult,
  schema: z.ZodType
): UpstreamJsonResult {
  if (response.kind !== "success") return response;
  const parsed = schema.safeParse(response.data);
  if (parsed.success) return { ...response, data: parsed.data };
  return {
    kind: "failure",
    status: 502,
    host: response.host,
    provider: response.provider,
    cacheHit: false,
    cacheState: "miss",
    cacheLayer: "none",
    durationMs: response.durationMs,
    outcome: "parse"
  };
}
