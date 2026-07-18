import { createDocument } from "zod-openapi";
import {
  artistQuerySchema,
  artistResponseSchema,
  invalidRequestSchema,
  lyricsQuerySchema,
  lyricsResponseSchema,
  recordingQuerySchema,
  recordingResponseSchema
} from "./v2.js";

const commonErrors = {
  "400": {
    description: "Invalid request",
    content: { "application/json": { schema: invalidRequestSchema } }
  },
  "502": {
    description: "All required upstream providers failed"
  }
};

export const openapiDocument = createDocument({
  openapi: "3.1.0",
  info: {
    title: "Yukine Metadata Gateway",
    version: "2.0.0",
    description: "Music metadata aggregation API for Node and Cloudflare Worker runtimes."
  },
  paths: {
    "/health": {
      get: {
        summary: "Liveness",
        responses: { "200": { description: "Runtime is alive" } }
      }
    },
    "/ready": {
      get: {
        summary: "Readiness",
        responses: {
          "200": { description: "Configured state backends are ready" },
          "503": { description: "A required state backend is unavailable" }
        }
      }
    },
    "/openapi.json": {
      get: {
        summary: "OpenAPI 3.1 document",
        responses: { "200": { description: "OpenAPI document" } }
      }
    },
    "/v1/recordings/search": legacyOperation("Legacy recording search"),
    "/v1/artists/search": legacyOperation("Legacy artist search"),
    "/v1/lyrics/search": legacyOperation("Legacy lyrics search"),
    "/v2/recordings/search": {
      get: {
        summary: "Canonical recording search",
        requestParams: { query: recordingQuerySchema },
        responses: {
          "200": {
            description: "Canonical recordings",
            content: { "application/json": { schema: recordingResponseSchema } }
          },
          ...commonErrors
        }
      }
    },
    "/v2/artists/search": {
      get: {
        summary: "Canonical artist search",
        requestParams: { query: artistQuerySchema },
        responses: {
          "200": {
            description: "Canonical artists",
            content: { "application/json": { schema: artistResponseSchema } }
          },
          ...commonErrors
        }
      }
    },
    "/v2/lyrics/search": {
      get: {
        summary: "Canonical lyrics search",
        requestParams: { query: lyricsQuerySchema },
        responses: {
          "200": {
            description: "Canonical lyrics or null",
            content: { "application/json": { schema: lyricsResponseSchema } }
          },
          ...commonErrors
        }
      }
    }
  }
});

function legacyOperation(summary: string) {
  return {
    get: {
      summary,
      deprecated: true,
      responses: {
        "200": { description: "Legacy v1 response" },
        "400": { description: "Missing query" },
        "502": { description: "Upstream failure" }
      }
    }
  };
}
