import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(PUBLIC));
app.get("/", (req, res) => {
  const file = path.join(PUBLIC, "index.html");
  if (!fs.existsSync(file)) {
    return res.status(500).send("index.html was not found. Put it inside this folder: " + PUBLIC);
  }
  res.sendFile(file);
});

// Same idea + same settings = same saved result for 7 days (steady answers, saves your free Gemini limit).
const CACHE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "cache.json");
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch (e) { cache = {}; }
const keyOf = (o) => crypto.createHash("sha1").update(JSON.stringify(o).toLowerCase()).digest("hex");

// Verdict cut-offs on the originality score. Change them in .env if you want a stricter or softer tool.
const DROP_AT = Number(process.env.DROP_AT) || 15;
const BUILD_AT = Number(process.env.BUILD_AT) || 40;

// Limits protect your free Gemini quota once the site is public. They switch on by themselves on Render.
app.set("trust proxy", 1);
const LIMITS_ON = !!process.env.RENDER || process.env.NODE_ENV === "production" || process.env.RATE_LIMIT === "on";
const RATE_PER_HOUR = Number(process.env.RATE_PER_HOUR) || 8;
const DAILY_CAP = Number(process.env.DAILY_CAP) || 150;
const hits = new Map();
let dayKey = "", dayCount = 0;
function limitReached(ip) {
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  if (day !== dayKey) { dayKey = day; dayCount = 0; }
  if (dayCount >= DAILY_CAP) return "day";
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= RATE_PER_HOUR) { hits.set(ip, recent); return "hour"; }
  recent.push(now); hits.set(ip, recent); dayCount++;
  return null;
}

const GEMINI = process.env.GEMINI_API_KEY;
const MODELS = [
  process.env.GEMINI_MODEL,
  ...(process.env.GEMINI_FALLBACKS || "").split(","),
  "gemini-3.8-flash",
  "gemini-3.8-flash-lite",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
]
  .map((m) => (m || "").trim())
  .filter((m, i, all) => m && all.indexOf(m) === i);
let working = null;

async function callModel(model, prompt, opts = {}) {
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: opts.temperature ?? 0.3 } };
  if (opts.search) body.tools = [{ google_search: {} }];
  else body.generationConfig.responseMimeType = "application/json"; // JSON mode cannot be combined with search
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!r.ok) {
    const err = new Error("Gemini error " + r.status + " (model " + model + "): " + (await r.text()).slice(0, 200));
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  const cand = j.candidates[0];
  const text = (cand.content.parts || []).map((p) => p.text || "").join("");
  if (opts.search) {
    const sources = (cand.groundingMetadata?.groundingChunks || [])
      .map((c) => c.web)
      .filter((w) => w && w.uri)
      .map((w) => ({ title: w.title || "Source", url: w.uri }));
    return { text, sources };
  }
  return JSON.parse(text);
}

async function gemini(prompt, opts = {}) {
  const order = working ? [working, ...MODELS.filter((m) => m !== working)] : MODELS;
  let last;
  for (const m of order) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const out = await callModel(m, prompt, opts);
        working = m;
        return out;
      } catch (e) {
        last = e;
        const quota = e.status === 429 && /quota/i.test(e.message);
        if ((e.status === 503 || (e.status === 429 && !quota)) && attempt < 3) {
          await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
    if (![404, 400, 503, 429].includes(last.status)) throw last; // try the next model
  }
  working = null;
  throw last;
}

const REGION = { INR: "India", USD: "the United States", GBP: "the United Kingdom" };

