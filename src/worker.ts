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

    // rekt radio: liquidation timeline from liquidate.fun (used with permission), cached for a minute
    if (url.pathname === "/api/liq") {
      const c = url.searchParams.get("c") === "sol" ? "sol" : "btc";
      const cacheKey = new Request(`https://liq-cache/${c}`);
      const cache = (caches as any).default;
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      try {
        const r = await fetch(`https://liquidate.fun/api/timeline?c=${c}`, {
          headers: { "user-agent": "owlchainlabs rekt-radio (github.com/OwlChainLabs/wallet-vinyl)" },
        });
        if (!r.ok) throw new Error(String(r.status));
        const j: any = await r.json();
        const body = { coin: j.coin, now: j.now, buckets: j.buckets || [], highlights: j.highlights || [] };
        const res = Response.json(body, { headers: { "cache-control": "public, max-age=60" } });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      } catch (err) {
        return Response.json({ error: "liquidation feed unavailable" }, { status: 502, headers: { "cache-control": "no-store" } });
      }
    }

    // rekt radio page: /rekt, or the root of a rekt.* hostname
    if (url.pathname === "/rekt" || (url.hostname.startsWith("rekt.") && url.pathname === "/")) {
      return env.ASSETS.fetch(new Request(new URL("/rekt", url), request));
    }

    // /w/<wallet> links open the page; the page reads the wallet from the path
    if (url.pathname.startsWith("/w/")) {
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
