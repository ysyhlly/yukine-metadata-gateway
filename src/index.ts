import { handleGatewayRequest } from "./core.js";
import { JsonFetchTransport } from "./transport.js";

interface Env {
  ACOUSTID_API_KEY?: string;
  APP_USER_AGENT?: string;
}

const transport = new JsonFetchTransport({ cloudflareCache: true });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const result = await handleGatewayRequest(
      {
        method: request.method,
        url: request.url,
        requestId: crypto.randomUUID(),
        signal: request.signal
      },
      {
        env: {
          acoustidApiKey: env.ACOUSTID_API_KEY,
          appUserAgent: env.APP_USER_AGENT
            || "Yukine-Metadata-Gateway/1.0 (https://github.com/ysyhlly/yukine-metadata-gateway)",
          runtime: "worker",
          cache: "cloudflare"
        },
        transport
      }
    );
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: result.headers
    });
  }
};
