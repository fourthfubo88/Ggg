// Airmail site builder.
// 1. Picks popular movies and series from Wikidata (free, no key).
// 2. Looks up a limited number of them per run through your Cloudflare worker (which holds the API key and caches).
// 3. Writes the whole site into _site/: homepage, a page per title, browse page, legal pages, sitemap.
// Run by .github/workflows/build.yml every day and on every push. Locally: `node scripts/build.mjs`
// Set SKIP_FETCH=1 to build from saved data without contacting Wikidata, the worker or Google Fonts.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "_site");
const STORE_PATH = path.join(ROOT, "data", "titles.json");
const SKIP_FETCH = process.env.SKIP_FETCH === "1";

const cfg = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const VPNS = JSON.parse(await fs.readFile(path.join(ROOT, "data", "vpns.json"), "utf8"));
const SITE_URL = cfg.siteUrl.replace(/\/?$/, "/");
const BASE = new URL(SITE_URL).pathname;
const NAME = cfg.siteName || "Airmail";
const TODAY = new Date().toISOString().slice(0, 10);
const UA = `${NAME}SiteBuilder/1.0 (${SITE_URL})`;

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ph = (v, label) => (v && String(v).trim()) ? esc(v) : `[${label}]`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const cname = c => { try { return regionNames.of(c) || c; } catch { return c; } };
const flag = c => /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65)) : "🌐";
const niceDate = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const vpnsFor = code => VPNS.filter(v => v.countries.includes(code));
const anyAffiliate = VPNS.some(v => v.affiliateUrl);
const listJoin = arr => arr.length <= 1 ? arr.join("") : arr.length === 2 ? arr.join(" and ") : arr.slice(0, -1).join(", ") + " and " + arr.at(-1);

function slugify(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
}

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

async function writeOut(rel, content) {
  const file = path.join(OUT, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) await copyDir(a, b); else await fs.copyFile(a, b);
  }
}

// ---------- saved data ----------
let store = { seededAt: null, titles: {} };
try { store = JSON.parse(await fs.readFile(STORE_PATH, "utf8")); } catch { /* first run */ }

async function saveStore() {
  const entries = Object.entries(store.titles).sort((a, b) => (a[1].rank ?? 1e9) - (b[1].rank ?? 1e9));
  const body = entries.map(([k, v]) => JSON.stringify(k) + ":" + JSON.stringify(v)).join(",\n");
  await fs.writeFile(STORE_PATH, `{"seededAt":${JSON.stringify(store.seededAt)},"titles":{\n${body}\n}}\n`);
}

// ---------- 1. popular titles from Wikidata ----------
async function seedFromWikidata() {
  const query = `
SELECT ?item ?imdb ?label ?links ?type (MIN(?d) AS ?date) WHERE {
  VALUES ?type { wd:Q11424 wd:Q5398426 }
  ?item wdt:P31 ?type ; wikibase:sitelinks ?links ; wdt:P345 ?imdb .
  FILTER(?links >= ${Number(cfg.minWikipediaLanguages) || 40})
  ?item rdfs:label ?label . FILTER(LANG(?label) = "en")
  OPTIONAL { ?item wdt:P577|wdt:P580 ?d }
} GROUP BY ?item ?imdb ?label ?links ?type`;
  const res = await fetchWithTimeout("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query),
    { headers: { Accept: "application/sparql-results+json", "User-Agent": UA } }, 90000);
  if (!res.ok) throw new Error("Wikidata query returned " + res.status);
  const rows = (await res.json()).results.bindings;

  const byItem = new Map();
  for (const r of rows) {
    const imdb = r.imdb?.value || "";
    if (!/^tt\d+$/.test(imdb)) continue;
    const qid = r.item.value.split("/").pop();
    if (byItem.has(qid)) continue;
    byItem.set(qid, {
      qid, imdb,
      title: r.label.value,
      type: r.type.value.endsWith("Q5398426") ? "series" : "movie",
      year: r.date?.value ? r.date.value.slice(0, 4).replace(/^\+/, "") : null,
      links: Number(r.links.value),
    });
  }
  const top = [...byItem.values()].sort((a, b) => b.links - a.links).slice(0, cfg.titlesToTrack || 600);

  for (const t of Object.values(store.titles)) t.rank = null;
  top.forEach((t, i) => {
    const old = store.titles[t.imdb] || {};
    store.titles[t.imdb] = { ...old, ...t, rank: i + 1 };
  });
  store.seededAt = TODAY;
  console.log(`Wikidata: tracking ${top.length} popular titles.`);
}

