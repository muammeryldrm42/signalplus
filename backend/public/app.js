const $ = (s)=>document.querySelector(s);
const $$ = (s)=>Array.from(document.querySelectorAll(s));

let activeTab = "uptrend";
// Signals are always visible (no Show/Hide toggle).
const showSignals = true;
let potentialFilter = "MED";
const cooldown = new Map();
// MC-crash blacklist: if market cap collapses (e.g., 100k -> 10k),
// remove from signal tabs and never re-add.
const MC_HISTORY_KEY = "dexpulse_mc_history_v1";
const MC_BLACKLIST_KEY = "dexpulse_mc_blacklist_v1";

function loadJson(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(_){
    return fallback;
  }
}

function saveJson(key, obj){
  try{ localStorage.setItem(key, JSON.stringify(obj)); }catch(_){/* ignore */}
}

function loadMcHistory(){
  return loadJson(MC_HISTORY_KEY, {});
}

function saveMcHistory(h){
  saveJson(MC_HISTORY_KEY, h);
}

function loadMcBlacklist(){
  return loadJson(MC_BLACKLIST_KEY, {});
}

function saveMcBlacklist(b){
  saveJson(MC_BLACKLIST_KEY, b);
}

function mcCrashDetected(prevMc, curMc){
  const p = Number(prevMc);
  const c = Number(curMc);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return false;
  if (p <= 0 || c <= 0) return false;
  // 10x collapse rule (e.g., 100k -> 10k)
  return c <= (p / 10);
}

function isSignalTab(tab){
  return tab === "uptrend" || tab === "smart" || tab === "whale" || tab === "hot";
}

function fmtUSD(n){
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1e9) return `$${(x/1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x/1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x/1e3).toFixed(1)}K`;
  if (x >= 1) return `$${x.toFixed(4)}`;
  return `$${x.toPrecision(3)}`;
}
function fmtNum(n){
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  if (x >= 1e9) return `${(x/1e9).toFixed(2)}B`;
  if (x >= 1e6) return `${(x/1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${(x/1e3).toFixed(1)}K`;
  return `${x.toFixed(2)}`;
}
function pct(n){
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  const s = x >= 0 ? "+" : "";
  return `${s}${x.toFixed(2)}%`;
}
function esc(v){
  return String(v ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}
function pctHtml(n){
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return `<span style="color:${x >= 0 ? "#4ade80" : "#f87171"}">${pct(x)}</span>`;
}
function riskPill(label){
  if (label === "LOW") return "pill riskLow";
  if (label === "MED") return "pill riskMed";
  return "pill riskHigh";
}
function logoHtml(url, symbol){
  const letter = esc(String(symbol||"?").slice(0,1));
  if (url) return `<img src="${esc(url)}" alt="logo" data-letter="${letter}" onerror="this.parentElement.textContent=this.dataset.letter;">`;
  return letter;
}
function setStatus(msg){ $("#status").textContent = msg || ""; }

async function api(path){
  const res = await fetch(path);
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || "Request failed");
  return j;
}

function currentListEndpoint(){
  if (activeTab === "uptrend") return `/api/list/uptrend_signal?potential=${encodeURIComponent(potentialFilter)}`;
  if (activeTab === "smart") return `/api/list/smart_money`;
  if (activeTab === "whale") return `/api/list/whale_alert`;
  if (activeTab === "hot") return `/api/list/hot_buys`;
  return `/api/list/uptrend_signal?potential=${encodeURIComponent(potentialFilter)}`;
}

