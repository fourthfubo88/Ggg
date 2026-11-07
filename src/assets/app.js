// Streaming Passport homepage: live title search (Wikidata) + availability lookup (your Cloudflare worker).
// Settings come from config.json via window.AIRMAIL, written into the page at build time.
(() => {
const CFG = window.AIRMAIL || {};
const WORKER_URL = (CFG.workerUrl || "").replace(/\/$/, "");
const BASE = CFG.base || "/";
const VPNS = CFG.vpns || [];

const BASE_CODES = ["US","CA","MX","BR","AR","CL","CO","PE","GB","IE","FR","DE","NL","BE","ES","PT","IT","CH","AT","DK","SE","NO","FI","PL","CZ","RO","HU","BG","RS","GR","TR","UA","LV","LT","EE","MD","CY","IL","AE","SA","EG","ZA","NG","KE","IN","JP","KR","TW","HK","SG","MY","ID","PH","TH","VN","AU","NZ"];
const SCREEN_TYPES = ["Q11424","Q29168811","Q506240","Q93204","Q24862","Q202866","Q5398426","Q581714","Q1259759","Q526877","Q63952888","Q15416","Q21191270"];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const flag = code => /^[A-Z]{2}$/.test(code||"") ? String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : "🌐";
let regionNames; try { regionNames = new Intl.DisplayNames(["en"], {type:"region"}); } catch(e) {}
const cname = code => { try { return regionNames ? regionNames.of(code) : code; } catch(e){ return code; } };
const vpnsFor = code => VPNS.filter(v => v.countries.includes(code));
const fold = s => String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
const stripArticle = t => t.replace(/^(the|a|an)\s+/, "");

let state = { selected:"US", title:null, show:null, imdb:null, filter:"" };

// Title pages that exist on this site (imdb id -> page path), loaded from titles.json
let pages = {};
fetch(BASE + "titles.json").then(r => r.ok ? r.json() : []).then(list => {
  for(const t of list) pages[t.imdb] = t.path;
  if(state.show) renderResults();
}).catch(() => {});

// ===== Wikidata (free, public domain, no key) =====
const WD = "https://www.wikidata.org/w/api.php";
async function wd(params){
  const qs = new URLSearchParams({format:"json", origin:"*", ...params}).toString();
  const res = await fetch(WD + "?" + qs);
  if(!res.ok) throw new Error("Title search returned an error (" + res.status + ").");
  return res.json();
}

const NOT_A_TITLE = /\b(director|actor|actress|producer|screenwriter|writer|company|studio|festival|character|soundtrack|album|song|single|episode|season|novel|book|award|band|musician|franchise|cinema|theatre|theater|channel|network)\b/i;
const IS_TITLE = /\b(film|movie|television|tv series|series|miniseries|sitcom|anime|documentary|soap opera|web series|programme|program)\b/i;
const guessType = d => /\b(series|sitcom|anime|soap|miniseries|programme|program|show)\b/i.test(d||"") ? "tv" : "movie";
const guessYear = d => { const m = String(d||"").match(/\b(18|19|20)\d{2}\b/); return m ? m[0] : ""; };

async function suggestTitles(q){
  const words = q.trim().split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}'’-]/gu, "")).filter(Boolean);
  if(!words.length) return [];
  const textQuery = words.join(" ") + "* haswbstatement:" + SCREEN_TYPES.map(t => "P31=" + t).join("|");
  const [a, b] = await Promise.all([
    wd({action:"wbsearchentities", search:q.trim(), language:"en", uselang:"en", type:"item", limit:"50"}),
    wd({action:"query", generator:"search", gsrsearch:textQuery, gsrnamespace:"0", gsrlimit:"40", prop:"pageprops", ppprop:"wb-sitelinks"}).catch(() => ({}))
  ]);
  const items = new Map();
  (a.search || []).forEach((r, i) => {
    const d = r.description || "";
    if(!IS_TITLE.test(d) || NOT_A_TITLE.test(d)) return;
    items.set(r.id, {id:r.id, title:r.label, desc:d, order:i});
  });
  const sitelinks = {};
  Object.values(b.query?.pages || {}).forEach(p => {
    sitelinks[p.title] = +(p.pageprops?.["wb-sitelinks"] || 0);
    if(!items.has(p.title)) items.set(p.title, {id:p.title, title:null, desc:"", order:50 + (p.index || 0)});
  });
  if(!items.size) return [];
  const ids = [...items.keys()].slice(0, 50);
  const needLabels = ids.filter(id => !items.get(id).title);
  const needLinks = ids.filter(id => !(id in sitelinks));
  const [labels, links] = await Promise.all([
    needLabels.length ? wd({action:"wbgetentities", ids:needLabels.join("|"), props:"labels|descriptions", languages:"en", languagefallback:"1"}) : {},
    needLinks.length ? wd({action:"query", titles:needLinks.join("|"), prop:"pageprops", ppprop:"wb-sitelinks"}) : {}
  ]);
  Object.values(labels.entities || {}).forEach(e => {
    const it = items.get(e.id); if(!it) return;
    it.title = e.labels?.en?.value || Object.values(e.labels || {})[0]?.value || null;
    it.desc = e.descriptions?.en?.value || "";
  });
  Object.values(links.query?.pages || {}).forEach(p => { sitelinks[p.title] = +(p.pageprops?.["wb-sitelinks"] || 0); });

  const qf = fold(q).trim();
  const tier1 = [], tier2 = [];
  for(const it of items.values()){
    if(!it.title) continue;
    const t = fold(it.title);
    it.pop = (sitelinks[it.id] || 0) + (100 - it.order) / 1000;
    it.type = guessType(it.desc); it.year = guessYear(it.desc);
    if(t.startsWith(qf) || stripArticle(t).startsWith(qf)) tier1.push(it);
    else if(t.split(/[\s:\-–(]+/).some(w => w.startsWith(qf))) tier2.push(it);
  }
  const byPop = (x,y) => y.pop - x.pop;
  return [...tier1.sort(byPop), ...tier2.sort(byPop)].slice(0, 8);
}

async function imdbIdFor(qid){
  const data = await wd({action:"wbgetclaims", entity:qid, property:"P345"});
  const claim = (data.claims?.P345 || []).find(c => /^tt\d+$/.test(c.mainsnak?.datavalue?.value || ""));
  return claim ? claim.mainsnak.datavalue.value : null;
}

// ===== Country selects + VPN panel =====
function fillSelects(extra = []){
  const codes = [...new Set([...BASE_CODES, ...extra])];
  const sorted = codes.map(c => [c, cname(c)]).sort((a,b)=>a[1].localeCompare(b[1]));
  const opts = sorted.map(([c,n]) => `<option value="${c}">${flag(c)} ${esc(n)}</option>`).join("");
  const f = $("#focusCountry").value || "US";
  $("#focusCountry").innerHTML = `<option value="">No preference</option>` + opts;
  $("#vpnCountry").innerHTML = opts;
  $("#focusCountry").value = f;
  $("#vpnCountry").value = state.selected;
}

function renderVPNs(){
  const code = state.selected;
  $("#vpnCountry").value = code;
  const list = vpnsFor(code);
  $("#disclose").hidden = !VPNS.some(v => v.affiliateUrl);
  if(!list.length){
    $("#vpnList").innerHTML = `<li><div class="note">None of the free plans listed here have servers in ${esc(cname(code))}. Paid plans from the same providers usually do.</div></li>`;
    return;
  }
  $("#vpnList").innerHTML = list.map(v => {
    const href = v.affiliateUrl || v.url;
    const rel = v.affiliateUrl ? "sponsored noopener" : "noopener";
    return `<li>
      <div class="name"><a href="${esc(href)}" target="_blank" rel="${rel}">${esc(v.name)}</a></div>
      <div class="meta">${esc(v.cap)}</div>
      <div class="note">${esc(v.note)}</div>
    </li>`;
  }).join("");
}

// ===== Live suggestions =====
const box = () => $("#suggest");
let items = [], active = -1, debounce, cache = new Map();

async function fetchSuggestions(q){
  const key = fold(q).trim();
  if(cache.has(key)) return cache.get(key);
  const list = await suggestTitles(q);
  cache.set(key, list);
  return list;
}

function highlight(title, q){
  const n = q.trim().length, t = fold(title), qf = fold(q).trim();
  let i = -1;
  if(t.startsWith(qf)) i = 0;
  else { const m = t.search(new RegExp("(^|[\\s:\\-–(])" + qf.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"))); if(m >= 0) i = m === 0 ? 0 : m + 1; }
  if(i < 0) return esc(title);
  return esc(title.slice(0,i)) + "<mark>" + esc(title.slice(i,i+n)) + "</mark>" + esc(title.slice(i+n));
}

function showSuggestions(list, q){
  items = list; active = list.length ? 0 : -1;
  const el = box();
  el.innerHTML = list.length ? list.map((r,i) => `
      <li role="option" id="opt${i}" data-i="${i}" aria-selected="${i===active}">
        <span class="t">${highlight(r.title, q)}<span class="d">${esc(r.desc)}</span></span>
        <span class="m">${r.type === "tv" ? "Series" : "Film"}${r.year ? ", " + r.year : ""}</span>
      </li>`).join("")
    : `<li class="empty">No movies or shows begin with “${esc(q)}”.</li>`;
  el.hidden = false;
  $("#q").setAttribute("aria-expanded","true");
  $("#q").setAttribute("aria-activedescendant", active >= 0 ? "opt0" : "");
}
function hideSuggestions(){ box().hidden = true; $("#q").setAttribute("aria-expanded","false"); }

function moveActive(d){
  if(!items.length) return;
  active = (active + d + items.length) % items.length;
  box().querySelectorAll("[role=option]").forEach((li,i) => li.setAttribute("aria-selected", i===active));
  $("#opt"+active).scrollIntoView({block:"nearest"});
  $("#q").setAttribute("aria-activedescendant", "opt"+active);
}

function onType(){
  const q = $("#q").value;
  clearTimeout(debounce);
  if(q.trim().length < 2){ hideSuggestions(); return; }
  debounce = setTimeout(async () => {
    try{
      const list = await fetchSuggestions(q);
      if($("#q").value === q) showSuggestions(list, q);
    }catch(e){
      box().innerHTML = `<li class="empty">${esc(e.message)}</li>`; box().hidden = false;
    }
  }, 200);
}

// ===== Availability =====
async function choose(item){
  hideSuggestions();
  $("#q").value = item.title;
  state.title = item; state.filter = ""; state.show = null; state.imdb = null;
  const res = $("#results");
  const fail = msg => { res.innerHTML = `<h2>${esc(item.title)}</h2><p class="status err">${msg}</p>`; };
  if(!WORKER_URL){ fail("Availability lookups aren't set up yet."); return; }
  res.innerHTML = `<h2>${esc(item.title)}</h2><div class="status">Loading countries…<div class="envelope-loader"></div></div>`;
  try{
    const imdb = await imdbIdFor(item.id);
    if(!imdb){ fail("This title has no IMDb ID listed, so its availability can't be looked up."); return; }
    state.imdb = imdb;
    const r = await fetch(WORKER_URL + "/show/" + imdb);
    if(r.status === 429){ fail("Today's lookup limit has been reached. Popular titles below still work; try a new title tomorrow."); return; }
    if(!r.ok){ fail("The availability service returned an error (" + r.status + "). Try again in a minute."); return; }
    const data = await r.json();
    if(!data.found){
      res.innerHTML = `<h2>${esc(item.title)}</h2><p class="status">No streaming, rental or purchase options are listed for this title in any country yet.</p>`;
      return;
    }
    state.show = data;
    fillSelects(Object.keys(data.countries));
    const focus = $("#focusCountry").value;
    if(focus){ state.selected = focus; renderVPNs(); }
    renderResults();
  }catch(e){
    fail("The lookup didn't finish: " + esc(e.message) + " Check your connection and try again.");
  }
}

function renderResults(){
  const item = state.title, show = state.show, res = $("#results");
  if(!item || !show) return;
  const focus = $("#focusCountry").value;
  const rank = {subscription:0, addon:1, free:2, rent:3, buy:4};
  let rows = Object.entries(show.countries).map(([code, opts]) => {
    const seen = new Set();
    const list = opts.slice().sort((a,b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9))
      .filter(o => { const k = o.service + (o.addon||"") + (o.type==="rent"||o.type==="buy" ? "rb" : o.type); if(seen.has(k)) return false; seen.add(k); return true; });
    return {code, name:cname(code), list, streams:list.filter(o => o.type!=="rent" && o.type!=="buy").length};
  });
  const streamable = rows.filter(r => r.streams > 0).length;
  rows.sort((a,b) => (b.code===focus) - (a.code===focus) || (b.streams>0) - (a.streams>0) || a.name.localeCompare(b.name));
  const f = fold(state.filter).trim();
  const shown = f ? rows.filter(r => fold(r.name + " " + r.list.map(s=>s.service).join(" ")).includes(f)) : rows;
  const meta = [show.type === "series" ? "TV series" : "Film", show.year].filter(Boolean).join(", ");
  const cls = t => t === "free" ? "free" : (t === "rent" || t === "buy") ? t : "flatrate";
  const page = state.imdb && pages[state.imdb];

  res.innerHTML = `
    <div class="titlehead">
      ${show.poster ? `<img src="${esc(show.poster)}" alt="">` : ""}
      <div><h2>${esc(show.title || item.title)}</h2>
      <p class="sub" style="margin:0">${esc(meta)}. Streaming in ${streamable} ${streamable===1?"country":"countries"}${rows.length - streamable ? `, rent or buy only in ${rows.length - streamable} more` : ""}.</p></div>
    </div>
    ${page ? `<a class="permalink" href="${esc(BASE + page)}">Open the full page for this title</a>` : ""}
    <div class="toolbar">
      <input type="text" id="rowFilter" placeholder="Filter by country or service" value="${esc(state.filter)}" aria-label="Filter results">
      <span class="count">${shown.length} shown</span>
    </div>
    <div class="legend">
      <span><span class="svc flatrate">Netflix</span> included with subscription</span>
      <span><span class="svc free">Tubi</span> free</span>
      <span><span class="svc rent">Apple TV</span> rent or buy</span>
    </div>
    <ul class="rows">
      ${shown.map(r => {
        const n = vpnsFor(r.code).length;
        const svcs = r.list.map(s => `<span class="svc ${cls(s.type)}">${esc(s.service)}${s.addon ? " via " + esc(s.addon) : ""}</span>`).join("");
        return `<li><button class="row" data-code="${esc(r.code)}" aria-pressed="${r.code===state.selected}">
          <span class="postmark" aria-hidden="true">${flag(r.code)}</span>
          <span class="cname">${esc(r.name)}<small>${n ? n + " free VPN" + (n>1?"s":"") : "No free VPN"}</small></span>
          <span class="services">${svcs}</span>
        </button></li>`;
      }).join("")}
    </ul>
    <p class="credit">Availability can change daily. Check the service before you subscribe.</p>`;

  $("#rowFilter").addEventListener("input", e => {
    state.filter = e.target.value;
    const pos = e.target.selectionStart;
    renderResults();
    const again = $("#rowFilter"); again.focus(); again.setSelectionRange(pos,pos);
  });
  res.querySelectorAll(".row").forEach(b => b.addEventListener("click", () => {
    state.selected = b.dataset.code;
    res.querySelectorAll(".row").forEach(x => x.setAttribute("aria-pressed", x===b));
    renderVPNs();
    if(window.innerWidth < 860) $("aside").scrollIntoView({behavior:"smooth", block:"start"});
  }));
}

// ===== Wire up =====
fillSelects();
renderVPNs();

const q = $("#q");
q.addEventListener("input", onType);
q.addEventListener("focus", () => { if(items.length && q.value.trim().length >= 2) box().hidden = false; });
q.addEventListener("keydown", e => {
  if(box().hidden) return;
  if(e.key === "ArrowDown"){ e.preventDefault(); moveActive(1); }
  else if(e.key === "ArrowUp"){ e.preventDefault(); moveActive(-1); }
  else if(e.key === "Escape"){ hideSuggestions(); }
});
box().addEventListener("mousedown", e => {
  const li = e.target.closest("[role=option]");
  if(li){ e.preventDefault(); choose(items[+li.dataset.i]); }
});
document.addEventListener("click", e => { if(!e.target.closest(".combo")) hideSuggestions(); });

$("#searchForm").addEventListener("submit", async e => {
  e.preventDefault();
  if(!box().hidden && items[active]) return choose(items[active]);
  if(q.value.trim().length < 2) return;
  try{
    const list = await fetchSuggestions(q.value);
    if(list.length) choose(list[0]); else showSuggestions(list, q.value);
  }catch(err){ $("#results").innerHTML = `<p class="status err">${esc(err.message)}</p>`; }
});

$("#vpnCountry").addEventListener("change", e => {
  state.selected = e.target.value;
  renderVPNs();
  document.querySelectorAll(".row").forEach(x => x.setAttribute("aria-pressed", x.dataset.code===state.selected));
});
$("#focusCountry").addEventListener("change", e => {
  if(e.target.value){ state.selected = e.target.value; renderVPNs(); }
  renderResults();
});
})();
