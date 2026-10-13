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

// Saves each check on the student's account (latest 12 kept; sent ideas are never removed).
function addCheck(user, meta, data) {
  const rec = { id: rid(8), userId: user.id, ...meta, at: Date.now(), data };
  state.checks.push(rec);
  backend.put("checks", rec);
  const mine = state.checks.filter((c) => c.userId === user.id).sort((a, b) => b.at - a.at);
  for (const old of mine.slice(12)) {
    if (state.subs.some((x) => x.checkId === old.id)) continue;
    state.checks = state.checks.filter((c) => c.id !== old.id);
    backend.del("checks", old.id);
  }
  return rec.id;
}

// ---------- Storage: a file by default, Firebase Firestore when FIREBASE_SERVICE_ACCOUNT is set ----------
const DATA_DIR = process.env.DATA_DIR || path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(DATA_DIR, "data.json");
const state = { users: [], checks: [], subs: [] };
let storageMode = "file";
let backend;
const rid = (n = 8) => crypto.randomBytes(n).toString("hex");

function fileBackend() {
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); } catch (e) { console.log("Could not save data:", e.message); }
    }, 300);
  };
  return {
    async load() { try { Object.assign(state, JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); } catch (e) { /* first run */ } },
    put: later,
    del: later,
  };
}

async function firebaseBackend() {
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw && process.env.FIREBASE_SERVICE_ACCOUNT_FILE) raw = fs.readFileSync(path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_FILE), "utf8");
  const account = JSON.parse(raw);
  const db = getFirestore(initializeApp({ credential: cert(account) }));
  const pack = (c, doc) => {
    const d = JSON.parse(JSON.stringify(doc));
    if (c !== "users") d.data = JSON.stringify(d.data ?? null); // report kept as text, so Firestore never rejects its shape
    return d;
  };
  const warn = (e) => console.log("Firebase save failed:", e.message);
  return {
    project: account.project_id,
    async load() {
      for (const c of ["users", "checks", "subs"]) {
        const snap = await db.collection(c).get();
        state[c] = snap.docs.map((d) => {
          const x = d.data();
          if (c !== "users" && typeof x.data === "string") x.data = JSON.parse(x.data);
          return x;
        });
      }
    },
    put(c, doc) { db.collection(c).doc(doc.id).set(pack(c, doc)).catch(warn); },
    del(c, id) { db.collection(c).doc(id).delete().catch(warn); },
  };
}

async function initStorage() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    try {
      backend = await firebaseBackend();
      await Promise.race([
        backend.load(),
        new Promise((_, no) => setTimeout(() => no(new Error("Firebase did not answer within 20 seconds.")), 20000)),
      ]);
      storageMode = "firebase";
      console.log("Storage: Firebase Firestore (project " + backend.project + "). Loaded " + state.users.length + " users, " + state.checks.length + " checks, " + state.subs.length + " sent ideas.");
      return;
    } catch (e) {
      let hint = "";
      if (/NOT_FOUND|5 NOT_FOUND/.test(e.message)) hint = "\nHint: open the Firebase console, go to Build > Firestore Database, and click Create database.";
      else if (/PERMISSION_DENIED|7 PERMISSION/.test(e.message)) hint = "\nHint: the key does not have access. Create a new private key for this project.";
      else if (/JSON|Unexpected token|private_key|credential/i.test(e.message)) hint = "\nHint: the service account key looks wrong. Paste the whole JSON file again.";
      console.log("Firebase did not start:", e.message + hint + "\nUsing temporary file storage instead.");
      state.users = []; state.checks = []; state.subs = [];
    }
  }
  backend = fileBackend();
  await backend.load();
  console.log("Storage: file " + DATA_FILE + (LIMITS_ON ? " (this is wiped on restart on most free hosts)" : ""));
}

// ---------- Helpers ----------
const clean = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const tally = new Map();
function tooMany(bucket, key, max) {
  const now = Date.now(), recent = (tally.get(bucket + key) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= max) { tally.set(bucket + key, recent); return true; }
  recent.push(now); tally.set(bucket + key, recent);
  return false;
}
const fails = new Map();
const recentFails = (k) => { const now = Date.now(), a = (fails.get(k) || []).filter((t) => now - t < 3600e3); fails.set(k, a); return a; };