// Looks up current prices on the web (Google Search through Gemini) and corrects the budget.
async function verifyBudget(report, currency) {
  const items = (report.budget?.items || []).filter((i) => Number(i.cost) > 0);
  if (!items.length) return { ...report, budget_check: "all_free" };
  const today = new Date().toISOString().slice(0, 10);
  const region = REGION[currency] || "India";
  const list = items.map((i) => "- " + i.item).join("\n");
  const found = await gemini(
    `Today is ${today}. Search the web for the CURRENT price in ${currency} (for buyers in ${region}) of each item below. Prefer official pricing pages and major local shops. For each item write one line: item, current price, where you found it. If you cannot find a price, say "not found". Do not guess.\n${list}`,
    { search: true, temperature: 0.1 }
  );
  const revised = await gemini(
    `Today is ${today}. Here is an estimated project budget in ${currency}: ${JSON.stringify(report.budget)}
Here are prices looked up on the web: ${found.text}
Update the budget using ONLY the looked-up prices where they exist. For items with a found price set "verified": true and use that price; for items "not found" keep the estimate with "verified": false. Recompute min and max. Keep the same JSON shape: {"min":number,"max":number,"items":[{"item":str,"cost":number,"note":str,"verified":true|false}],"free_option":str,"fits_budget":true|false|null,"advice":str}. Return only JSON.`
  );
  const seen = new Set();
  const sources = found.sources.filter((s) => !seen.has(s.url) && seen.add(s.url)).slice(0, 6);
  return { ...report, budget: revised, price_sources: sources, price_date: today, budget_check: sources.length ? "verified" : "unsourced" };
}

const safe = (p) => p.catch(() => null);

async function searchArxiv(q) {
  const r = await fetch(
    `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=5&sortBy=relevance`
  );
  const xml = await r.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
    title: (m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").replace(/\s+/g, " ").trim(),
    url: m[1].match(/<id>(.*?)<\/id>/)?.[1],
    year: m[1].match(/<published>(\d{4})/)?.[1],
  }));
}

async function searchScholar(q) {
  const r = await fetch(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=5&fields=title,year,url,citationCount`
  );
  if (!r.ok) return [];
  return (await r.json()).data || [];
}

async function searchGithub(q) {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=5`,
    { headers }
  );
  if (!r.ok) {
    console.log("GitHub search failed:", r.status, (await r.text()).slice(0, 150));
    return null;
  }
  const j = await r.json();
  return {
    total: j.total_count,
    items: j.items.map((i) => ({ name: i.full_name, url: i.html_url, stars: i.stargazers_count, desc: i.description })),
  };
}

