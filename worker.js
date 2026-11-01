// Airmail lookup worker: keeps your Streaming Availability API key secret
// and caches each title's results for a day so the free quota stretches further.

const DAY = 86400;

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600", ...cors, ...extra },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

    const match = new URL(request.url).pathname.match(/^\/show\/(tt\d{5,10})$/);
    if (!match) return json({ error: "use /show/<imdb id>" }, 404);
    const id = match[1];

    // 1. Cached?
    const cached = await env.CACHE.get(id, { type: "json" });
    if (cached) return json(cached, 200, { "X-Cache": "HIT" });

    // 2. Ask the API
    const rapid = env.API_SOURCE === "rapidapi";
    const base = rapid ? "https://streaming-availability.p.rapidapi.com" : "https://api.movieofthenight.com/v4";
    const headers = rapid
      ? { "X-RapidAPI-Key": env.SA_API_KEY, "X-RapidAPI-Host": "streaming-availability.p.rapidapi.com" }
      : { "X-API-Key": env.SA_API_KEY };

    let res;
    try {
      res = await fetch(`${base}/shows/${id}?series_granularity=show`, { headers });
    } catch {
      return json({ error: "upstream_unreachable" }, 502);
    }

    if (res.status === 404) {
      const notFound = { found: false };
      ctx.waitUntil(env.CACHE.put(id, JSON.stringify(notFound), { expirationTtl: DAY / 4 }));
      return json(notFound);
    }
    if (res.status === 429) return json({ error: "daily_limit" }, 429, { "Cache-Control": "no-store" });
    if (!res.ok) return json({ error: "upstream", status: res.status }, 502, { "Cache-Control": "no-store" });

    // 3. Keep only what the site shows, then cache it
    const show = await res.json();
    const slim = slimShow(show);
    ctx.waitUntil(env.CACHE.put(id, JSON.stringify(slim), { expirationTtl: DAY }));
    return json(slim, 200, { "X-Cache": "MISS" });
  },
};

function slimShow(show) {
  const countries = {};
  for (const [code, options] of Object.entries(show.streamingOptions || {})) {
    countries[code.toUpperCase()] = (options || []).map((o) => ({
      service: o.service?.name || o.service?.id || "Unknown",
      type: o.type, // subscription, free, rent, buy, addon
      addon: o.addon?.name || null,
      link: o.link || null,
    }));
  }
  const poster = show.imageSet?.verticalPoster?.w240 || show.imageSet?.verticalPoster?.w360 || null;
  return {
    found: Object.keys(countries).length > 0,
    title: show.title,
    type: show.showType, // movie or series
    year: show.releaseYear || show.firstAirYear || null,
    poster,
    countries,
  };
}
