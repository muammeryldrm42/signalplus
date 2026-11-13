const express = require("express");
const cors = require("cors");
const path = require("path");
global.fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const cache = new Map();
function now(){ return Date.now(); }
function getCached(key){
  const hit = cache.get(key);
  if (!hit) return null;
  if (now() > hit.exp) return null;
  return hit.val;
}
function setCached(key, val, ttlMs){
  cache.set(key, { val, exp: now() + ttlMs });
  return val;
}

// In-memory rug blacklist based on market-cap crashes.
// Rule: if MC collapses ~10x (e.g., 100k -> 10k), blacklist permanently for this server runtime.
// Frontend also keeps its own persistent blacklist in localStorage.
const mcSeen = new Map(); // address -> { mc, liq, ts }
const mcBlack = new Set();

// Smart-money continuity tracker (avoid one-tick spikes).
const smartSeen = new Map(); // address -> { streak, lastScore, ts }

async function fetchJson(url, ttlMs = 15000){
  const cached = getCached(url);
  if (cached) return cached;
  const res = await fetch(url, { headers: { "accept": "application/json", "user-agent":"dexPulse-v6" } });
  if (!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error(`Upstream ${res.status}: ${t.slice(0,200)}`);
  }
  const data = await res.json();
  return setCached(url, data, ttlMs);
}

// --- Token classification helpers
const STABLE_SYMBOLS = new Set([
  "USDC","USDT","DAI","UXD","USDH","PYUSD","USDP","FRAX","TUSD","USDJ"
]);

// Liquid staking / staked SOL wrappers to keep out of Majors list
const LST_SYMBOLS = new Set([
  "MSOL",
  "JITOSOL",
  "JUPSOL",
  "BSOL",
  "SCNSOL",
  "HUBSOL",
  "INF",
  "SOLBLZE",
  "LST"
]);

function isStableSymbol(sym){
  const s = String(sym || "").toUpperCase();
  return STABLE_SYMBOLS.has(s);
}

function isLSTSymbol(sym){
  const s = String(sym || "").toUpperCase();
  return LST_SYMBOLS.has(s);
}