function renderCards(items){
  const grid = $("#grid");
  grid.innerHTML = "";
  const filtered = items;

  // MC-crash blacklist (permanent): if MC collapses 10x, remove from signals and never re-add.
  const mcHist = loadMcHistory();
  const mcBlack = loadMcBlacklist();
  let wroteHistory = false;
  let wroteBlacklist = false;

  if (!filtered || filtered.length === 0){
    grid.innerHTML = `<div class="card muted">No tokens to show for this filter. Try another tab.</div>`;
    return;
  }

  for (const it of filtered){
    // Skip tokens that were permanently blacklisted for MC crash.
    if (isSignalTab(activeTab) && mcBlack[it.address]) continue;

    const ident = it.ident || {};
    const p = it.bestPair || {};
    const risk = it.risk || {};
    const price = p.priceUsd ? Number(p.priceUsd) : null;
    const liq = p?.liquidity?.usd;
    const vol24 = p?.volume?.h24;
    const mc = p?.marketCap;


    // MC-crash auto-remove (signals only): if MC collapses ~10x, blacklist permanently.
    if (isSignalTab(activeTab)){
      const prev = mcHist[it.address]?.mc;
      if (mcCrashDetected(prev, mc)){
        mcBlack[it.address] = { ts: Date.now(), reason: "mc_crash", prevMc: prev, mc: mc };
        wroteBlacklist = true;
        continue;
      }
    }

    // Update MC history (for next refresh).
    if (Number.isFinite(Number(mc)) && Number(mc) > 0){
      mcHist[it.address] = { mc: Number(mc), liq: Number(liq)||0, ts: Date.now() };
      wroteHistory = true;
    }

    const pills = [];
    pills.push(`<span class="${riskPill(risk.riskLabel)}">RISK ${risk.riskScore ?? "—"} (${risk.riskLabel||"—"})</span>`);
    if (it.dump?.dumpRisk) pills.push(`<span class="pill">DUMP ${it.dump.dumpRisk}</span>`);
    if (activeTab === "uptrend" && it.potential){
      pills.push(`<span class="pill">POTENTIAL ${it.potential.potential}</span>`);
      if (it.showBuy){
        const last = cooldown.get(it.address) || 0;
        const ok = (Date.now() - last) > 45*60*1000;
        if (ok) pills.push(`<span class="pill buy">BUY</span>`);
      }
    }
    if (activeTab === "smart" && it.smart?.smartLabel && it.smart.smartLabel !== "NONE"){
      pills.push(`<span class="pill">SMART ${it.smart.smartLabel}</span>`);
    }
    if (activeTab === "whale" && it.whale?.whaleLabel && it.whale.whaleLabel !== "NONE"){
      pills.push(`<span class="pill">WHALE ${it.whale.whaleLabel}</span>`);
    }

    const card = document.createElement("div");
    card.className = "card tokenCard";
    card.innerHTML = `
      <div class="row">
        <div class="left">
          <div class="logo">${logoHtml(ident.logo, ident.symbol)}</div>
          <div class="title">
            <div class="name" title="${esc(ident.name)}">${esc(ident.name||"Token")}</div>
            <div class="sym">${esc(ident.symbol)}</div>
          </div>
        </div>
        <div class="pills">${pills.join("")}</div>
      </div>

      <div class="metrics">
        <div class="kv"><div class="k">Price</div><div class="v">${price ? fmtUSD(price) : "—"}</div></div>
        <div class="kv"><div class="k">Chg (5m)</div><div class="v">${pctHtml(p?.priceChange?.m5)}</div></div>
        <div class="kv"><div class="k">Chg (1h)</div><div class="v">${pctHtml(p?.priceChange?.h1)}</div></div>
        <div class="kv"><div class="k">Chg (24h)</div><div class="v">${pctHtml(p?.priceChange?.h24)}</div></div>
        <div class="kv"><div class="k">Liquidity</div><div class="v">${fmtUSD(liq)}</div></div>
        <div class="kv"><div class="k">Vol (24h)</div><div class="v">${fmtUSD(vol24)}</div></div>
        <div class="kv"><div class="k">MC</div><div class="v">${fmtUSD(mc)}</div></div>
        <div class="kv"><div class="k">Signal MC</div><div class="v">${fmtUSD(it?.signalMeta?.firstSignalMc)}</div></div>
        <div class="kv"><div class="k">DEX</div><div class="v">${esc(String(p?.dexId || "—").toUpperCase())}</div></div>
      </div>
    `;
    card.addEventListener("click", ()=>openDetail(it.address));
    grid.appendChild(card);
  }

  if (wroteHistory) saveMcHistory(mcHist);
  if (wroteBlacklist) saveMcBlacklist(mcBlack);
}

