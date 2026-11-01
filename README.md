# Airmail

Where in the world is it streaming? A static site with live title search, a page for every popular title, and free VPNs by country.

## How it fits together

- **`content/`** – the homepage and the about, privacy, terms, affiliate-disclosure and 404 pages.
- **`src/assets/`** – the stylesheet and the homepage script (live search and lookups).
- **`scripts/build.mjs`** – builds the whole site into `_site/`: picks popular titles from Wikidata, looks up where they stream through the worker, and writes a page for each one, plus the browse page, sitemap and robots.txt.
- **`.github/workflows/build.yml`** – runs the build every day and on every change, saves the title data back to `data/titles.json`, and publishes the site to GitHub Pages.
- **`worker.js` + `wrangler.toml`** – the Cloudflare worker that holds the Streaming Availability API key and caches results. Cloudflare redeploys it from this repository.
- **`data/vpns.json`** – the free VPN list. Paste an affiliate tracking link into a provider's `affiliateUrl` once you're approved.

## Settings (`config.json`)

| Setting | What it does |
|---|---|
| `siteUrl` | Full address of the site, ending in `/`. Change it when you add a custom domain. |
| `workerUrl` | Address of the Cloudflare worker. |
| `contactEmail`, `operatorName`, `governingLaw`, `legalEffectiveDate` (YYYY-MM-DD) | Filled into the legal pages. Until set, the pages show placeholders like `[CONTACT EMAIL]`. |
| `adsenseClientId` | Your AdSense ID (`ca-pub-…`). Adds the ad script to every page and creates `ads.txt`. |
| `cloudflareAnalyticsToken` | Turns on Cloudflare Web Analytics (cookieless). |
| `googleSiteVerification` | The code from Google Search Console's "HTML tag" verification option. |
| `titlesToTrack` | How many popular titles get their own page. |
| `lookupsPerRun` | Lookups the daily build may use. Keep it well under the API's daily limit (100 on the free plan) so visitors' searches still work. |
| `refreshDays` | How often each title page is re-checked. |

## Before launch

1. Fill in the legal settings above and have the pages in `content/` reviewed; each has notes for the reviewer at the top.
2. Buy a domain, add it in **Settings → Pages → Custom domain**, and update `siteUrl`. `robots.txt` and `ads.txt` only work at the root of a domain.
3. Set `ALLOWED_ORIGIN` in `wrangler.toml` to the site's origin (for example `https://example.com`).
4. Submit `sitemap.xml` in Google Search Console.
5. Apply for AdSense and the VPN affiliate programs, then fill in `adsenseClientId` and the `affiliateUrl` values.