function safeNum(x){
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function isMcBlacklisted(address){
  return mcBlack.has(String(address||""));
}

function updateMcCrash(address, bestPair){
  const addr = String(address||"");
  if (!addr || !bestPair) return false;
  const curMc = safeNum(bestPair?.marketCap);
  const curLiq = safeNum(bestPair?.liquidity?.usd);
  const prev = mcSeen.get(addr);
  if (prev && prev.mc > 0 && curMc > 0){
    // 10x collapse rule, with a small floor to reduce noise.
    if (curMc <= (prev.mc / 10) && prev.mc >= 20000){
      mcBlack.add(addr);
      return true;
    }
  }
  // Track latest observation.
  if (curMc > 0 || curLiq > 0) mcSeen.set(addr, { mc: curMc, liq: curLiq, ts: now() });
  return false;
}

function normalizePair(p){
  if (!p) return null;
  return {
    chainId: p.chainId,
    dexId: p.dexId,
    pairAddress: p.pairAddress,
    url: p.url,
    baseToken: p.baseToken,
    quoteToken: p.quoteToken,
    priceUsd: p.priceUsd,
    fdv: p.fdv,
    marketCap: p.marketCap,
    liquidity: p.liquidity,
    volume: p.volume,
    priceChange: p.priceChange,
    txns: p.txns,
    info: p.info,
    pairCreatedAt: p.pairCreatedAt
  };
}

function pickBestPair(pairs){
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const score = (p) => {
    const liq = safeNum(p?.liquidity?.usd);
    const vol = safeNum(p?.volume?.h24);
    const tx = safeNum(p?.txns?.h24?.buys) + safeNum(p?.txns?.h24?.sells);
    return liq * 1e6 + vol * 10 + tx;
  };
  return [...pairs].sort((a,b)=>score(b)-score(a))[0];
}

// DexScreener only provides m5 / h1 / h6 / h24 windows (no m15, no h4).
// All heuristics below are built on those real windows.
function flowOf(p){
  const b5 = safeNum(p?.txns?.m5?.buys);
  const s5 = safeNum(p?.txns?.m5?.sells);
  const b1 = safeNum(p?.txns?.h1?.buys);
  const s1 = safeNum(p?.txns?.h1?.sells);
  const t5 = b5 + s5;
  const t1 = b1 + s1;
  const v1 = safeNum(p?.volume?.h1);
  return {
    b5, s5, b1, s1, t5, t1,
    r5: (b5 + 1) / (t5 + 2),
    r1: (b1 + 1) / (t1 + 2),
    avgTrade1: t1 > 0 ? v1 / t1 : 0
  };
}

function changesOf(p){
  const pc = p?.priceChange || {};
  return { m5: safeNum(pc.m5), h1: safeNum(pc.h1), h6: safeNum(pc.h6), h24: safeNum(pc.h24) };
}

function isFallingKnife(p){
  const c = changesOf(p);
  return c.h1 < -10 && c.h6 < -18 && c.h24 < -35;
}

function computeRisk(bestPair){
  if (!bestPair) return { riskScore: 85, riskLabel: "HIGH", flags:["NO_PAIR_DATA"] };

  const liq = safeNum(bestPair?.liquidity?.usd);
  const c = changesOf(bestPair);
  const ch5 = Math.abs(c.m5);
  const ch1 = Math.abs(c.h1);
  const f = flowOf(bestPair);

  const flags = [];
  let score = 25;

  if (liq < 1000) { score += 45; flags.push("MICRO_LIQUIDITY"); }
  else if (liq < 2500) { score += 35; flags.push("VERY_LOW_LIQUIDITY"); }
  else if (liq < 7500) { score += 25; flags.push("LOW_LIQUIDITY"); }
  else if (liq < 15000) { score += 15; }
  else if (liq < 30000) { score += 8; }

  if (ch5 > 25 || ch1 > 60) { score += 22; flags.push("EXTREME_SHORT_MOVE"); }
  else if (ch5 > 12 || ch1 > 30) { score += 12; flags.push("HIGH_VOLATILITY"); }

  if (liq < 7500 && (ch5 > 15 || ch1 > 40)) { score += 18; flags.push("MANIPULATION_RISK"); }

  if (f.t1 >= 60 && (f.r1 > 0.9 || f.r1 < 0.1)) { score += 14; flags.push("ANOMALOUS_FLOW"); }
  else if (f.t1 >= 40 && (f.r1 > 0.82 || f.r1 < 0.18)) { score += 8; flags.push("FLOW_IMBALANCE"); }

  if (f.t1 < 20) { score += 10; flags.push("LOW_ACTIVITY"); }

  const created = safeNum(bestPair?.pairCreatedAt);
  if (created > 0 && (now() - created) < 60 * 60 * 1000) { score += 10; flags.push("VERY_NEW_PAIR"); }

  if (isFallingKnife(bestPair)) { score += 18; flags.push("FALLING_KNIFE"); }

  score = Math.max(0, Math.min(100, score));
  const riskLabel = score <= 35 ? "LOW" : score <= 65 ? "MED" : "HIGH";
  return { riskScore: score, riskLabel, flags };
}

function computeDumpRisk(bestPair){
  if (!bestPair) return { dumpRisk:"UNKNOWN", reasons:[] };
  const c = changesOf(bestPair);
  const f = flowOf(bestPair);

  const reasons = [];
  if (c.m5 < -6) reasons.push("5m down");
  if (c.h1 < -15) reasons.push("1h down");
  if ((f.t5 >= 15 && f.r5 < 0.35) || (f.t1 >= 50 && f.r1 < 0.4)) reasons.push("sell pressure");

  let dumpRisk = "LOW";
  if (reasons.length >= 2) dumpRisk = "HIGH";
  else if (reasons.length === 1) dumpRisk = "MED";
  return { dumpRisk, reasons };
}

function computeWhaleLike(bestPair){
  if (!bestPair) return { whaleScore:0, whaleLabel:"NONE", reasons:[] };
  const liq = safeNum(bestPair?.liquidity?.usd);
  const c = changesOf(bestPair);
  const f = flowOf(bestPair);
  const vol24 = safeNum(bestPair?.volume?.h24);

  let score = 0;
  const reasons = [];
  // Average trade size is the closest public proxy for "big wallets are trading".
  if (f.t1 >= 20 && f.avgTrade1 >= 1500) { score += 30; reasons.push("very large avg trade"); }
  else if (f.t1 >= 20 && f.avgTrade1 >= 500) { score += 20; reasons.push("large avg trade"); }
  if (f.r1 >= 0.6 && f.t1 >= 40) { score += 25; reasons.push("buy dominance"); }
  if (f.t1 >= 150 || f.t5 >= 35) { score += 15; reasons.push("txn spike"); }
  if (vol24 >= 300000) { score += 10; reasons.push("strong 24h vol"); }
  if (c.m5 >= 2 || c.h1 >= 5) { score += 10; reasons.push("price lift"); }
  if (liq < 2500) { score -= 25; reasons.push("very low liq"); }
  else if (liq < 7500) { score -= 12; reasons.push("low liq"); }
  if (Math.abs(c.m5) > 35 || Math.abs(c.h1) > 80) { score -= 10; reasons.push("too wild"); }

  score = Math.max(0, Math.min(100, score));
  const whaleLabel = score >= 70 ? "HIGH" : score >= 45 ? "MED" : score >= 25 ? "LOW" : "NONE";
  return { whaleScore: score, whaleLabel, reasons: reasons.slice(0,3) };
}

function computeSmartMoney(bestPair){
  if (!bestPair) return { smartScore:0, smartLabel:"NONE", reasons:[] };
  const risk = computeRisk(bestPair);
  const whale = computeWhaleLike(bestPair);

  // Hard vetoes for "smart money" quality.
  const dump = computeDumpRisk(bestPair);
  if (risk.flags.includes("FALLING_KNIFE")){
    return { smartScore:0, smartLabel:"NONE", reasons:["falling knife"] };
  }
  if (dump.dumpRisk === "HIGH"){
    return { smartScore:0, smartLabel:"NONE", reasons:["dump risk"] };
  }

  const c = changesOf(bestPair);
  const f = flowOf(bestPair);
  const controlled = (Math.abs(c.m5) <= 16 && Math.abs(c.h1) <= 40);
  let score = 0;
  const reasons = [];

  if (risk.riskLabel === "LOW") { score += 30; reasons.push("low risk"); }
  else if (risk.riskLabel === "MED") { score += 15; reasons.push("med risk"); }
  else { score -= 30; reasons.push("high risk"); }

  if (whale.whaleScore >= 45) { score += 25; reasons.push("smart flow"); }
  if (controlled) { score += 15; reasons.push("controlled move"); }
  else { score -= 10; reasons.push("too volatile"); }

  if (f.t1 >= 50) { score += 10; reasons.push("active tape"); }
  else { score -= 10; reasons.push("low activity"); }

  if (f.r1 >= 0.58 && f.t1 >= 40){ score += 12; reasons.push("buy pressure"); }
  else if (f.r1 < 0.45 && f.t1 >= 40){ score -= 14; reasons.push("sell pressure"); }

  // Penalize medium dump risk to keep the feed clean.
  if (dump.dumpRisk === "MED"){ score -= 10; reasons.push("elevated dump risk"); }

  score = Math.max(0, Math.min(100, score));
  const smartLabel = score >= 70 ? "HIGH" : score >= 50 ? "MED" : score >= 30 ? "LOW" : "NONE";
  return { smartScore: score, smartLabel, reasons: reasons.slice(0,3) };
}

function computePotential(bestPair){
  if (!bestPair) return { potential:"LOW", why:["no data"], buy:false, buyWhy:[] };
  const risk = computeRisk(bestPair);
  const dump = computeDumpRisk(bestPair);

  if (risk.riskLabel === "HIGH") return { potential:"LOW", why:["high risk"], buy:false, buyWhy:[] };
  if (dump.dumpRisk === "HIGH") return { potential:"LOW", why:["dump risk"], buy:false, buyWhy:[] };

  const c = changesOf(bestPair);
  const f = flowOf(bestPair);

  const why = [];
  if (c.h1 > 0) why.push("1h momentum up");
  if (f.r1 >= 0.58 && f.t1 >= 40) why.push("buy flow");
  if (risk.riskLabel === "LOW") why.push("low risk");

  let potential = "LOW";
  if (c.h1 > 2 && c.m5 > -3 && f.r1 >= 0.55 && f.t1 >= 40) potential = "MED";
  if (c.h1 > 5 && c.m5 > 0 && f.r1 >= 0.6 && f.t1 >= 100 && risk.riskLabel === "LOW") potential = "HIGH";

  const buyWhy = [];
  let buy = false;

  // Dip setup: still below where it was 6h/24h ago, but not a falling knife.
  const gateA_deep = (c.h6 < 0 || c.h24 < 0) && !isFallingKnife(bestPair);
  if (!gateA_deep) buyWhy.push("no dip setup");

  const gateB_reversal = (c.m5 > 0 && c.h1 > 0) || (c.h1 > 3 && c.m5 > -0.5);
  if (!gateB_reversal) buyWhy.push("no reversal confirmation");

  const flowOK = (f.r1 >= 0.58 && f.t1 >= 40);
  if (!flowOK) buyWhy.push("flow not strong");

  const activityOK = (f.t1 >= 30);
  if (!activityOK) buyWhy.push("low activity");

  const manipulationVeto = (risk.flags.includes("MANIPULATION_RISK") || risk.flags.includes("EXTREME_SHORT_MOVE"));
  if (manipulationVeto) buyWhy.push("manipulation risk");

  const potentialOK = (potential !== "LOW");
  if (!potentialOK) buyWhy.push("potential too low");

  if (gateA_deep && gateB_reversal && flowOK && activityOK && !manipulationVeto && potentialOK){
    buy = true;
    buyWhy.length = 0;
    buyWhy.push("dip setup + reversal + flow + low/med risk");
  }

  return { potential, why: why.slice(0,3), buy, buyWhy };
}

// First-signal tracker: remembers the market cap at the moment a token first showed up in a signal tab.
const firstSignal = new Map(); // address -> { firstSignalMc, firstSignalTs }
function withSignalMeta(item){
  const addr = String(item?.address || "");
  let meta = firstSignal.get(addr);
  if (!meta){
    const mc = safeNum(item?.bestPair?.marketCap);
    if (mc > 0){
      meta = { firstSignalMc: mc, firstSignalTs: now() };
      firstSignal.set(addr, meta);
    }
  }
  return { ...item, signalMeta: meta || null };
}

function identFromPair(bestPair, tokenAddress){
  const base = bestPair?.baseToken || {};
  const name = base?.name || "Token";
  const symbol = base?.symbol || "";
  const logo = bestPair?.info?.imageUrl || "";
  return { address: tokenAddress, name, symbol, logo };
}

function isTrash(bestPair){
  const risk = computeRisk(bestPair);
  const dump = computeDumpRisk(bestPair);
  if (dump.dumpRisk === "HIGH") return true;
  if (risk.riskLabel === "HIGH" && risk.riskScore >= 75) return true;
  if (risk.flags.includes("FALLING_KNIFE")) return true;
  if (risk.flags.includes("MANIPULATION_RISK") && risk.riskScore >= 70) return true;
  if (risk.flags.includes("MICRO_LIQUIDITY")) return true;
  return false;
}

async function tokenPairs(address){
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(address)}`;
  const raw = await fetchJson(url, 12000);
  const pairs = (Array.isArray(raw) ? raw : []).map(normalizePair);
  return pairs;
}

async function tokenDetail(address){
  const pairs = await tokenPairs(address);
  const bestPair = pickBestPair(pairs);
  const ident = identFromPair(bestPair, address);
  const risk = computeRisk(bestPair);
  const dump = computeDumpRisk(bestPair);
  const whale = computeWhaleLike(bestPair);
  const smart = computeSmartMoney(bestPair);
  const pot = computePotential(bestPair);

  const warnings = [];
  if (risk.flags.includes("LOW_LIQUIDITY") || risk.flags.includes("VERY_LOW_LIQUIDITY") || risk.flags.includes("MICRO_LIQUIDITY")) warnings.push({ level:"warn", text:"Low liquidity — price can be manipulated easily." });
  if (risk.flags.includes("FALLING_KNIFE")) warnings.push({ level:"danger", text:"Falling knife pattern — high dump risk, avoid catching a falling knife." });
  if (dump.dumpRisk === "HIGH") warnings.push({ level:"danger", text:"High dump risk — strong sell pressure detected." });
  if (risk.flags.includes("MANIPULATION_RISK")) warnings.push({ level:"danger", text:"Manipulation risk — extreme move with weak liquidity." });
  if (risk.flags.includes("ANOMALOUS_FLOW")) warnings.push({ level:"warn", text:"Anomalous flow — unusually one-sided tape (bots/wash possible)." });
  if (warnings.length === 0) warnings.push({ level:"ok", text:"No major red flags detected by heuristics (still DYOR)." });

  return { address, ident, bestPair, risk, dump, whale, smart, potential: pot, pairs: pairs.slice(0, 25), warnings, signalMeta: firstSignal.get(address) || null };
}

// Jupiter token list (verified mints + logos) — used to resolve majors without hardcoding every mint.
const JUP_TOKEN_LIST_URL = "https://token.jup.ag/all";

async function getJupiterTokenList(){
  return await fetchJson(JUP_TOKEN_LIST_URL, 6 * 60 * 60 * 1000); // 6h
}

function pickJupiterToken(list, wantSymbol, wantName){
  const s = String(wantSymbol||"").toUpperCase();
  const n = String(wantName||"").toLowerCase();
  if (!Array.isArray(list) || !s) return null;

  const candidates = list.filter(t => String(t?.symbol||"").toUpperCase() === s);
  if (candidates.length === 0) return null;

  // Prefer verified/strict tokens if tags are present.
  const score = (t) => {
    const tags = Array.isArray(t?.tags) ? t.tags.map(x=>String(x).toLowerCase()) : [];
    const verified = tags.includes("verified") ? 5 : 0;
    const strict = tags.includes("strict") ? 3 : 0;
    const nameMatch = n && String(t?.name||"").toLowerCase() === n ? 4 : 0;
    const hasLogo = t?.logoURI ? 1 : 0;
    return verified + strict + nameMatch + hasLogo;
  };

  const sorted = [...candidates].sort((a,b)=>score(b)-score(a));
  return sorted[0] || null;
}

app.get("/api/health", (req,res)=>res.json({ ok:true }));

app.get("/api/search", async (req,res)=>{
  try{
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error:"Missing q" });
    const url = "https://api.dexscreener.com/latest/dex/search?q=" + encodeURIComponent(q);
    const data = await fetchJson(url, 10000);
    const pairs = (data?.pairs || []).filter(p => p?.chainId === "solana").map(normalizePair);

    const by = new Map();
    for (const p of pairs){
      const addr = p?.baseToken?.address;
      if (!addr) continue;
      const cur = by.get(addr);
      const liq = safeNum(p?.liquidity?.usd);
      const curLiq = safeNum(cur?.liquidity?.usd);
      if (!cur || liq > curLiq) by.set(addr, p);
    }

    const items = [...by.entries()].map(([address, bestPair])=>{
      const ident = identFromPair(bestPair, address);
      const risk = computeRisk(bestPair);
      return { address, ident, bestPair, risk };
    }).slice(0, 60);

    res.json({ q, count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/token/:address", async (req,res)=>{
  try{
    const address = String(req.params.address || "").trim();
    const data = await tokenDetail(address);
    res.json(data);
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

async function seedAddresses(){
  const urls = [
    "https://api.dexscreener.com/token-boosts/top/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
    "https://api.dexscreener.com/token-profiles/latest/v1"
  ];
  const seen = new Set();
  for (const url of urls){
    try{
      const raw = await fetchJson(url, 30000);
      for (const x of (Array.isArray(raw) ? raw : [])){
        if (x?.chainId !== "solana") continue;
        const addr = String(x.tokenAddress || "");
        if (addr) seen.add(addr);
      }
    }catch(_){}
  }
  return [...seen];
}

async function pairsForMany(addresses){
  const by = new Map();
  for (let i = 0; i < addresses.length; i += 30){
    const chunk = addresses.slice(i, i + 30);
    try{
      const raw = await fetchJson("https://api.dexscreener.com/tokens/v1/solana/" + chunk.join(","), 12000);
      for (const p of (Array.isArray(raw) ? raw : [])){
        const addr = p?.baseToken?.address;
        if (!addr) continue;
        if (!by.has(addr)) by.set(addr, []);
        by.get(addr).push(normalizePair(p));
      }
    }catch(_){}
  }
  return by;
}

async function boostedSeed(limit){
  const addresses = (await seedAddresses()).filter(a => !isMcBlacklisted(a)).slice(0, 90);
  const by = await pairsForMany(addresses);
  const out = [];
  for (const addr of addresses){
    const bestPair = pickBestPair(by.get(addr));
    if (!bestPair) continue;
    if (updateMcCrash(addr, bestPair)) continue;
    if (isTrash(bestPair)) continue;
    const risk = computeRisk(bestPair);
    const dump = computeDumpRisk(bestPair);
    const whale = computeWhaleLike(bestPair);
    const smart = computeSmartMoney(bestPair);
    out.push({ address: addr, ident: identFromPair(bestPair, addr), bestPair, risk, dump, whale, smart });
    if (out.length >= limit) break;
  }
  return out;
}

async function mapLimit(arr, limit, fn){
  const ret = [];
  let i = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async ()=>{
    while (i < arr.length){
      const idx = i++;
      try{ ret[idx] = await fn(arr[idx], idx); }
      catch(e){ ret[idx] = null; }
    }
  });
  await Promise.all(workers);
  return ret.filter(Boolean);
}

app.get("/api/list/majors", async (req,res)=>{
  try{
    const majorsPath = path.join(__dirname, "..", "majors.json");
    delete require.cache[require.resolve(majorsPath)];
    const list = require(majorsPath);
    const jupList = await getJupiterTokenList().catch(()=>[]);

    const enriched = await mapLimit(list, 4, async (t)=>{
      // Enforce user rule: no stablecoins / no staked-SOL wrappers in Majors list.
      if (isStableSymbol(t.symbol) || isLSTSymbol(t.symbol)) return null;

      const token = t.address ? null : pickJupiterToken(jupList, t.symbol, t.name);
      const address = String(t.address || token?.address || "").trim();
      if (!address) return null;

      const pairs = await tokenPairs(address);
      const bestPair = pickBestPair(pairs);
      if (!bestPair) return { address, ident:{ address, name:t.name, symbol:t.symbol, logo: token?.logoURI || "" }, bestPair:null, risk:{ riskScore:85, riskLabel:"HIGH", flags:["NO_PAIR_DATA"] } };

      const ident = { address, name: t.name || (bestPair?.baseToken?.name||"Token"), symbol: t.symbol || (bestPair?.baseToken?.symbol||""), logo: bestPair?.info?.imageUrl || token?.logoURI || "" };
      const risk = computeRisk(bestPair);
      const dump = computeDumpRisk(bestPair);
      const pot = computePotential(bestPair);
      return { address, ident, bestPair, risk, dump, potential: pot };
    });

    const items = enriched.filter(Boolean);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/trending_low_risk", async (req,res)=>{
  try{
    const seed = await boostedSeed(28);
    const items = seed
      .filter(x => x?.bestPair && x?.risk?.riskLabel !== "HIGH")
      .map(x => ({ ...x, trend: safeNum(x.bestPair?.priceChange?.h1) }))
      .sort((a,b)=> (a.risk.riskScore - b.risk.riskScore) || (b.trend - a.trend))
      .slice(0, 30);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/top_volume", async (req,res)=>{
  try{
    const seed = await boostedSeed(36);
    const items = seed
      .map(x => ({ ...x, vol24: safeNum(x.bestPair?.volume?.h24) }))
      .sort((a,b)=> b.vol24 - a.vol24)
      .slice(0, 30);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/high_liquidity", async (req,res)=>{
  try{
    const seed = await boostedSeed(36);
    const items = seed
      .map(x => ({ ...x, liq: safeNum(x.bestPair?.liquidity?.usd) }))
      .sort((a,b)=> b.liq - a.liq)
      .slice(0, 30);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/whale_alert", async (req,res)=>{
  try{
    const seed = await boostedSeed(40);
    const items = seed
      .map(x => ({ ...x, whaleScore: x.whale?.whaleScore || 0 }))
      .filter(x => x.whaleScore >= 45 && x.risk.riskLabel !== "HIGH")
      .sort((a,b)=> (b.whaleScore - a.whaleScore))
      .slice(0, 30)
      .map(withSignalMeta);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/smart_money", async (req,res)=>{
  try{
    const seed = await boostedSeed(42);
    const nowTs = now();

    const withStreak = seed
      .filter(x => !isMcBlacklisted(x.address))
      .map(x => {
        const smartScore = x.smart?.smartScore || 0;
        const key = String(x.address||"");
        const prev = smartSeen.get(key);
        let streak = 0;
        // Consider it a "valid tick" only if it clears basic quality.
        const valid = smartScore >= 55 && x.risk.riskLabel !== "HIGH" && (x.dump?.dumpRisk||"LOW") !== "HIGH" && !x.risk.flags.includes("FALLING_KNIFE");
        if (valid){
          if (prev && (nowTs - prev.ts) < 120000 && prev.lastScore >= 55) streak = Math.min(5, (prev.streak || 1) + 1);
          else streak = 1;
          smartSeen.set(key, { streak, lastScore: smartScore, ts: nowTs });
        }else{
          if (prev && (nowTs - prev.ts) < 120000) streak = prev.streak || 0;
        }
        return { ...x, smartScore, smartStreak: streak };
      });

    const items = withStreak
      .filter(x => x.risk.riskLabel !== "HIGH")
      // Stability gate: show immediately if very strong; otherwise require 2 ticks.
      .filter(x => (x.smartScore >= 70) || (x.smartScore >= 55 && x.smartStreak >= 2))
      .sort((a,b)=> (b.smartScore + (b.smartStreak>=2?6:0)) - (a.smartScore + (a.smartStreak>=2?6:0)))
      .slice(0, 30)
      .map(withSignalMeta);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/hot_buys", async (req,res)=>{
  try{
    const seed = await boostedSeed(42);
    const items = seed
    .filter(x => !isMcBlacklisted(x.address))
    .map(x=>{
      // "Hot" = buyers dominate right now (last 5m) and the last hour agrees.
      const f = flowOf(x.bestPair);
      const total = f.t5;
      const buyRatio = f.r5;
      const dump = x.dump || computeDumpRisk(x.bestPair);
      const c = changesOf(x.bestPair);
      const controlled = (Math.abs(c.m5) <= 18 && Math.abs(c.h1) <= 45);

      // Base: activity + buy dominance
      let score = total * 2 + (buyRatio*100) + Math.min(f.t1, 300) / 10;
      if (f.r1 < 0.5) score -= 15;

      // Bonus: smart money intersection
      const smartScore = x.smart?.smartScore || 0;
      if (smartScore >= 55) score += 18;
      else if (smartScore >= 40) score += 8;

      // Penalties: avoid pump/dump & migration dumps
      if (!controlled) score -= 14;
      if (dump.dumpRisk === "MED") score -= 10;
      if (dump.dumpRisk === "HIGH") score -= 40;
      if (x.risk.flags.includes("FALLING_KNIFE")) score -= 40;

      return { ...x, hotScore: score, buyRatio, totalTx: total, dump };
    })
    .filter(x => x.totalTx >= 16 && x.buyRatio >= 0.62)
    .filter(x => x.risk.riskLabel !== "HIGH")
    .filter(x => (x.dump?.dumpRisk || "LOW") !== "HIGH")
    .filter(x => !x.risk.flags.includes("FALLING_KNIFE"))
    .sort((a,b)=> b.hotScore - a.hotScore)
    .slice(0, 30)
      .map(withSignalMeta);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/risky", async (req,res)=>{
  try{
    const seed = await boostedSeed(42);
    const items = seed
      .filter(x => x.risk.riskLabel === "HIGH" && !x.risk.flags.includes("MICRO_LIQUIDITY"))
      .filter(x => (x.dump?.dumpRisk || "LOW") !== "HIGH")
      .filter(x => !x.risk.flags.includes("FALLING_KNIFE"))
      .sort((a,b)=> b.risk.riskScore - a.risk.riskScore)
      .slice(0, 30);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/list/uptrend_signal", async (req,res)=>{
  try{
    const potential = String(req.query.potential || "MED");
    const seed = await boostedSeed(55);

    const items = seed.map(x=>{
      const pot = computePotential(x.bestPair);
      return { ...x, potential: pot };
    })
    .filter(x => x?.bestPair && !isTrash(x.bestPair))
    .filter(x => x.risk.riskLabel !== "HIGH")
    // Stronger quality gates: avoid pump-to-dex dump patterns, manipulation risk, and ultra-thin liquidity.
    .filter(x => {
      const liq = safeNum(x.bestPair?.liquidity?.usd);
      const flags = x.risk?.flags || [];
      const dumpRisk = x.dump?.dumpRisk || computeDumpRisk(x.bestPair).dumpRisk;

      // Hard vetoes
      if (dumpRisk === "HIGH") return false;
      if (flags.includes("MICRO_LIQUIDITY")) return false;
      if (flags.includes("MANIPULATION_RISK")) return false;

      // Potential-tier-specific gates
      if (potential === "HIGH"){
        if (x.potential.potential !== "HIGH") return false;
        if (x.risk.riskLabel !== "LOW") return false;
        if (dumpRisk !== "LOW") return false;
        if (flags.includes("VERY_LOW_LIQUIDITY") || flags.includes("LOW_LIQUIDITY")) return false;
        if (flags.includes("ANOMALOUS_FLOW") || flags.includes("FALLING_KNIFE")) return false;
        if (liq < 2500) return false;
        return true;
      }
      if (potential === "MED"){
        if (!(x.potential.potential === "MED" || x.potential.potential === "HIGH")) return false;
        if (x.risk.riskScore > 55) return false;
        if (flags.includes("FALLING_KNIFE")) return false;
        if (liq < 1800) return false;
        return true;
      }
      // LOW potential: keep very strict to avoid rugs; it's ok if list is short.
      if (potential === "LOW"){
        if (x.risk.riskScore > 65) return false;
        if (dumpRisk !== "LOW") return false;
        if (flags.includes("VERY_LOW_LIQUIDITY") || flags.includes("LOW_LIQUIDITY")) return false;
        if (liq < 2200) return false;
        return true;
      }
      return true;
    })
    .map(x => ({ ...x, showBuy: Boolean(x.potential.buy), buyWhy: x.potential.buyWhy }))
    .sort((a,b)=>{
      const pRank = (p)=> p==="HIGH"?3:p==="MED"?2:1;
      const d = pRank(b.potential.potential) - pRank(a.potential.potential);
      if (d !== 0) return d;
      const r = a.risk.riskScore - b.risk.riskScore;
      if (r !== 0) return r;
      return safeNum(b.bestPair?.priceChange?.h1) - safeNum(a.bestPair?.priceChange?.h1);
    })
    .slice(0, 30)
      .map(withSignalMeta);

    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});


app.get("/api/list/boosted", async (req,res)=>{
  try{
    const seed = await boostedSeed(40);
    // boostedSeed already comes from DexScreener boosts; keep order by liquidity then volume as best-pair,
    // but we can roughly prefer higher liquidity as "quality boosted".
    const items = seed
      .map(x => ({...x, liq: safeNum(x.bestPair?.liquidity?.usd), vol24: safeNum(x.bestPair?.volume?.h24)}))
      .sort((a,b)=> (b.liq - a.liq) || (b.vol24 - a.vol24))
      .slice(0, 30);
    res.json({ count: items.length, items });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
});


const publicDir = path.join(__dirname, "..", "public");
app.use("/", express.static(publicDir));
app.get("*", (req,res)=>res.sendFile(path.join(publicDir, "index.html")));

module.exports = app;
