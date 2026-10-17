// Serves the page and /api/vinyl. Results are cached for an hour per wallet.
import { buildRecord } from "./vinyl";

export default {
  async fetch(request: Request, env: any, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/vinyl") {
      const wallet = (url.searchParams.get("wallet") || "").trim();
      const cacheKey = new Request(`https://vinyl-cache/${wallet}`);
      const cache = (caches as any).default;
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      let body;
      try {
        body = await buildRecord(wallet);
      } catch (err) {
        console.error("vinyl failed", wallet, err);
        body = { wallet, error: "something broke while reading this wallet. try again in a minute." };
      }
      const res = Response.json(body, { headers: { "cache-control": body.error ? "no-store" : "public, max-age=3600" } });
      if (!body.error) ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    // /w/<wallet> links open the page; the page reads the wallet from the path
    if (url.pathname.startsWith("/w/")) {
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