app.post("/api/analyze", async (req, res) => {
  try {
    const { idea, level = "final-year student", time = "4 months", budget = "", currency = "INR", tech = "" } = req.body;
    if (!idea || idea.length < 8) return res.status(400).json({ error: "Describe your idea first." });
    if (!GEMINI) return res.status(500).json({ error: "Set GEMINI_API_KEY in .env" });

    const key = keyOf({ idea: idea.trim().replace(/\s+/g, " "), level, time, budget, currency, tech, DROP_AT, BUILD_AT });
    const hit = cache[key];
    if (hit && !req.body.fresh && Date.now() - hit.at < 7 * 864e5) return res.json({ ...hit.data, cached: true });

    if (LIMITS_ON) {
      const why = limitReached(req.ip);
      if (why === "hour") return res.status(429).json({ error: "Too many checks from this connection. Please try again in an hour." });
      if (why === "day") return res.status(429).json({ error: "This site reached its daily limit of checks. Please try again tomorrow." });
    }

    // 1. Turn the idea into search queries
    const { queries } = await gemini(
      `Write exactly 3 short search queries (2-5 words each) to find existing projects and papers similar to this student project idea.
Query 1: the core idea alone. Query 2: the specific twist alone (a user group, language, constraint, hardware or privacy method); if there is no twist, use a different wording of the core idea. Query 3: the core idea and the twist together.
Return JSON {"queries":["...","...","..."]}. Idea: ${idea}`,
      { temperature: 0 }
    );

    // 2. Look for real evidence
    const results = await Promise.all(
      queries.slice(0, 3).map(async (q) => ({
        q,
        arxiv: await safe(searchArxiv(q)),
        scholar: await safe(searchScholar(q)),
        github: await safe(searchGithub(q)),
      }))
    );
    const evidence = {
      githubWorked: results.some((r) => r.github),
      githubTotalRepos: Math.max(0, ...results.map((r) => r.github?.total || 0)),
      repos: results.flatMap((r) => r.github?.items || []).slice(0, 8),
      papers: [...results.flatMap((r) => r.scholar || []), ...results.flatMap((r) => r.arxiv || [])].slice(0, 10),
    };

    // 3. Judge using the evidence
    const report = await gemini(
      `You are IdeaForge-X, a blunt decision tool for student projects. Do not flatter.
Student: ${level}, time: ${time}. Idea: ${idea}
Student budget: ${budget ? budget : "not given"}. Show all money amounts in ${currency}.
Technologies the student plans to use: ${tech ? tech : "not given"}. If given, build the tech_stack around them and say in "why" when one is a poor fit.
Evidence found (real search results): ${JSON.stringify(evidence)}
If githubWorked is true, many matching repos => low originality. If githubWorked is false, the GitHub search failed: do NOT claim anything about GitHub repo counts, and say your score is based on papers and general knowledge. Do not invent names or URLs.
Scoring guide for originality (0-100):
0-15: a standard student project with many near-identical existing projects.
16-35: a common idea whose small twist already appears in the evidence.
36-55: a common idea with a specific twist (a user group, language, constraint, hardware or privacy method) that the evidence does NOT show.
56-75: an uncommon combination of ideas.
76-100: rare.
First find the student's specific twist, if any, then look for that twist in the evidence. Do not score only the general topic. Do not lower the score just because the topic is popular if the twist is missing from the evidence.
Verdict rule: DON'T BUILD if originality is ${DROP_AT} or lower; BUILD if originality is ${BUILD_AT} or higher; otherwise CHANGE IT. Write verdict_reason so it agrees with this rule.
Return JSON: {"verdict":"BUILD"|"CHANGE IT"|"DON'T BUILD","verdict_reason":str,
"originality":0-100,"future_scope":0-100,"company_interest":0-100,"research_value":0-100,"difficulty":"Easy"|"Medium"|"Hard",
"weaknesses":[str],"mutations":[{"title":str,"change":str,"new_originality":0-100,"difficulty":str}] (exactly 3),
"comparison":[{"existing":str (copy a paper title or repo name EXACTLY from the evidence),"what_it_does":str (under 15 words),"overlap":str (what the student's idea shares with it, under 15 words),"gap":str (what the student's idea is missing or does worse, under 15 words)}] (3 to 5 rows, ONLY from the evidence list, never invent projects; empty array if there is no evidence),
"uniqueness":[{"part":str (e.g. users, data, model, feature, hardware),"common":str (what most similar projects do, under 12 words),"unique":str (a concrete way to differ, under 15 words),"effort":"Low"|"Medium"|"High"}] (4 to 5 rows),
"tech_stack":[{"layer":str,"tool":str,"why":str (under 12 words),"free":true|false}] (4 to 7 items covering frontend, backend, data/AI, hosting, hardware if needed; prefer free and student-friendly tools),
"budget":{"min":number,"max":number,"items":[{"item":str,"cost":number,"note":str}],"free_option":str,"fits_budget":true|false|null,"advice":str}}
Budget rules: these are rough estimates for building one student project in ${currency}; use realistic typical prices, include hardware, cloud, domain and API costs, say 0 for free tiers, set fits_budget to null if the student gave no budget. Also add to each mutation an "extra_cost" string like "Adds about 1,500 ${currency}" or "No extra cost".`,
      { temperature: 0 }
    );

    // Make the verdict follow the score, so the same score always gives the same verdict.
    const o = Math.max(0, Math.min(100, Math.round(Number(report.originality) || 0)));
    report.originality = o;
    report.verdict = o <= DROP_AT ? "DON'T BUILD" : o >= BUILD_AT ? "BUILD" : "CHANGE IT";

    let finalReport = report;
    try {
      finalReport = process.env.PRICE_CHECK === "off" ? { ...report, budget_check: "off" } : await verifyBudget(report, currency);
    } catch (e) {
      console.log("Price check failed:", e.message);
      finalReport = { ...report, budget_check: "failed" };
    }

    const result = { ...finalReport, evidence, queries };
    // Only save complete results, so a failed GitHub or price lookup is never repeated.
    if (evidence.githubWorked && ["verified", "all_free", "off"].includes(finalReport.budget_check)) {
      cache[key] = { at: Date.now(), data: result };
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch (e) {}
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("IdeaForge-X on http://localhost:" + (process.env.PORT || 3000)));