// ---------- 2. availability lookups through the worker ----------
async function refreshAvailability() {
  const worker = (cfg.workerUrl || "").replace(/\/$/, "");
  if (!worker) { console.log("No workerUrl in config.json; skipping lookups."); return; }
  const staleMs = (cfg.refreshDays || 7) * 864e5;
  const tracked = Object.values(store.titles).filter(t => t.rank != null);
  const fresh = tracked.filter(t => !t.checkedAt).sort((a, b) => a.rank - b.rank);
  const stale = tracked.filter(t => t.checkedAt && Date.now() - Date.parse(t.checkedAt) > staleMs)
    .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
  const limit = process.env.LOOKUPS !== undefined && process.env.LOOKUPS !== "" ? Number(process.env.LOOKUPS) : (cfg.lookupsPerRun ?? 40);
  const queue = [...fresh, ...stale].slice(0, limit);
  let done = 0;

  for (const t of queue) {
    let res;
    try { res = await fetchWithTimeout(`${worker}/show/${t.imdb}`, { headers: { "User-Agent": UA } }); }
    catch (e) { console.log(`  ${t.imdb}: network error (${e.message}), stopping.`); break; }
    if (res.status === 429) { console.log("Daily API limit reached; stopping lookups for today."); break; }
    if (!res.ok) { console.log(`  ${t.imdb}: worker returned ${res.status}, skipping.`); continue; }
    const data = await res.json();
    t.checkedAt = TODAY;
    t.data = data.found ? data : null;
    done++;
    await sleep(400);
  }
  console.log(`Availability: refreshed ${done} of ${queue.length} queued titles.`);
}

// ---------- 3. fonts (self-hosted so visitors' browsers don't contact Google) ----------
const FONT_CSS_URL = "https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;800;900&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap";
const googleFontTags = `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${FONT_CSS_URL}">`;

async function selfHostFonts() {
  if (SKIP_FETCH) return googleFontTags;
  try {
    const res = await fetchWithTimeout(FONT_CSS_URL, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" } });
    if (!res.ok) throw new Error(res.status);
    let css = await res.text();
    const urls = [...new Set([...css.matchAll(/url\((https:[^)]+\.woff2)\)/g)].map(m => m[1]))];
    if (!urls.length) throw new Error("no font files listed");
    for (const [i, u] of urls.entries()) {
      const f = await fetchWithTimeout(u);
      if (!f.ok) throw new Error("font download " + f.status);
      await writeOut(`assets/fonts/f${i}.woff2`, Buffer.from(await f.arrayBuffer()));
      css = css.split(u).join(`fonts/f${i}.woff2`);
    }
    await writeOut("assets/fonts.css", css);
    console.log(`Fonts: self-hosted ${urls.length} files.`);
    return `<link rel="stylesheet" href="${BASE}assets/fonts.css">`;
  } catch (e) {
    console.log(`Fonts: couldn't self-host (${e.message}); using Google Fonts link.`);
    return googleFontTags;
  }
}

// ---------- page layout ----------
let FONT_TAGS = googleFontTags;

function layout({ path: pagePath, title, description, hero = false, noindex = false, body, ogImage, jsonld, scripts = "", ogType = "website" }) {
  const canonical = SITE_URL + (pagePath === "404.html" ? "" : pagePath);
  const fullTitle = hero ? title : `${title} | ${NAME}`;
  const nav = [["", "Search"], ["watch/", "All titles"], ["about/", "About"]]
    .map(([p, label]) => `<a href="${BASE}${p}"${p === pagePath ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const adsense = cfg.adsenseClientId
    ? `<script>if(navigator.globalPrivacyControl){(window.adsbygoogle=window.adsbygoogle||[]).requestNonPersonalizedAds=1;}</script>
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(cfg.adsenseClientId)}" crossorigin="anonymous"></script>` : "";
  const analytics = cfg.cloudflareAnalyticsToken
    ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${esc(cfg.cloudflareAnalyticsToken)}"}'></script>` : "";
  const verify = cfg.googleSiteVerification ? `<meta name="google-site-verification" content="${esc(cfg.googleSiteVerification)}">` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(canonical)}">`}