// ---------- Passwords and login sessions ----------
const TEACHER_CODE = process.env.TEACHER_CODE; // teachers need this code to create their account
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.log("Tip: set SESSION_SECRET in .env so people stay logged in after a restart.");
const scryptAsync = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? no(e) : ok(k))));
async function hashPw(pw) { const salt = rid(16); return salt + "." + (await scryptAsync(pw, salt)).toString("hex"); }
async function checkPw(pw, stored) {
  const [salt, hash] = String(stored || "").split(".");
  if (!salt || !hash) { await scryptAsync(pw, "00"); return false; } // same work for unknown emails
  const k = await scryptAsync(pw, salt), h = Buffer.from(hash, "hex");
  return h.length === k.length && crypto.timingSafeEqual(h, k);
}
const mac = (b) => crypto.createHmac("sha256", SESSION_SECRET).update(b).digest("base64url");
const sign = (p) => { const b = Buffer.from(JSON.stringify(p)).toString("base64url"); return b + "." + mac(b); };
function verify(tok) {
  const [b, m] = String(tok || "").split(".");
  if (!b || !m) return null;
  const want = mac(b);
  if (m.length !== want.length || !crypto.timingSafeEqual(Buffer.from(m), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(b, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
const readCookie = (req, name) => {
  const c = (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(name + "="));
  return c ? decodeURIComponent(c.slice(name.length + 1)) : "";
};
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, roll: u.roll || "", batch: u.batch || "" });
const startSession = (req, res, u) =>
  res.cookie("ifx_s", sign({ uid: u.id, exp: Date.now() + 7 * 864e5 }), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 7 * 864e5, path: "/" });

// Changing data needs a JSON request. Other websites cannot send those to us, which blocks forged form posts.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.path.startsWith("/api/") && !/application\/json/i.test(req.get("content-type") || "")) {
    return res.status(415).json({ error: "Unsupported request." });
  }
  next();
});
app.use((req, res, next) => {
  const p = verify(readCookie(req, "ifx_s"));
  req.user = p ? state.users.find((u) => u.id === p.uid) || null : null;
  next();
});
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Please log in first." }));
const needStudent = (req, res, next) => (!req.user ? res.status(401).json({ error: "Please log in first." }) : req.user.role !== "student" ? res.status(403).json({ error: "Only students can send ideas to a teacher." }) : next());
const needTeacher = (req, res, next) => (!req.user ? res.status(401).json({ error: "Please log in first." }) : req.user.role !== "teacher" ? res.status(403).json({ error: "Teachers only." }) : next());

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/;