function geckoEmbedUrl(pairAddress){
  const r = "15m";
  return `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(pairAddress)}?embed=1&info=0&swaps=0&light_chart=0&resolution=${encodeURIComponent(r)}`;
}

async function openDetail(address){
  try{
    setStatus("Loading token…");
    const data = await api(`/api/token/${encodeURIComponent(address)}`);
    setStatus("");

    const ident = data.ident || {};
    const p = data.bestPair || {};
    const risk = data.risk || {};
    const pot = data.potential || {};
    const dump = data.dump || {};
    const whale = data.whale || {};
    const smart = data.smart || {};
    const warnings = data.warnings || [];

    if (activeTab === "uptrend" && pot.buy){
      cooldown.set(address, Date.now());
    }

    const dsUrl = p?.url || (ident.address ? `https://dexscreener.com/solana/${ident.address}` : "#");
    const gtUrl = p?.pairAddress ? `https://www.geckoterminal.com/solana/pools/${p.pairAddress}` : "#";
    const bmUrl = ident.address ? `https://app.bubblemaps.io/solana/token/${ident.address}` : "#";

    const chartHtml = p?.pairAddress
      ? `<div class="chartBox"><iframe src="${geckoEmbedUrl(p.pairAddress)}" loading="lazy"></iframe></div>`
      : `<div class="card muted">Chart unavailable — <a href="${dsUrl}" target="_blank" rel="noreferrer">Open on DexScreener</a></div>`;

    const warnHtml = warnings.map(w=>{
      const cls = w.level === "danger" ? "danger" : w.level === "warn" ? "warn" : "ok";
      return `<div class="warnItem ${cls}">${esc(w.text)}</div>`;
    }).join("");

    const buyBadge = (showSignals && activeTab === "uptrend" && pot.buy) ? `<span class="pill buy">BUY</span>` : "";

    $("#detail").innerHTML = `
      <div class="detailHead">
        <div class="logo">${logoHtml(ident.logo, ident.symbol)}</div>
        <div class="title" style="min-width:0">
          <div class="name">${esc(ident.name || "Token")} ${buyBadge}</div>
          <div class="sym">${esc(ident.symbol)}</div>
          <div class="small muted" style="margin-top:4px;word-break:break-all">${esc(ident.address)}</div>
        </div>
      </div>

      <div class="actions">
        <a href="${dsUrl}" target="_blank" rel="noreferrer">DexScreener</a>
        <a href="${gtUrl}" target="_blank" rel="noreferrer">GeckoTerminal</a>
        <a href="${bmUrl}" target="_blank" rel="noreferrer">BubbleMaps</a>
        <button id="copyCaBtn">Copy CA</button>
      </div>

      <div class="hr"></div>

      ${chartHtml}

      <div class="hr"></div>

      <div class="metrics">
        <div class="kv"><div class="k">Price</div><div class="v">${p.priceUsd ? fmtUSD(Number(p.priceUsd)) : "—"}</div></div>
        <div class="kv"><div class="k">Chg (5m)</div><div class="v">${pctHtml(p?.priceChange?.m5)}</div></div>
        <div class="kv"><div class="k">Chg (1h)</div><div class="v">${pctHtml(p?.priceChange?.h1)}</div></div>
        <div class="kv"><div class="k">Chg (6h)</div><div class="v">${pctHtml(p?.priceChange?.h6)}</div></div>
        <div class="kv"><div class="k">Chg (24h)</div><div class="v">${pctHtml(p?.priceChange?.h24)}</div></div>
        <div class="kv"><div class="k">Liquidity</div><div class="v">${fmtUSD(p?.liquidity?.usd)}</div></div>
        <div class="kv"><div class="k">Vol (24h)</div><div class="v">${fmtUSD(p?.volume?.h24)}</div></div>
        <div class="kv"><div class="k">MC</div><div class="v">${fmtUSD(p?.marketCap)}</div></div>
        <div class="kv"><div class="k">Signal MC</div><div class="v">${fmtUSD(data?.signalMeta?.firstSignalMc)}</div></div>
        <div class="kv"><div class="k">Buys/Sells (1h)</div><div class="v">${p?.txns?.h1?.buys ?? "—"} / ${p?.txns?.h1?.sells ?? "—"}</div></div>
      </div>

      <div class="hr"></div>

      <div class="small">
        ${showSignals ? `
          <div class="row">
            <span class="${riskPill(risk.riskLabel)}">RISK ${risk.riskScore} (${risk.riskLabel})</span>
            <span class="pill">DUMP ${dump.dumpRisk || "—"}</span>
            <span class="pill">WHALE ${whale.whaleLabel || "—"}</span>
            <span class="pill">SMART ${smart.smartLabel || "—"}</span>
          </div>
          ${activeTab === "uptrend" ? `<div class="small muted" style="margin-top:8px"><b>Potential:</b> ${pot.potential || "—"} • ${esc((pot.why||[]).join(" • "))}</div>` : ""}
        ` : `<div class="muted">Enable “Show Signals” to see risk/potential insights.</div>`}
      </div>

      <div class="hr"></div>

      <div class="warnings">
        ${warnHtml}
      </div>
    `;

    $("#copyCaBtn").addEventListener("click", async ()=>{
      try{
        await navigator.clipboard.writeText(ident.address || "");
        $("#copyCaBtn").textContent = "Copied!";
        setTimeout(()=>($("#copyCaBtn").textContent="Copy CA"), 900);
      }catch(_){
        $("#copyCaBtn").textContent = "Copy failed";
        setTimeout(()=>($("#copyCaBtn").textContent="Copy CA"), 900);
      }
    });

  }catch(e){
    setStatus("");
    $("#detail").innerHTML = `<div class="card"><div class="muted">Failed to load token detail.</div><div class="small" style="margin-top:8px;color:#fca5a5">${esc(e.message||e)}</div></div>`;
  }
}