<meta property="og:site_name" content="${esc(NAME)}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">\n<meta name="twitter:card" content="summary">` : ""}
<meta name="theme-color" content="#1A2238">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23C8323C'/%3E%3Cpath d='M0 32 32 0' stroke='%23F8F9F7' stroke-width='6'/%3E%3Cpath d='M-8 24 24-8M8 40 40 8' stroke='%231E4FA0' stroke-width='6'/%3E%3C/svg%3E">
${FONT_TAGS}
<link rel="stylesheet" href="${BASE}assets/site.css">
${verify}
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}
${adsense}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${hero ? "" : `<header class="topbar"><div class="topbar-inner"><a class="brand" href="${BASE}">${esc(NAME)}</a><nav aria-label="Main">${nav}</nav></div></header>`}
${body}
<footer class="foot">
  <div class="foot-inner">
    <p>Streaming data from the Streaming Availability API by Movie of the Night. Title search from Wikidata. ${esc(NAME)} isn't affiliated with any streaming service or VPN provider.${anyAffiliate ? " Some VPN links are affiliate links." : ""}</p>
    <nav aria-label="Site">
      <a href="${BASE}about/">About</a>
      <a href="${BASE}watch/">All titles</a>
      <a href="${BASE}privacy/">Privacy</a>
      <a href="${BASE}terms/">Terms</a>
      <a href="${BASE}disclosure/">Affiliate disclosure</a>
      ${cfg.adsenseClientId ? `<a href="#" id="privacy-settings">Privacy settings</a>` : ""}
    </nav>
    <p>© ${new Date().getUTCFullYear()} ${esc(NAME)}</p>
  </div>
</footer>
${scripts}
${cfg.adsenseClientId ? `<script>
document.getElementById("privacy-settings").addEventListener("click", e => {
  e.preventDefault();
  window.googlefc = window.googlefc || {}; googlefc.callbackQueue = googlefc.callbackQueue || [];
  googlefc.callbackQueue.push({ CONSENT_API_READY: () => googlefc.showRevocationMessage() });
});
</script>` : ""}
${analytics}
</body>
</html>
`;
}

const FEATURES = {
  ads: !!cfg.adsenseClientId,
  analytics: !!cfg.cloudflareAnalyticsToken,
  affiliates: anyAffiliate,
};

function applyFeatures(html) {
  let prev;
  do {
    prev = html;
    html = html.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, mode, key, inner) =>
      (mode === "#") === !!FEATURES[key] ? inner : "");
  } while (html !== prev);
  return html;
}

function fillTokens(html) {
  return applyFeatures(html)
    .replace(/<!--[\s\S]*?-->\s*/g, "")
    .replaceAll("{{BASE}}", BASE)
    .replaceAll("{{SITE_NAME}}", esc(NAME))
    .replaceAll("{{SITE_URL}}", `<a href="${esc(SITE_URL)}">${esc(SITE_URL.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>`)
    .replaceAll("{{CONTACT_EMAIL}}", cfg.contactEmail ? `<a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a>` : "[CONTACT EMAIL]")
    .replaceAll("{{OPERATOR}}", ph(cfg.operatorName, "OPERATOR NAME"))
    .replaceAll("{{GOVERNING_LAW}}", ph(cfg.governingLaw, "STATE / COUNTRY"))
    .replaceAll("{{EFFECTIVE_DATE}}", cfg.legalEffectiveDate ? esc(niceDate(cfg.legalEffectiveDate)) : "[EFFECTIVE DATE]");
}

async function readContent(file) {
  const raw = await fs.readFile(path.join(ROOT, "content", file), "utf8");
  const m = raw.match(/<!--meta\s*([\s\S]*?)-->/);
  return { meta: m ? JSON.parse(m[1]) : {}, html: raw };
}

