import { createDocument } from "zod-openapi";
import { z } from "zod";
import {
  authorizationErrorSchema,
  authorizationRequestSchema,
  signedAuthorizationSchema
} from "@yukine/authorization-contract/schema";
import {
  albumQuerySchema,
  albumResponseSchema,
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

const authorizationErrors = {
  "400": authorizationError("Invalid authorization request"),
  "401": authorizationError("Invalid bearer credential"),
  "403": authorizationError("Authorization or capability denied"),
  "409": authorizationError("Nonce replay or binding conflict"),
  "410": authorizationError("Redemption URL expired or already used"),
  "429": authorizationError("Authorization rate limited"),
  "503": authorizationError("Authorization state unavailable")
};

export const openapiDocument = createDocument({
  openapi: "3.1.0",
  info: {
    title: "Yukine Metadata Gateway",
    version: "2.0.0",
    description: "Music metadata aggregation API for Node and Cloudflare Worker runtimes. Trusted authorization issuance is a Node-only optional mode."
  },
  components: {
    securitySchemes: {
      gatewayBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "YUKINE opaque API key"
      }
    }
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
    "/v1/authorization/verify": authorizationOperation(
      "Verify a gateway API key and return a signed capability assertion"
    ),
    "/v1/authorization/activate": authorizationOperation(
      "Activate a pending API key after Cloud reserves its binding"
    ),
    "/v1/authorization/redeem/{token}": {
      post: {
        summary: "Redeem a one-time URL into a pending API key",
        description: "Node trusted-issuer mode only. The returned API key and activation token are visible once.",
        requestParams: {
          path: z.object({ token: z.string().min(1).max(256) })
        },
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: authorizationRequestSchema }
          }
        },
        responses: {
          "200": {
            description: "Pending API key, activation token, and signed assertion"
          },
          ...authorizationErrors
        }
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
    "/v2/albums/search": {
      get: {
        summary: "Canonical album search",
        requestParams: { query: albumQuerySchema },
        responses: {
          "200": {
            description: "Canonical albums",
            content: { "application/json": { schema: albumResponseSchema } }
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

function authorizationOperation(summary: string) {
  return {
    post: {
      summary,
      description: "Node trusted-issuer mode only.",
      security: [{ gatewayBearer: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: authorizationRequestSchema }
        }
      },
      responses: {
        "200": {
          description: "Signed authorization assertion",
          content: {
            "application/json": { schema: signedAuthorizationSchema }
          }
        },
        ...authorizationErrors
      }
    }
  };
}

function authorizationError(description: string) {
  return {
    description,
    content: {
      "application/json": { schema: authorizationErrorSchema }
    }
  };
}