let listSeq = 0;
async function loadList(){
  const seq = ++listSeq;
  try{
    setStatus("Loading…");
    const endpoint = currentListEndpoint();
    const data = await api(endpoint);
    if (seq !== listSeq) return; // a newer tab click superseded this request
    const items = data.items || [];
    renderCards(items);
    setStatus(`Showing ${items.length} tokens`);
  }catch(e){
    if (seq !== listSeq) return;
    setStatus("");
    $("#grid").innerHTML = `<div class="card"><div class="muted">Failed to load list.</div><div class="small" style="margin-top:8px;color:#fca5a5">${esc(e.message||e)}</div></div>`;
  }
}

$("#searchBtn").addEventListener("click", async ()=>{
  const q = $("#q").value.trim();
  if (!q) return;
  try{
    setStatus("Searching…");
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    setStatus(`Search results: ${data.items.length}`);
    renderCards(data.items.map(x=>({ address:x.address, ident:x.ident, bestPair:x.bestPair, risk:x.risk })));
  }catch(e){
    setStatus("");
    $("#grid").innerHTML = `<div class="card"><div class="muted">Search failed.</div><div class="small" style="margin-top:8px;color:#fca5a5">${esc(e.message||e)}</div></div>`;
  }
});
$("#q").addEventListener("keydown",(e)=>{ if (e.key === "Enter") $("#searchBtn").click(); });

$$(".tab").forEach(t=>{
  t.addEventListener("click", ()=>{
    $$(".tab").forEach(x=>x.classList.remove("active"));
    t.classList.add("active");
    activeTab = t.dataset.tab;
    $("#potChips").style.display = (activeTab === "uptrend") ? "flex" : "none";
    loadList();
  });
});

$$('#potChips .chip').forEach(c=>{
  c.addEventListener("click", ()=>{
    $$('#potChips .chip').forEach(x=>x.classList.remove("active"));
    c.classList.add("active");
    potentialFilter = c.dataset.pot;
    loadList();
  });
});

const modal = $("#disclaimerModal");
$("#disclaimerBtn").addEventListener("click", ()=>modal.showModal());
$("#closeDisclaimer").addEventListener("click", ()=>modal.close());

(async ()=>{
  try{ await api("/api/health"); }catch(_){}
  $("#potChips").style.display = "none";
  loadList();
})();