// ---------- availability helpers ----------
const RANK = { subscription: 0, addon: 1, free: 2, rent: 3, buy: 4 };
const isStream = o => o.type !== "rent" && o.type !== "buy";
const svcClass = t => t === "free" ? "free" : (t === "rent" || t === "buy") ? t : "flatrate";

function countryRows(data) {
  return Object.entries(data.countries).map(([code, opts]) => {
    const seen = new Set();
    const list = opts.slice().sort((a, b) => (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9)).filter(o => {
      const k = o.service + (o.addon || "") + (isStream(o) ? o.type : "rb");
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    return { code, name: cname(code), list, streams: list.filter(isStream).length };
  }).sort((a, b) => (b.streams > 0) - (a.streams > 0) || a.name.localeCompare(b.name));
}

function summarize(t, rows) {
  const title = t.data.title || t.title;
  const streaming = rows.filter(r => r.streams);
  const counts = new Map();
  for (const r of streaming) for (const s of new Set(r.list.filter(isStream).map(o => o.service))) counts.set(s, (counts.get(s) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const parts = [];
  if (streaming.length) {
    parts.push(`${title} is streaming in ${streaming.length} ${streaming.length === 1 ? "country" : "countries"}.`);
    if (top.length) parts.push(`It's most widely available on ${listJoin(top.map(([s, n]) => `${s} (${n} ${n === 1 ? "country" : "countries"})`))}.`);
  } else {
    parts.push(`${title} isn't included with any streaming subscription right now, but you can rent or buy it in ${rows.length} ${rows.length === 1 ? "country" : "countries"}.`);
  }
  const us = rows.find(r => r.code === "US");
  if (us && us.streams) parts.push(`In the United States, you can watch it on ${listJoin([...new Set(us.list.filter(isStream).map(o => o.service))])}.`);
  else if (us) parts.push(`In the United States, it's available to rent or buy but not to stream.`);
  else parts.push(`It isn't currently available in the United States.`);
  return { text: parts.join(" "), streamingCount: streaming.length };
}

function vpnLinks(code) {
  const list = vpnsFor(code);
  if (!list.length) return "No free VPN plans listed with servers here.";
  return "Free VPNs with servers here: " + list.map(v => {
    const href = v.affiliateUrl || v.url;
    return `<a href="${esc(href)}" target="_blank" rel="${v.affiliateUrl ? "sponsored noopener" : "noopener"}">${esc(v.name.replace(/ (Free|Basic)$/, ""))}</a>`;
  }).join(", ");
}

function titlePage(t, related) {
  const d = t.data;
  const title = d.title || t.title;
  const year = d.year || t.year;
  const kind = (d.type || t.type) === "series" ? "TV series" : "Film";
  const rows = countryRows(d);
  const { text, streamingCount } = summarize(t, rows);
  const checked = niceDate(t.checkedAt);

  const rowHtml = rows.map(r => `<li><div class="row" id="${r.code.toLowerCase()}">
    <span class="postmark" aria-hidden="true">${flag(r.code)}</span>
    <span class="cname">${esc(r.name)}<small>${r.streams ? `${r.streams} streaming option${r.streams > 1 ? "s" : ""}` : "Rent or buy only"}</small></span>
    <span class="services">${r.list.map(o => {
      const label = esc(o.service) + (o.addon ? " via " + esc(o.addon) : "");
      return o.link
        ? `<a class="svc ${svcClass(o.type)}" href="${esc(o.link)}" target="_blank" rel="nofollow noopener">${label}</a>`
        : `<span class="svc ${svcClass(o.type)}">${label}</span>`;
    }).join("")}<span class="vpnline">${vpnLinks(r.code)}</span></span>
  </div></li>`).join("\n");

  const relatedHtml = related.length ? `<section class="block"><h2>More to explore</h2><ul class="titles">${related.map(r =>
    `<li><a href="${BASE}${r.path}">${esc(r.title)}</a> <span>${r.year || ""}</span></li>`).join("")}</ul></section>` : "";

  const body = `<main id="main">
  <div class="cols">
    <div>
      <p class="kicker">${esc(kind)}${year ? ", " + esc(year) : ""}</p>
      <div class="titlehead">
        ${d.poster ? `<img src="${esc(d.poster)}" alt="Poster for ${esc(title)}" width="96" height="144">` : ""}
        <h1>Where to watch ${esc(title)}</h1>
      </div>
      <p class="summary">${esc(text)}</p>
      <p class="checked">Last checked ${esc(checked)}. Catalogs change often; check the service before you subscribe.</p>
      <div class="legend">
        <span><span class="svc flatrate">Netflix</span> included with subscription</span>
        <span><span class="svc free">Tubi</span> free</span>
        <span><span class="svc rent">Apple TV</span> rent or buy</span>
      </div>
      <ul class="rows">
${rowHtml}
      </ul>
      ${relatedHtml}
    </div>
    <aside>
      <div class="vpn-card">
        <h2>Watching abroad?</h2>
        <p class="note">Each country above lists the free VPN plans with servers there. Free plans have data caps, and most streaming services block VPN traffic and license content per country.</p>
        <p><a href="${BASE}terms/#vpns">Read our note on VPNs</a></p>
        ${anyAffiliate ? `<p class="disclose">Some VPN links earn this site a commission on paid plans. <a href="${BASE}disclosure/">How this works</a></p>` : ""}
        <p class="fine"><a href="${BASE}">Search another title</a></p>
      </div>
    </aside>
  </div>
</main>`;

  const jsonld = {
    "@context": "https://schema.org",
    "@type": (d.type || t.type) === "series" ? "TVSeries" : "Movie",
    name: title,
    ...(year ? { [(d.type || t.type) === "series" ? "startDate" : "datePublished"]: String(year) } : {}),
    ...(d.poster ? { image: d.poster } : {}),
    sameAs: [`https://www.imdb.com/title/${t.imdb}/`, `https://www.wikidata.org/wiki/${t.qid}`].filter(u => !u.endsWith("/undefined")),
    url: SITE_URL + t.path,
  };

  return layout({
    path: t.path,
    title: `Where to watch ${title}${year ? ` (${year})` : ""}: streaming in ${streamingCount} countries`,
    description: `See every country where ${title} is streaming, on which services, and which free VPNs have servers there. Last checked ${checked}.`,
    body, ogImage: d.poster, jsonld, ogType: (d.type || t.type) === "series" ? "video.tv_show" : "video.movie",
  });
}

function browsePage(published) {
  const sorted = published.slice().sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const groups = new Map();
  for (const t of sorted) {
    const L = /^[a-z]/.test(t.sortKey) ? t.sortKey[0].toUpperCase() : "#";
    if (!groups.has(L)) groups.set(L, []);
    groups.get(L).push(t);
  }
  const letters = [...groups.keys()];
  const body = `<main id="main" class="cols" style="display:block">
  <h1 class="display" style="font-size:clamp(40px,7vw,64px);line-height:.95;margin:0 0 8px">All titles</h1>
  <p class="sub">${published.length} popular movies and series, each with a page showing every country it streams in. Can't find one? <a href="${BASE}">Search for it</a>.</p>
  <label class="field" style="max-width:360px;margin-bottom:20px">Filter this list
    <input type="search" id="filter" placeholder="Type a title" autocomplete="off">
  </label>
  <nav class="letters" aria-label="Jump to letter">${letters.map(L => `<a href="#l-${L === "#" ? "num" : L}">${L}</a>`).join("")}</nav>
  ${[...groups.entries()].map(([L, list]) => `<section data-group><h2 class="letter" id="l-${L === "#" ? "num" : L}">${L}</h2><ul class="titles">${list.map(t =>
    `<li data-t="${esc(t.title.toLowerCase())}"><a href="${BASE}${t.path}">${esc(t.title)}</a> <span>${t.type === "series" ? "Series" : "Film"}${t.year ? ", " + t.year : ""}</span></li>`).join("")}</ul></section>`).join("\n")}
</main>`;
  const script = `<script>
document.getElementById("filter").addEventListener("input", e => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll("[data-t]").forEach(li => { li.hidden = q && !li.dataset.t.includes(q); });
  document.querySelectorAll("[data-group]").forEach(s => { s.hidden = !s.querySelector("[data-t]:not([hidden])"); });
});
</script>`;
  return layout({ path: "watch/", title: "All titles", description: `Browse ${published.length} popular movies and TV series and see where each one is streaming around the world.`, body, scripts: script });
}

// ---------- build ----------
if (!SKIP_FETCH) {
  const seedAge = store.seededAt ? (Date.now() - Date.parse(store.seededAt)) / 864e5 : Infinity;
  if (seedAge >= 7 || !Object.keys(store.titles).length) {
    try { await seedFromWikidata(); } catch (e) { console.log("Wikidata seeding failed: " + e.message); }
  }
  await refreshAvailability();
}

// Stable page paths
const usedSlugs = new Set(Object.values(store.titles).map(t => t.slug).filter(Boolean));
for (const t of Object.values(store.titles)) {
  if (t.slug) continue;
  let s = slugify(`${(t.data && t.data.title) || t.title}${t.year ? " " + t.year : ""}`) || t.imdb;
  if (usedSlugs.has(s)) s += "-" + t.imdb;
  usedSlugs.add(s);
  t.slug = s;
}
if (!SKIP_FETCH) await saveStore();

await fs.rm(OUT, { recursive: true, force: true });
await copyDir(path.join(ROOT, "src"), OUT);
await writeOut(".nojekyll", "");
FONT_TAGS = await selfHostFonts();

const published = Object.values(store.titles)
  .filter(t => t.data && t.data.countries && Object.keys(t.data.countries).length)
  .map(t => {
    const title = t.data.title || t.title;
    return { ...t, title, year: t.data.year || t.year, type: t.data.type || t.type, path: `watch/${t.slug}/`,
      sortKey: title.toLowerCase().replace(/^(the|a|an)\s+/, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "") };
  })
  .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));

// Title pages
await Promise.all(published.map((t, i) => {
  const near = [...published.slice(Math.max(0, i - 4), i), ...published.slice(i + 1, i + 5)].slice(0, 8);
  return writeOut(`${t.path}index.html`, titlePage(t, near));
}));
await writeOut("watch/index.html", browsePage(published));

// Content pages
for (const file of ["home.html", "about.html", "privacy.html", "terms.html", "disclosure.html", "404.html"]) {
  const { meta, html } = await readContent(file);
  let body = fillTokens(html);
  let scripts = "";
  if (file === "home.html") {
    const popular = published.slice(0, 24);
    body = body.replace("{{POPULAR}}", popular.length ? `<section class="block"><h2>Popular titles</h2>
      <p class="sub">Full country-by-country pages, updated weekly. <a href="${BASE}watch/">See all ${published.length}</a>.</p>
      <ul class="titles">${popular.map(t => `<li><a href="${BASE}${t.path}">${esc(t.title)}</a> <span>${t.type === "series" ? "Series" : "Film"}${t.year ? ", " + t.year : ""}</span></li>`).join("")}</ul></section>` : "");
    scripts = `<script>window.AIRMAIL=${JSON.stringify({ base: BASE, workerUrl: cfg.workerUrl, vpns: VPNS }).replace(/</g, "\\u003c")};</script>\n<script src="${BASE}assets/app.js"></script>`;
  }
  const out = meta.path === "404.html" ? "404.html" : `${meta.path}index.html`;
  await writeOut(out, layout({ ...meta, body, scripts,
    jsonld: file === "home.html" ? { "@context": "https://schema.org", "@type": "WebSite", name: NAME, url: SITE_URL } : undefined }));
}

// Machine-readable files
await writeOut("titles.json", JSON.stringify(published.map(t => ({ imdb: t.imdb, path: t.path, title: t.title, year: t.year, type: t.type }))));
const staticPaths = ["", "watch/", "about/", "privacy/", "terms/", "disclosure/"];
await writeOut("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticPaths.map(p => `<url><loc>${esc(SITE_URL + p)}</loc><lastmod>${TODAY}</lastmod></url>`).join("\n")}
${published.map(t => `<url><loc>${esc(SITE_URL + t.path)}</loc><lastmod>${t.checkedAt}</lastmod></url>`).join("\n")}
</urlset>
`);
await writeOut("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`);
if (cfg.adsenseClientId) await writeOut("ads.txt", `google.com, ${cfg.adsenseClientId.replace(/^ca-/, "")}, DIRECT, f08c47fec0942fa0\n`);

console.log(`Built ${published.length} title pages into _site/.`);