app.post("/api/auth/register", async (req, res) => {
  try {
    if (tooMany("reg", req.ip, 30)) return res.status(429).json({ error: "Too many sign-ups from this connection. Try again later." });
    const b = req.body || {};
    const role = b.role === "teacher" ? "teacher" : "student";
    const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase(), pw = String(b.password || "");
    const roll = clean(b.roll, 40), batch = clean(b.batch, 60);
    if (!name) return res.status(400).json({ error: "Enter your name." });
    if (!EMAIL.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (pw.length < 8 || pw.length > 128) return res.status(400).json({ error: "Password must be 8 to 128 characters." });
    if (state.users.some((u) => u.email === email)) return res.status(409).json({ error: "An account with this email already exists. Try logging in." });
    if (role === "teacher") {
      if (!TEACHER_CODE) return res.status(403).json({ error: "Teacher sign-up is turned off. Ask the person who runs this site." });
      if (tooMany("invite", req.ip, 8)) return res.status(429).json({ error: "Too many tries. Please wait an hour." });
      if (!safeEq(b.inviteCode || "", TEACHER_CODE)) return res.status(403).json({ error: "Wrong teacher code." });
    } else {
      if (!roll) return res.status(400).json({ error: "Enter your roll number." });
      if (state.users.some((u) => u.role === "student" && (u.roll || "").toLowerCase() === roll.toLowerCase() && (u.batch || "").toLowerCase() === batch.toLowerCase())) {
        return res.status(409).json({ error: "That roll number is already registered in this batch. Try logging in." });
      }
    }
    const u = { id: rid(8), role, name, email, roll: role === "student" ? roll : "", batch: role === "student" ? batch : "", pw: await hashPw(pw), at: Date.now() };
    state.users.push(u);
    backend.put("users", u);
    startSession(req, res, u);
    res.json({ user: publicUser(u), next: role === "teacher" ? "/teacher" : "/" });
  } catch (e) {
    res.status(500).json({ error: "Could not create the account. Please try again." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = clean(req.body?.email, 120).toLowerCase(), pw = String(req.body?.password || "").slice(0, 128);
    if (recentFails("e" + email).length >= 8 || recentFails("i" + req.ip).length >= 40) {
      return res.status(429).json({ error: "Too many wrong tries. Please wait an hour and try again." });
    }
    const u = state.users.find((x) => x.email === email);
    const ok = await checkPw(pw, u?.pw);
    if (!u || !ok) {
      recentFails("e" + email).push(Date.now());
      recentFails("i" + req.ip).push(Date.now());
      return res.status(401).json({ error: "Wrong email or password." });
    }
    fails.delete("e" + email);
    startSession(req, res, u);
    res.json({ user: publicUser(u), next: u.role === "teacher" ? "/teacher" : "/" });
  } catch (e) {
    res.status(500).json({ error: "Could not log in. Please try again." });
  }
});

app.post("/api/auth/logout", (req, res) => { res.clearCookie("ifx_s", { path: "/" }); res.json({ ok: true }); });
app.get("/api/me", (req, res) => res.json({ user: req.user ? publicUser(req.user) : null, storage: storageMode, online: LIMITS_ON }));
app.get("/login", (req, res) => res.sendFile(path.join(PUBLIC, "login.html")));

app.post("/api/analyze", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Please log in to check your idea." });
    const { idea, level = "final-year student", time = "4 months", budget = "", currency = "INR", tech = "" } = req.body;
    if (!idea || idea.length < 8) return res.status(400).json({ error: "Describe your idea first." });
    if (!GEMINI) return res.status(500).json({ error: "Set GEMINI_API_KEY in .env" });

    const key = keyOf({ idea: idea.trim().replace(/\s+/g, " "), level, time, budget, currency, tech, DROP_AT, BUILD_AT });
    const hit = cache[key];
    if (hit && !req.body.fresh && Date.now() - hit.at < 7 * 864e5) return res.json({ ...hit.data, cached: true, checkId: addCheck(req.user, { idea, tech, level, time, budget, currency }, hit.data) });

    if (LIMITS_ON) {
      const why = limitReached(req.user.id);
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
    res.json({ ...result, checkId: addCheck(req.user, { idea, tech, level, time, budget, currency }, result) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Student: my checks and sending to a teacher ----------
const submissionOf = (checkId) => state.subs.find((x) => x.checkId === checkId);
const subInfo = (x) => (x ? { status: x.status, comment: x.comment } : null);

app.get("/api/my/checks", needUser, (req, res) => {
  res.json(state.checks.filter((c) => c.userId === req.user.id).sort((a, b) => b.at - a.at).map((c) => ({
    id: c.id, idea: c.idea, at: c.at, originality: c.data?.originality, verdict: c.data?.verdict, submission: subInfo(submissionOf(c.id)),
  })));
});

app.get("/api/my/checks/:id", needUser, (req, res) => {
  const c = state.checks.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!c) return res.status(404).json({ error: "Not found." });
  res.json({ id: c.id, idea: c.idea, tech: c.tech || "", level: c.level, time: c.time, budget: c.budget || "", cur: c.currency || "INR", at: c.at, r: c.data, submission: subInfo(submissionOf(c.id)) });
});

app.delete("/api/my/checks", needUser, (req, res) => {
  const gone = state.checks.filter((c) => c.userId === req.user.id && !submissionOf(c.id));
  state.checks = state.checks.filter((c) => !gone.includes(c));
  gone.forEach((c) => backend.del("checks", c.id));
  res.json({ removed: gone.length });
});

app.post("/api/submit", needStudent, (req, res) => {
  const c = state.checks.find((x) => x.id === String(req.body?.checkId || "") && x.userId === req.user.id);
  if (!c) return res.status(404).json({ error: "We could not find that check. Check your idea again, then send it." });
  const already = submissionOf(c.id);
  if (already) return res.json({ submission: subInfo(already) });
  if (tooMany("submit", req.user.id, 20)) return res.status(429).json({ error: "Too many submissions. Try again in an hour." });
  if (state.subs.length >= 5000) return res.status(507).json({ error: "The teacher's list is full." });
  const u = req.user, d = c.data || {};
  const sub = {
    id: rid(6), checkId: c.id, userId: u.id, name: u.name, email: u.email, roll: u.roll, batch: u.batch,
    idea: c.idea, tech: c.tech || "", level: c.level, time: c.time, at: Date.now(),
    originality: d.originality, verdict: d.verdict, difficulty: d.difficulty,
    status: "Pending", comment: "", data: d,
  };
  state.subs.push(sub);
  backend.put("subs", sub);
  res.json({ submission: subInfo(sub) });
});

// ---------- Teacher ----------
const STOP = new Set("and the for with using use from that this are its into app system project based tool web build make new via".split(" "));
const words = (t) => new Set(String(t || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)));
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}
// Ideas in the same batch that share many words. A pointer for the teacher, not proof.
function similarFor(list) {
  const toks = list.map((s) => words(s.idea));
  return list.map((s, i) => {
    const found = [];
    list.forEach((o, j) => {
      if (i === j || (o.batch || "").toLowerCase() !== (s.batch || "").toLowerCase() || o.userId === s.userId) return;
      const p = overlap(toks[i], toks[j]);
      if (p >= 0.35) found.push({ id: o.id, name: o.name, roll: o.roll, idea: o.idea, pct: Math.round(p * 100) });
    });
    return found.sort((x, y) => y.pct - x.pct).slice(0, 3);
  });
}

app.get("/teacher", (req, res) => {
  if (!req.user) return res.redirect("/login?next=/teacher");
  if (req.user.role !== "teacher") return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "teacher.html"));
});

app.get("/api/teacher/submissions", needTeacher, (req, res) => {
  const sim = similarFor(state.subs);
  res.json(state.subs.map((s, i) => ({
    id: s.id, name: s.name, email: s.email, roll: s.roll, batch: s.batch, idea: s.idea, tech: s.tech, at: s.at,
    originality: s.originality, verdict: s.verdict, difficulty: s.difficulty, status: s.status, comment: s.comment, by: s.by || "", similar: sim[i],
  })).reverse());
});

app.get("/api/teacher/submissions/:id", needTeacher, (req, res) => {
  const i = state.subs.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Not found." });
  res.json({ ...state.subs[i], similar: similarFor(state.subs)[i] });
});

app.patch("/api/teacher/submissions/:id", needTeacher, (req, res) => {
  const s = state.subs.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Not found." });
  const status = String(req.body?.status || "");
  if (!["Pending", "Approved", "Needs change", "Rejected"].includes(status)) return res.status(400).json({ error: "Pick a decision." });
  s.status = status;
  s.comment = clean(req.body?.comment, 500);
  s.by = req.user.name;
  s.decidedAt = Date.now();
  backend.put("subs", s);
  res.json({ ok: true });
});

app.delete("/api/teacher/submissions/:id", needTeacher, (req, res) => {
  const s = state.subs.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Not found." });
  state.subs = state.subs.filter((x) => x !== s);
  backend.del("subs", s.id);
  res.json({ ok: true });
});

await initStorage();
app.listen(process.env.PORT || 3000, () => console.log("IdeaForge-X on http://localhost:" + (process.env.PORT || 3000)));