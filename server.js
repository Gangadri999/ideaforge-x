import "dotenv/config";
import express from "express";

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; form-action 'self' https://api.razorpay.com https://checkout.razorpay.com; base-uri 'self'; frame-ancestors 'none'",
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ verify: (req,res,buf) => { if(req.path==="/api/billing/webhook") req.rawBody=Buffer.from(buf); } }));
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { parseRoster, cosineSimilarity, fallbackRoadmap, csvCell } from "./lib/product.js";
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
function limitReached(ip, hourlyLimit = RATE_PER_HOUR, paid = false) {
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  if (day !== dayKey) { dayKey = day; dayCount = 0; }
  if (!paid && dayCount >= DAILY_CAP) return "day";
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= hourlyLimit) { hits.set(ip, recent); return "hour"; }
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("A connected service timed out. Please try again in a moment.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callModel(model, prompt, opts = {}) {
  const generationConfig = {};
  // Gemini 3.x uses its default sampling behavior; avoid unsupported legacy knobs.
  if (!/^gemini-3\./.test(model)) generationConfig.temperature = opts.temperature ?? 0.3;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig };
  if (opts.search) body.tools = [{ google_search: {} }];
  else body.generationConfig.responseMimeType = "application/json"; // JSON mode cannot be combined with search
  let r;
  try {
    r = await fetchWithTimeout(
      `${process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com"}/v1beta/models/${model}:generateContent?key=${GEMINI}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      opts.timeoutMs || 25000
    );
  } catch (error) {
    if (/timed out/i.test(error.message || "")) {
      throw new Error(`Gemini request timed out while using ${model}. Your key may be active, but this computer or network did not receive a response from Google in time.`);
    }
    if (/fetch failed|networkerror/i.test(error.message || "")) {
      throw new Error(`Could not connect to Gemini while using ${model}. Check this computer's internet connection, VPN, firewall, or network restrictions.`);
    }
    throw error;
  }
  if (!r.ok) {
    const err = new Error("Gemini error " + r.status + " (model " + model + "): " + (await r.text()).slice(0, 200));
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  const cand = j.candidates?.[0];
  if (!cand?.content?.parts) throw new Error("Gemini returned no text. Check the API key, model access and quota, then try again.");
  const text = (cand.content.parts || []).map((p) => p.text || "").join("");
  if (opts.search) {
    const sources = (cand.groundingMetadata?.groundingChunks || [])
      .map((c) => c.web)
      .filter((w) => w && w.uri)
      .map((w) => ({ title: w.title || "Source", url: w.uri }));
    return { text, sources };
  }
  try { return JSON.parse(text); }
  catch { throw new Error("Gemini returned an unreadable result. Try again, or change GEMINI_MODEL to gemini-2.5-flash and restart."); }
}

async function gemini(prompt, opts = {}) {
  const candidates = working ? [working, ...MODELS.filter((m) => m !== working)] : MODELS;
  const order = candidates.slice(0, opts.maxModels || candidates.length);
  const deadline = Date.now() + (opts.totalTimeoutMs || 60000);
  let last;
  for (const m of order) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const out = await callModel(m, prompt, { ...opts, timeoutMs: Math.min(opts.timeoutMs || 25000, remaining) });
        working = m;
        return out;
      } catch (e) {
        last = e;
        const quota = e.status === 429 && /quota/i.test(e.message);
        const timedOut = /timed out|fetch failed|networkerror/i.test(e.message || "");
        if (timedOut) break; // Try the next model instead of repeating the same stalled request.
        if ((e.status === 503 || (e.status === 429 && !quota)) && attempt < 3) {
          await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
    if (Date.now() >= deadline) break;
    if (![404, 400, 408, 429, 500, 502, 503, 504].includes(last.status) && !/timed out|fetch failed|networkerror/i.test(last.message || "")) throw last;
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

// Each search returns null when the service did not answer, and a list (maybe empty) when it did.
async function searchArxiv(q) {
  const r = await fetchWithTimeout(`${process.env.ARXIV_URL || "http://export.arxiv.org/api/query"}?search_query=all:${encodeURIComponent(q)}&max_results=5&sortBy=relevance`);
  if (!r.ok) return null;
  const xml = await r.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
    title: (m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").replace(/\s+/g, " ").trim(),
    url: m[1].match(/<id>(.*?)<\/id>/)?.[1],
    year: m[1].match(/<published>(\d{4})/)?.[1],
  }));
}

async function searchScholar(q) {
  const r = await fetchWithTimeout(`${process.env.SCHOLAR_URL || "https://api.semanticscholar.org/graph/v1/paper/search"}?query=${encodeURIComponent(q)}&limit=5&fields=title,year,url,citationCount`);
  if (!r.ok) return null;
  return (await r.json()).data || [];
}

// OpenAlex is free and covers a very large number of papers.
async function searchOpenAlex(q) {
  const mail = process.env.OPENALEX_EMAIL ? "&mailto=" + encodeURIComponent(process.env.OPENALEX_EMAIL) : "";
  const r = await fetchWithTimeout(`${process.env.OPENALEX_URL || "https://api.openalex.org/works"}?search=${encodeURIComponent(q)}&per_page=5${mail}`);
  if (!r.ok) return null;
  const j = await r.json();
  return (j.results || [])
    .map((w) => ({ title: w.display_name || w.title || "", url: w.doi || w.id, year: w.publication_year, citationCount: w.cited_by_count }))
    .filter((p) => p.title && p.url);
}

async function searchGithub(q) {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetchWithTimeout(
    `${process.env.GITHUB_URL || "https://api.github.com/search/repositories"}?q=${encodeURIComponent(q)}&sort=stars&per_page=5`,
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

async function searchHuggingFace(q) {
  const headers = process.env.HUGGINGFACE_TOKEN ? { Authorization: `Bearer ${process.env.HUGGINGFACE_TOKEN}` } : {};
  const [models, datasets, spaces] = await Promise.all(["models", "datasets", "spaces"].map(async (kind) => {
    try {
      const r = await fetchWithTimeout(`https://huggingface.co/api/${kind}?search=${encodeURIComponent(q)}&limit=5&sort=downloads&direction=-1`, { headers });
      if (!r.ok) return null;
      return (await r.json()).map((x) => ({ name: x.id, url: `https://huggingface.co/${kind}/${x.id}`, downloads: x.downloads || 0, likes: x.likes || 0 }));
    } catch { return null; }
  }));
  if (models === null && datasets === null && spaces === null) return null;
  return { models: models || [], datasets: datasets || [], spaces: spaces || [] };
}

async function searchKaggle(q) {
  const username = process.env.KAGGLE_USERNAME, key = process.env.KAGGLE_KEY;
  if (!username || !key) return null;
  try {
    const r = await fetchWithTimeout(`https://www.kaggle.com/api/v1/datasets/list?search=${encodeURIComponent(q)}&pageSize=5`, {
      headers: { Authorization: "Basic " + Buffer.from(`${username}:${key}`).toString("base64") },
    });
    if (!r.ok) return null;
    return (await r.json()).map((d) => ({ name: d.title || d.ref, url: `https://www.kaggle.com/datasets/${d.ref}`, downloads: d.downloadCount || 0, desc: d.subtitle || "" }));
  } catch { return null; }
}

async function searchDevpost(queries) {
  try {
    const found = await gemini(`Search Devpost for student and hackathon projects related to these ideas: ${queries.join("; ")}. Return a short list of relevant Devpost project pages with their exact titles and URLs. Only include pages from devpost.com.`, { search: true, temperature: 0, timeoutMs: 12000, totalTimeoutMs: 12000, maxModels: 1 });
    return found.sources.filter((s) => /^https?:\/\/(www\.)?devpost\.com\//i.test(s.url)).slice(0, 8);
  } catch { return null; }
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
const state = { users: [], checks: [], subs: [], classes: [], institutions: [], orders: [], pendingTeachers: [] };
let storageMode = "file";
let backend;
const rid = (n = 8) => crypto.randomBytes(n).toString("hex");

function fileBackend() {
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); } catch (e) { console.log("Could not save data:", e.message); }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(flush, 300); };
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { flush(); process.exit(0); }); // do not lose the last changes when the host restarts us
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
    if (c === "checks" || c === "subs") d.data = JSON.stringify(d.data ?? null); // report kept as text, so Firestore never rejects its shape
    return d;
  };
  const warn = (e) => console.log("Firebase save failed:", e.message);
  return {
    project: account.project_id,
    async load() {
      for (const c of ["users", "checks", "subs", "classes", "institutions", "orders", "pendingTeachers"]) {
        const snap = await db.collection(c).get();
        state[c] = snap.docs.map((d) => {
          const x = d.data();
          if ((c === "checks" || c === "subs") && typeof x.data === "string") x.data = JSON.parse(x.data);
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
      console.log("Storage: Firebase Firestore (project " + backend.project + "). Loaded " + state.users.length + " users, " + state.classes.length + " classes, " + state.checks.length + " checks, " + state.subs.length + " sent ideas.");
      return;
    } catch (e) {
      let hint = "";
      if (/NOT_FOUND|5 NOT_FOUND/.test(e.message)) hint = "\nHint: open the Firebase console, go to Build > Firestore Database, and click Create database.";
      else if (/PERMISSION_DENIED|7 PERMISSION/.test(e.message)) hint = "\nHint: the key does not have access. Create a new private key for this project.";
      else if (/JSON|Unexpected token|private_key|credential/i.test(e.message)) hint = "\nHint: the service account key looks wrong. Paste the whole JSON file again.";
      console.log("Firebase did not start:", e.message + hint + "\nUsing temporary file storage instead.");
      state.users = []; state.checks = []; state.subs = []; state.classes = []; state.institutions = []; state.orders = []; state.pendingTeachers = [];
    }
  }
  backend = fileBackend();
  await backend.load();
  state.pendingTeachers ||= [];
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
const publicUser = (u) => {
  const c = u.classId ? state.classes.find((x) => x.id === u.classId) : null;
  const t = c ? state.users.find((x) => x.id === c.teacherId) : null;
  const institution = c?.institutionId ? state.institutions.find((x) => x.id === c.institutionId) : null;
  return {
    id: u.id, name: u.name, email: u.email || "", role: u.role, roll: u.roll || "", loginId: u.loginId || "",
    status: u.status || "approved", mustChange: !!u.mustChange, termsAccepted:!!u.termsAcceptedAt, emailVerified:u.emailVerified!==false, team: u.team || "", recovery: !!u.recA,
    cls: c ? { id: c.id, name: c.name, teacher: t ? t.name : "", institutionName: institution?.name || "", institutionPremium:institutionHasPremium(institution) } : null,
  };
};
const startSession = (req, res, u) =>
  res.cookie("ifx_s", sign({ uid: u.id, authAt: Date.now(), exp: Date.now() + 7 * 864e5 }), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 7 * 864e5, path: "/" });

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
  req.authAt = p?.authAt || 0;
  next();
});
// A new account must set its own password before anything else works.
app.use((req, res, next) => {
  if (req.user?.mustChange && req.path.startsWith("/api/") && !["/api/me", "/api/auth/change-password", "/api/auth/logout", "/api/auth/teacher/pending", "/api/auth/teacher/complete"].includes(req.path)) {
    return res.status(403).json({ error: "Please set a new password first.", mustChange: true });
  }
  if(req.user&&!req.user.termsAcceptedAt&&req.path.startsWith("/api/")&&!["/api/me","/api/auth/logout","/api/auth/change-password","/api/account/accept-terms","/api/account","/api/auth/teacher/pending","/api/auth/teacher/complete"].includes(req.path))return res.status(403).json({error:"Please review and accept the privacy notice and terms to continue.",consentRequired:true});
  next();
});
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Please log in first." }));
const needStudent = (req, res, next) => (!req.user ? res.status(401).json({ error: "Please log in first." }) : req.user.role !== "student" ? res.status(403).json({ error: "Only students can send ideas to a teacher." }) : next());
const needTeacher = (req, res, next) =>
  !req.user ? res.status(401).json({ error: "Please log in first." })
  : req.user.role !== "teacher" ? res.status(403).json({ error: "Teachers only." })
  : (req.user.status || "approved") !== "approved" ? res.status(403).json({ error: "This teacher account is turned off." })
  : next();

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/;
const PW_CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const tempPassword = () => Array.from({ length: 8 }, () => PW_CHARS[crypto.randomInt(PW_CHARS.length)]).join("");

// Two kinds of people: students and teachers. Both register themselves and can log in at once.
const QUESTIONS = [
  "What was the name of your first pet?",
  "What was the name of your first school?",
  "In which town or city were you born?",
  "What was your childhood nickname?",
  "What is the name of your favourite teacher?",
  "What was the first movie you watched in a cinema?",
];
const normAnswer = (a) => String(a || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
const fakeQuestion = (id) => QUESTIONS[sha(id)[0] % QUESTIONS.length]; // same question every time for an unknown email, so nobody can find out which emails exist

app.get("/api/auth/options", (req, res) => res.json({ questions: QUESTIONS, google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) }));

const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || "", GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const APP_URL = (process.env.APP_URL || "http://localhost:" + (process.env.PORT || 3000)).replace(/\/$/, "");
const academicClassKey = (value) => clean(value, 120).toLowerCase().replace(/[^a-z0-9]/g, "");
const findStudentClass = (branch, year, section) => {
  const expected = academicClassKey([branch, year, section].join(" "));
  const matches = state.classes.filter((c) => academicClassKey(c.name) === expected);
  return matches.length === 1 ? matches[0] : null;
};
app.get("/api/auth/google/start", (req, res) => {
  if (!GOOGLE_ID || !GOOGLE_SECRET) return res.status(503).send("Google sign-in is not configured yet.");
  const role = req.query.role === "teacher" ? "teacher" : "student";
  const stateId = rid(24), verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  res.cookie("ifx_oauth", sign({ state: stateId, verifier, role, classId: clean(req.query.classId, 64), roll: clean(req.query.roll, 40), name: clean(req.query.name, 80), termsAccepted:false, exp: Date.now() + 10 * 60e3 }), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 10 * 60e3, path: "/" });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  Object.entries({ client_id: GOOGLE_ID, redirect_uri: APP_URL + "/api/auth/google/callback", response_type: "code", scope: "openid email profile", state: stateId, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" }).forEach(([k,v]) => u.searchParams.set(k,v));
  res.redirect(u.toString());
});
app.post("/api/auth/google/prepare", (req,res)=>{
  if(!GOOGLE_ID||!GOOGLE_SECRET)return res.status(503).json({error:"Google sign-in is not configured yet."});
  const role=req.body?.role==="teacher"?"teacher":"student";
  if(req.body?.termsAccepted===true){
    const phone=clean(req.body?.phone,20),digits=phone.replace(/\D/g,"");
    if(digits.length<8||digits.length>15)return res.status(400).json({error:"Enter a valid contact number."});
    if(role==="student"&&(!clean(req.body?.roll,40)||!clean(req.body?.year,20)||!clean(req.body?.branch,60)||!clean(req.body?.section,20)))return res.status(400).json({error:"Fill in your roll number, year, branch and section before continuing with Google."});
    if(role==="teacher"&&(!clean(req.body?.employeeId,40)||!clean(req.body?.department,80)||!clean(req.body?.designation,50)))return res.status(400).json({error:"Fill in your employee ID, department and designation before continuing with Google."});
  }
  const stateId=rid(24),verifier=crypto.randomBytes(32).toString("base64url"),challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  const matchedClass=role==="student"&&req.body?.termsAccepted===true?findStudentClass(req.body?.branch,req.body?.year,req.body?.section):null;
  res.cookie("ifx_oauth",sign({state:stateId,verifier,role,classId:matchedClass?.id||"",roll:clean(req.body?.roll,40),name:clean(req.body?.name,80),phone:clean(req.body?.phone,20),year:clean(req.body?.year,20),branch:clean(req.body?.branch,60),section:clean(req.body?.section,20),team:clean(req.body?.team,60),employeeId:clean(req.body?.employeeId,40),department:clean(req.body?.department,80),designation:clean(req.body?.designation,50),termsAccepted:req.body?.termsAccepted===true,exp:Date.now()+10*60e3}),{httpOnly:true,sameSite:"lax",secure:req.secure,maxAge:10*60e3,path:"/"});
  const u=new URL("https://accounts.google.com/o/oauth2/v2/auth");
  Object.entries({client_id:GOOGLE_ID,redirect_uri:APP_URL+"/api/auth/google/callback",response_type:"code",scope:"openid email profile",state:stateId,code_challenge:challenge,code_challenge_method:"S256",prompt:"select_account"}).forEach(([k,v])=>u.searchParams.set(k,v));
  res.json({url:u.toString()});
});

app.get("/api/auth/google/callback", async (req, res) => {
  const oauth = verify(readCookie(req, "ifx_oauth"));
  res.clearCookie("ifx_oauth", { path: "/" });
  if (!oauth || !req.query.code || !safeEq(String(req.query.state || ""), oauth.state)) return res.redirect("/student?authError=state");
  try {
    const form = new URLSearchParams({ code: String(req.query.code), client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET, redirect_uri: APP_URL + "/api/auth/google/callback", grant_type: "authorization_code", code_verifier: oauth.verifier });
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error("Google sign-in could not be completed.");
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tokenData.access_token } });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.email || profile.email_verified !== true || !profile.sub) throw new Error("Google did not confirm this email address.");
    const email = clean(profile.email, 120).toLowerCase(), role = oauth.role;
    let u = state.users.find((x) => x.googleSub === profile.sub);
    if (u && u.role !== role) return res.redirect(role === "teacher" ? "/teacher/login?authError=role" : "/student?authError=role");
    if (!u) u = state.users.find((x) => x.role === role && x.email === email);
    if (!u) {
      if(!oauth.termsAccepted)return res.redirect(role==="teacher"?"/teacher/login?authError=consent":"/student?authError=consent");
      if (role === "student") {
        const cls = state.classes.find((x) => x.id === oauth.classId);
        if (!/^[A-Za-z0-9._\-\/]{1,40}$/.test(oauth.roll)) return res.redirect("/student?authError=register");
        if(cls&&studentCapacityError(cls.id))return res.redirect("/student?authError=capacity");
        if (state.users.some((x) => x.role === "student" && x.loginId === oauth.roll.toLowerCase())) return res.redirect("/student?authError=exists");
        u = { id: rid(8), role, name: oauth.name || clean(profile.name, 80) || oauth.roll, email, emailVerified: true, termsAcceptedAt:Date.now(), googleSub: profile.sub, loginId: oauth.roll.toLowerCase(), roll: oauth.roll, phone: oauth.phone, year: oauth.year, branch: oauth.branch, section: oauth.section, team: clean(oauth.team,60), classId: cls?.id || null, status: "approved", authProvider: "google", at: Date.now() };
      } else {
        u = { id: rid(8), role, name: clean(profile.name, 80) || email, email, employeeId: oauth.employeeId, phone: oauth.phone, department: oauth.department, designation: oauth.designation, emailVerified: true, termsAcceptedAt:Date.now(), googleSub: profile.sub, loginId: email, roll: "", classId: null, status: "approved", authProvider: "google", at: Date.now() };
      }
      state.users.push(u);
    }
    u.googleSub = profile.sub; u.emailVerified = true; u.authProvider = "google";
    backend.put("users", u);
    startSession(req, res, u);
    res.redirect(role === "teacher" ? "/teacher" : "/");
  } catch (e) { console.log("Google sign-in error:", e.message); res.redirect((oauth.role === "teacher" ? "/teacher/login" : "/student") + "?authError=google"); }
});

// The class list on the student sign-up page. Only names, never students.
app.get("/api/public/classes", (req, res) => {
  res.json(state.classes.map((c) => ({ id: c.id, name: c.name, teacher: (state.users.find((u) => u.id === c.teacherId) || {}).name || "" }))
    .sort((a, b) => a.teacher.localeCompare(b.teacher) || a.name.localeCompare(b.name)));
});

// Institutions share only opted-in, teacher-approved project descriptions across invited faculty classes.
const institutionFor = (u) => state.institutions.find((x) => x.id === u?.institutionId) || null;
app.get("/api/teacher/institution", needTeacher, (req, res) => {
  const inst = institutionFor(req.user);
  if (!inst) return res.json({ institution: null });
  const classIds = new Set(state.classes.filter((c) => c.institutionId === inst.id).map((c) => c.id));
  res.json({ institution: {
    id: inst.id, name: inst.name, owner: inst.ownerId === req.user.id,
    faculty: state.users.filter((u) => u.role === "teacher" && u.institutionId === inst.id).length,
    classes: classIds.size,
    archivedProjects: state.subs.filter((s) => s.status === "Approved" && s.archiveOptIn === true && classIds.has(s.classId)).length,
    pilotExpiresAt:inst.pilotExpiresAt||null, premium:institutionHasPremium(inst),
  } });
});

app.post("/api/teacher/institution", needTeacher, (req, res) => {
  if (institutionFor(req.user)) return res.status(409).json({ error: "You already belong to an institution archive." });
  const name = clean(req.body?.name, 120);
  if (name.length < 3) return res.status(400).json({ error: "Enter your college or institution name." });
  if (state.institutions.length >= 5000) return res.status(507).json({ error: "The institution limit has been reached." });
  const inst = { id: rid(8), name, ownerId: req.user.id, inviteHash: "", at: Date.now(), pilotExpiresAt:Date.now()+(Number(process.env.FREE_PILOT_DAYS)||90)*864e5 };
  state.institutions.push(inst);
  req.user.institutionId = inst.id;
  req.user.institutionRole = "owner";
  backend.put("institutions", inst);
  backend.put("users", req.user);
  state.classes.filter((c) => c.teacherId === req.user.id).forEach((c) => { c.institutionId = inst.id; backend.put("classes", c); });
  res.json({ institution: { id: inst.id, name: inst.name, owner: true, faculty: 1, classes: state.classes.filter((c) => c.institutionId === inst.id).length, archivedProjects: 0 } });
});

app.post("/api/teacher/institution/join", needTeacher, (req, res) => {
  if (institutionFor(req.user)) return res.status(409).json({ error: "You already belong to an institution archive." });
  if (tooMany("institution-join", req.user.id, 8)) return res.status(429).json({ error: "Too many invite-code attempts. Try again later." });
  const code = clean(req.body?.code, 32).toUpperCase();
  if (!code) return res.status(400).json({ error: "Enter the faculty invite code." });
  const digest = sha(code).toString("hex");
  const inst = state.institutions.find((x) => x.inviteHash && safeEq(x.inviteHash, digest));
  if (!inst) return res.status(404).json({ error: "That invite code is not valid. Ask the archive owner for a current code." });
  req.user.institutionId = inst.id;
  req.user.institutionRole = "faculty";
  backend.put("users", req.user);
  state.classes.filter((c) => c.teacherId === req.user.id).forEach((c) => { c.institutionId = inst.id; backend.put("classes", c); });
  res.json({ institution: { id: inst.id, name: inst.name, owner: false } });
});

app.post("/api/teacher/institution/invite", needTeacher, (req, res) => {
  const inst = institutionFor(req.user);
  if (!inst || inst.ownerId !== req.user.id) return res.status(403).json({ error: "Only the institution archive owner can create faculty invite codes." });
  const code = crypto.randomBytes(6).toString("hex").toUpperCase();
  inst.inviteHash = sha(code).toString("hex");
  backend.put("institutions", inst);
  res.json({ code });
});

function institutionPlan(inst) { return inst?.plan?.status === "active" && Number(inst.plan.expiresAt) > Date.now() ? inst.plan : null; }
function institutionHasPremium(inst) { return !!institutionPlan(inst) || Number(inst?.pilotExpiresAt)>Date.now(); }
function studentCapacityError(classId) {
  const cls=state.classes.find((c)=>c.id===classId),inst=cls?.institutionId?state.institutions.find((x)=>x.id===cls.institutionId):null,plan=institutionPlan(inst);
  if(plan?.type!=="per_student")return "";
  const count=state.users.filter((u)=>u.role==="student"&&state.classes.some((c)=>c.id===u.classId&&c.institutionId===inst.id)).length;
  return count>=plan.seats?"This college plan has reached its "+plan.seats+" student seats. Ask the archive owner to add seats.":"";
}
async function createBillingOrder(req, res) {
  const inst=institutionFor(req.user);
  if(!inst||inst.ownerId!==req.user.id)return res.status(403).json({error:"Only the college archive owner can manage a plan."});
  if(tooMany("billing-order",req.user.id,5))return res.status(429).json({error:"Too many checkout attempts. Try again later."});
  const id=process.env.RAZORPAY_KEY_ID,secret=process.env.RAZORPAY_KEY_SECRET;
  if(!id||!secret)return res.status(503).json({error:"College checkout is not configured. The operator must add Razorpay credentials and plan pricing."});
  const plan=req.body?.plan==="department"?"department":"per_student";
  const currentSeats=state.users.filter((u)=>u.role==="student"&&state.classes.some((c)=>c.id===u.classId&&c.institutionId===inst.id)).length;
  const seats=plan==="department"?currentSeats:Math.max(1,Math.min(10000,Number(req.body?.seats)||currentSeats||1));
  if(plan==="per_student"&&seats<currentSeats)return res.status(400).json({error:"Seat count cannot be lower than the institution’s current student count ("+currentSeats+")."});
  const price=Number(plan==="department"?process.env.PRICE_DEPARTMENT_YEAR_INR:process.env.PRICE_PER_STUDENT_YEAR_INR);
  if(!Number.isFinite(price)||price<=0)return res.status(503).json({error:"Set the annual plan price in the deployment environment before enabling checkout."});
  const amount=Math.round(price*(plan==="department"?1:seats)*100);
  const receipt="ifx_"+rid(10);
  try{
    const response=await fetch("https://api.razorpay.com/v1/orders",{method:"POST",headers:{Authorization:"Basic "+Buffer.from(id+":"+secret).toString("base64"),"Content-Type":"application/json"},body:JSON.stringify({amount,currency:"INR",receipt,notes:{institutionId:inst.id,plan,seats:String(seats),term:"annual"}})});
    const order=await response.json();if(!response.ok)throw new Error("Razorpay could not create the order.");
    const rec={id:rid(8),orderId:order.id,institutionId:inst.id,plan,seats,amount,status:"created",createdAt:Date.now()};
    state.orders.push(rec);backend.put("orders",rec);
    res.json({keyId:id,orderId:order.id,amount,currency:"INR",institution:inst.name,description:plan==="department"?"Annual department plan":"Annual per-student campus plan · "+seats+" seats"});
  }catch(e){console.log("College order error:",e.message);res.status(502).json({error:"Could not start checkout. Please try again later."});}
}
function activateOrder(order,paymentId){
  if(!order||order.status==="paid")return;
  const inst=state.institutions.find((x)=>x.id===order.institutionId);if(!inst)return;
  const base=Math.max(Date.now(),Number(inst.plan?.expiresAt)||0);
  inst.plan={status:"active",type:order.plan,seats:order.seats,amount:order.amount,currency:"INR",startedAt:Date.now(),expiresAt:base+365*864e5,orderId:order.orderId,paymentId};
  order.status="paid";order.paymentId=paymentId;order.paidAt=Date.now();backend.put("orders",order);backend.put("institutions",inst);
}
app.get("/pricing",needTeacher,(req,res)=>res.sendFile(path.join(PUBLIC,"pricing.html")));
app.get("/api/billing/status",needTeacher,(req,res)=>{const inst=institutionFor(req.user);res.json({owner:!!inst&&inst.ownerId===req.user.id,plan:institutionPlan(inst),pilotExpiresAt:inst?.pilotExpiresAt||null,premium:institutionHasPremium(inst),perStudentPrice:Number(process.env.PRICE_PER_STUDENT_YEAR_INR)||null,departmentPrice:Number(process.env.PRICE_DEPARTMENT_YEAR_INR)||null,configured:!!(process.env.RAZORPAY_KEY_ID&&process.env.RAZORPAY_KEY_SECRET&&Number(process.env.PRICE_PER_STUDENT_YEAR_INR)>0&&Number(process.env.PRICE_DEPARTMENT_YEAR_INR)>0)});});
app.post("/api/billing/order",needTeacher,createBillingOrder);
app.post("/api/billing/verify",needTeacher,async (req,res)=>{
  const inst=institutionFor(req.user),secret=process.env.RAZORPAY_KEY_SECRET;
  const orderId=String(req.body?.orderId||""),paymentId=String(req.body?.paymentId||""),signature=String(req.body?.signature||"");
  const order=state.orders.find((x)=>x.orderId===orderId&&x.institutionId===inst?.id);
  if(!inst||inst.ownerId!==req.user.id||!order||!secret)return res.status(403).json({error:"Payment order not found."});
  const expected=crypto.createHmac("sha256",secret).update(orderId+"|"+paymentId).digest("hex");
  if(!safeEq(expected,signature))return res.status(400).json({error:"Payment could not be verified."});
  try{
    const check=await fetch("https://api.razorpay.com/v1/payments/"+encodeURIComponent(paymentId),{headers:{Authorization:"Basic "+Buffer.from(process.env.RAZORPAY_KEY_ID+":"+secret).toString("base64")} });
    const payment=await check.json();
    if(!check.ok||payment.order_id!==orderId||payment.amount!==order.amount||payment.currency!=="INR"||payment.status!=="captured")return res.status(409).json({error:"Payment is not captured yet. The plan will activate after successful capture."});
  }catch{return res.status(502).json({error:"Could not confirm payment status. Please retry."})}
  activateOrder(order,paymentId);res.json({ok:true,plan:institutionPlan(inst)});
});
app.post("/api/billing/webhook",(req,res)=>{
  const secret=process.env.RAZORPAY_WEBHOOK_SECRET,received=String(req.get("x-razorpay-signature")||"");
  if(!secret||!req.rawBody)return res.status(503).send("Webhook is not configured.");
  const expected=crypto.createHmac("sha256",secret).update(req.rawBody).digest("hex");
  if(!safeEq(expected,received))return res.status(400).send("Invalid signature.");
  let event;try{event=JSON.parse(req.rawBody.toString("utf8"))}catch{return res.status(400).send("Invalid payload.")}
  const payment=event?.payload?.payment?.entity,orderId=payment?.order_id;
  if(orderId&&event.event==="payment.captured"&&payment.status==="captured"&&payment.currency==="INR")activateOrder(state.orders.find((x)=>x.orderId===orderId&&x.amount===payment.amount),payment.id||"");
  res.json({ok:true});
});

app.post("/api/auth/register-teacher", async (req, res) => {
  try {
    if (tooMany("teacher-signup", req.ip, 10)) return res.status(429).json({ error: "Too many sign-up attempts. Try again in an hour." });
    const name=clean(req.body?.name,80),email=clean(req.body?.email,120).toLowerCase(),employeeId=clean(req.body?.employeeId,40),phone=clean(req.body?.phone,20),department=clean(req.body?.department,80),designation=clean(req.body?.designation,50);
    const pw=String(req.body?.password||"").slice(0,128),confirm=String(req.body?.passwordConfirm||"").slice(0,128),question=Number(req.body?.question),answer=normAnswer(req.body?.answer);
    if(name.length<2)return res.status(400).json({error:"Enter your name."});
    if(!EMAIL.test(email))return res.status(400).json({error:"Enter a valid email address."});
    if(!employeeId||!department||!designation||phone.replace(/\D/g,"").length<8||phone.replace(/\D/g,"").length>15)return res.status(400).json({error:"Enter your employee ID, contact number, department and designation."});
    if(pw.length<8||pw!==confirm)return res.status(400).json({error:"Enter a password with at least 8 characters, then type it again."});
    if(!Number.isInteger(question)||question<0||question>=QUESTIONS.length||answer.length<3)return res.status(400).json({error:"Choose a recovery question and enter an answer with at least 3 characters."});
    if(req.body?.termsAccepted!==true)return res.status(400).json({error:"Please accept the privacy notice and terms first."});
    if(state.users.some(u=>u.role==="teacher"&&(u.loginId===email||u.email===email)))return res.status(409).json({error:"An account with this email already exists. Log in instead."});
    const u={id:rid(8),role:"teacher",name,email,employeeId,phone,department,designation,emailVerified:true,termsAcceptedAt:Date.now(),loginId:email,roll:"",classId:null,status:"approved",pw:await hashPw(pw),mustChange:false,recQ:question,recA:await hashPw(answer),at:Date.now()};
    state.users.push(u);backend.put("users",u);startSession(req,res,u);res.json({ok:true,next:"/teacher"});
  } catch(e) { console.error("Teacher registration failed:",e.message);res.status(500).json({error:"Could not create the account. Please try again."}); }
});

app.post("/api/auth/register-student", async (req, res) => {
  try {
    // a whole class may register from one college network, so this limit is higher than the teacher one
    if (tooMany("regs", req.ip, 120)) return res.status(429).json({ error: "Too many sign-ups from this connection. Try again in an hour." });
    const name = clean(req.body?.name, 80), roll = clean(req.body?.roll, 40), pw = String(req.body?.password || "").slice(0, 128);
    let email = clean(req.body?.email, 120).toLowerCase();
    const phone=clean(req.body?.phone,20),year=clean(req.body?.year,20),branch=clean(req.body?.branch,60),section=clean(req.body?.section,20),phoneDigits=phone.replace(/\D/g,"");
    if(req.body?.termsAccepted!==true)return res.status(400).json({error:"Review and accept the privacy notice and terms to create an account."});
    if (name.length < 2) return res.status(400).json({ error: "Enter your name." });
    if (!/^[A-Za-z0-9._\-\/]{1,40}$/.test(roll)) return res.status(400).json({ error: "Enter your roll number. Use letters, numbers and - . _ / only." });
    if (pw.length < 8) return res.status(400).json({ error: "Use a password with at least 8 characters." });
    if(phoneDigits.length<8||phoneDigits.length>15||!year||!branch||!section)return res.status(400).json({error:"Enter a valid phone number, year, branch and section."});
    const cls=findStudentClass(branch,year,section);
    const capacityError=cls&&studentCapacityError(cls.id);if(capacityError)return res.status(409).json({error:capacityError});
    if (!EMAIL.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    const old = state.users.find((x) => x.role === "student" && x.loginId === roll.toLowerCase());
    if (old) return res.status(409).json({ error: "This roll number is already registered. Log in, or ask your teacher to reset your password." });
    if (state.users.length >= 20000) return res.status(507).json({ error: "Too many accounts." });
    const u = { id: rid(8), role: "student", name, email, phone, year, branch, section, emailVerified: true, termsAcceptedAt:Date.now(), roll, team: clean(req.body?.team,60), loginId: roll.toLowerCase(), classId: cls?.id || null, status: "approved", pw: await hashPw(pw), mustChange: false, at: Date.now() };
    state.users.push(u);
    backend.put("users", u);
    startSession(req,res,u);res.json({ok:true,next:"/"});
  } catch (e) {
    console.error("Student registration failed:", e.message);
    res.status(500).json({error:"Could not register. Please try again."});
  }
});

app.post("/api/auth/register-student-batch", async (req,res)=>{
  const created=[];
  try{
    if(tooMany("regs",req.ip,120))return res.status(429).json({error:"Too many sign-ups from this connection. Try again in an hour."});
    const members=Array.isArray(req.body?.members)?req.body.members:[],year=clean(req.body?.year,20),branch=clean(req.body?.branch,60),section=clean(req.body?.section,20),team=clean(req.body?.team,60),password=String(req.body?.password||"").slice(0,128),passwordConfirm=String(req.body?.passwordConfirm||"").slice(0,128);
    if(req.body?.termsAccepted!==true)return res.status(400).json({error:"Review and accept the privacy notice and terms to create accounts."});
    if(members.length<2||members.length>10||!team)return res.status(400).json({error:"A group registration needs a group name and 2 to 10 students."});
    if(!year||!branch||!section)return res.status(400).json({error:"Enter the group’s year, branch and section."});
    if(password.length<8||password!==passwordConfirm)return res.status(400).json({error:"Enter one password with at least 8 characters, then type it again to confirm."});
    const cls=findStudentClass(branch,year,section),digits=(v)=>clean(v,20).replace(/\D/g,"");
    const prepared=members.map((m)=>({name:clean(m?.name,80),roll:clean(m?.roll,40),email:clean(m?.email,120).toLowerCase(),phone:clean(m?.phone,20)}));
    for(const m of prepared){
      if(m.name.length<2||! /^[A-Za-z0-9._\-\/]{1,40}$/.test(m.roll)||!EMAIL.test(m.email)||digits(m.phone).length<8||digits(m.phone).length>15)return res.status(400).json({error:"Each member needs a name, valid roll number, email and phone number."});
    }
    if(new Set(prepared.map((m)=>m.roll.toLowerCase())).size!==prepared.length)return res.status(409).json({error:"Each student needs a different roll number."});
    if(new Set(prepared.map((m)=>m.email)).size!==prepared.length)return res.status(409).json({error:"Each student needs a different email address."});
    for(const m of prepared)if(state.users.some((u)=>u.role==="student"&&(u.loginId===m.roll.toLowerCase()||u.email===m.email)))return res.status(409).json({error:"A student with roll number "+m.roll+" or email "+m.email+" already has an account."});
    if(state.users.length+prepared.length>20000)return res.status(507).json({error:"There is not enough account capacity for this group."});
    const cap=cls&&studentCapacityError(cls.id);if(cap)return res.status(409).json({error:cap});
    for(const m of prepared){
      const u={id:rid(8),role:"student",name:m.name,email:m.email,phone:m.phone,year,branch,section,emailVerified:true,termsAcceptedAt:Date.now(),roll:m.roll,team,loginId:m.roll.toLowerCase(),classId:cls?.id||null,status:"approved",pw:await hashPw(password),mustChange:false,at:Date.now()};
      created.push(u);state.users.push(u);backend.put("users",u);
    }
    startSession(req,res,created[0]);return res.json({ok:true,next:"/"});
  }catch(e){
    for(const u of created){state.users=state.users.filter((x)=>x!==u);backend.del("users",u.id)}
    console.error("Student group registration failed:",e.message);
    return res.status(500).json({error:"Could not register this group. Please try again."});
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const id = clean(req.body?.id, 120).toLowerCase(), pw = String(req.body?.password || "").slice(0, 128);
    const portal = req.body?.portal === "teacher" ? "teacher" : "student";
    if (recentFails("e" + portal + id).length >= 8 || recentFails("i" + req.ip).length >= 40) {
      return res.status(429).json({ error: "Too many wrong tries. Please wait an hour and try again." });
    }
    const match = (role) => state.users.find((x) => x.role === role && (x.loginId === id || (x.email && x.email === id)));
    const u = match(portal);
    const ok = await checkPw(pw, u?.pw);
    if (!u || !ok) {
      const other = !u ? match(portal === "teacher" ? "student" : "teacher") : null;
      if (other && (await checkPw(pw, other.pw))) return res.status(403).json({ error: "That is a " + other.role + " account. Use the " + other.role + " login instead." });
      recentFails("e" + portal + id).push(Date.now());
      recentFails("i" + req.ip).push(Date.now());
      return res.status(401).json({ error: "Wrong ID or password." });
    }
    if ((u.status || "approved") !== "approved") return res.status(403).json({ error: "This account is turned off." });
    fails.delete("e" + portal + id);
    startSession(req, res, u);
    res.json({ user: publicUser(u), next: u.role === "teacher" ? "/teacher" : "/", mustChange: !!u.mustChange });
  } catch (e) {
    res.status(500).json({ error: "Could not log in. Please try again." });
  }
});

// Forgotten teacher password: answer the recovery question chosen at sign-up.
app.post("/api/auth/forgot/question", (req, res) => {
  const email = clean(req.body?.email, 120).toLowerCase();
  if (!EMAIL.test(email)) return res.status(400).json({ error: "Enter the email you registered with." });
  const u = state.users.find((x) => x.role === "teacher" && (x.loginId === email || x.email === email));
  res.json({ question: u && u.recA && QUESTIONS[u.recQ] ? QUESTIONS[u.recQ] : fakeQuestion(email) });
});

app.post("/api/auth/forgot/reset", async (req, res) => {
  try {
    const email = clean(req.body?.email, 120).toLowerCase(), ans = normAnswer(req.body?.answer), nw = String(req.body?.newPassword || "");
    if (recentFails("r" + email).length >= 5 || recentFails("ri" + req.ip).length >= 20) return res.status(429).json({ error: "Too many wrong answers. Please wait an hour and try again." });
    if (nw.length < 8 || nw.length > 128) return res.status(400).json({ error: "The new password must be 8 to 128 characters." });
    const u = state.users.find((x) => x.role === "teacher" && (x.loginId === email || x.email === email));
    const ok = await checkPw(ans, u?.recA);
    if (!u || !u.recA || !ok) {
      recentFails("r" + email).push(Date.now());
      recentFails("ri" + req.ip).push(Date.now());
      return res.status(401).json({ error: "That answer is not right, or this account has no recovery question set." });
    }
    fails.delete("r" + email);
    fails.delete("eteacher" + email);
    u.pw = await hashPw(nw);
    u.mustChange = false;
    backend.put("users", u);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Could not reset the password. Please try again." });
  }
});

// A logged-in teacher can set or change the recovery question.
app.post("/api/auth/recovery", needTeacher, async (req, res) => {
  try {
    const qi = Number(req.body?.question), ans = normAnswer(req.body?.answer);
    if (!(await checkPw(String(req.body?.password || ""), req.user.pw))) return res.status(401).json({ error: "Your password is wrong." });
    if (!Number.isInteger(qi) || qi < 0 || qi >= QUESTIONS.length) return res.status(400).json({ error: "Pick a recovery question." });
    if (ans.length < 3) return res.status(400).json({ error: "Type an answer (at least 3 letters)." });
    req.user.recQ = qi;
    req.user.recA = await hashPw(ans);
    backend.put("users", req.user);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Could not save. Please try again." });
  }
});

app.post("/api/auth/change-password", needUser, async (req, res) => {
  try {
    if (tooMany("pw", req.user.id, 20)) return res.status(429).json({ error: "Too many tries. Please wait a while." });
    const cur = String(req.body?.current || ""), nw = String(req.body?.newPassword || "");
    if (!(await checkPw(cur, req.user.pw))) return res.status(401).json({ error: "Your current password is wrong." });
    if (nw.length < 8 || nw.length > 128) return res.status(400).json({ error: "The new password must be 8 to 128 characters." });
    if (nw === cur) return res.status(400).json({ error: "Choose a password different from the old one." });
    req.user.pw = await hashPw(nw);
    req.user.mustChange = false;
    backend.put("users", req.user);
    res.json({ user: publicUser(req.user) });
  } catch (e) {
    res.status(500).json({ error: "Could not change the password. Please try again." });
  }
});

app.post("/api/auth/logout", (req, res) => { res.clearCookie("ifx_s", { path: "/" }); res.json({ ok: true }); });
app.get("/api/me", (req, res) => res.json({ user: req.user ? publicUser(req.user) : null, storage: storageMode, online: LIMITS_ON }));
app.get("/account", needUser, (req, res) => res.sendFile(path.join(PUBLIC, "account.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(PUBLIC, "privacy.html")));
app.get("/terms", (req, res) => res.sendFile(path.join(PUBLIC, "terms.html")));
app.get("/api/public/config", (req,res)=>res.json({privacyContact:process.env.PRIVACY_CONTACT||"",baseUrl:APP_URL}));
app.get("/consent",needUser,(req,res)=>{if(req.user.termsAcceptedAt)return res.redirect(req.user.role==="teacher"?"/teacher":"/");res.sendFile(path.join(PUBLIC,"consent.html"))});
app.post("/api/account/accept-terms",needUser,(req,res)=>{if(req.body?.accept!==true)return res.status(400).json({error:"Please accept the privacy notice and terms to continue."});req.user.termsAcceptedAt=Date.now();req.user.termsVersion="2026-11-05";backend.put("users",req.user);res.json({ok:true,next:req.user.role==="teacher"?"/teacher":"/"})});
app.get("/api/account/team-profile", needStudent, (req,res)=>res.json({open:req.user.teamOpen===true,skills:req.user.teamSkills||"",team:req.user.team||""}));
app.patch("/api/account/team-profile", needStudent, (req, res) => {
  req.user.teamOpen = req.body?.open === true;
  req.user.teamSkills = clean(req.body?.skills, 240);
  req.user.teamConsentAt=req.user.teamOpen?Date.now():(req.user.teamConsentAt||null);
  if(!req.user.teamOpen)req.user.teamConsentRevokedAt=Date.now();
  backend.put("users", req.user);
  res.json({ open: req.user.teamOpen, skills: req.user.teamSkills });
});
app.get("/api/account/team-matches", needStudent, (req, res) => {
  const u=req.user;
  if (u.team || !u.classId) return res.json({ matches: [] });
  const mine=words(u.teamSkills || "");
  const matches=state.users.filter((x)=>x.id!==u.id&&x.role==="student"&&x.classId===u.classId&&x.teamOpen===true&&!x.team)
    .map((x)=>{const theirs=words(x.teamSkills||"");return {name:x.name,roll:x.roll,skills:x.teamSkills||"",score:overlap(mine,theirs)}})
    .filter((x)=>x.score>0)
    .sort((a,b)=>b.score-a.score).slice(0,8).map(({score,...x})=>x);
  res.json({matches});
});
app.delete("/api/account", needUser, async (req, res) => {
  const u=req.user;
  if(req.body?.confirm!=="DELETE MY ACCOUNT")return res.status(400).json({error:"Type DELETE MY ACCOUNT to confirm."});
  if(Date.now()-req.authAt>15*60e3)return res.status(401).json({error:"For security, sign in again before deleting your account."});
  if(u.pw && !(await checkPw(String(req.body?.password||""),u.pw)))return res.status(403).json({error:"Enter your current password to delete the account."});
  const ownedClasses=u.role==="teacher"?state.classes.filter((c)=>c.teacherId===u.id):[];
  const classIds=new Set();
  if(u.role==="teacher"){
    for(const c of ownedClasses){const other=c.institutionId&&state.users.find((x)=>x.role==="teacher"&&x.id!==u.id&&x.institutionId===c.institutionId);if(other){c.teacherId=other.id;backend.put("classes",c);state.subs.filter((s)=>s.classId===c.id).forEach((s)=>{s.teacherId=other.id;backend.put("subs",s)})}else classIds.add(c.id)}
    for(const inst of state.institutions.filter((i)=>i.ownerId===u.id)){
      const next=state.users.find((x)=>x.role==="teacher"&&x.id!==u.id&&x.institutionId===inst.id);
      if(next){inst.ownerId=next.id;next.institutionRole="owner";backend.put("users",next);backend.put("institutions",inst)}
      else {state.institutions=state.institutions.filter((x)=>x!==inst);backend.del("institutions",inst.id);state.classes.filter((c)=>c.institutionId===inst.id).forEach((c)=>{c.institutionId=null;backend.put("classes",c)})}
    }
    state.classes=state.classes.filter((c)=>!classIds.has(c.id));
  }
  const removedUserIds=new Set([u.id]);
  if(u.role==="teacher")state.users.filter((x)=>x.role==="student"&&classIds.has(x.classId)).forEach((x)=>removedUserIds.add(x.id));
  state.users=state.users.filter((x)=>!removedUserIds.has(x.id));
  for(const id of removedUserIds)backend.del("users",id);
  const removedChecks=state.checks.filter((c)=>removedUserIds.has(c.userId));
  state.checks=state.checks.filter((c)=>!removedUserIds.has(c.userId));removedChecks.forEach((c)=>backend.del("checks",c.id));
  if(u.role==="teacher"){
    const gone=state.subs.filter((s)=>s.teacherId===u.id||classIds.has(s.classId));state.subs=state.subs.filter((s)=>!gone.includes(s));gone.forEach((s)=>backend.del("subs",s.id));
  }else{
    for(const s of state.subs.filter((x)=>x.userId===u.id||(x.members||[]).some((m)=>m.id===u.id))){
      const others=(s.members||[]).filter((m)=>m.id!==u.id);
      s.archiveOptIn=false;delete s.archiveEmbedding;
      s.archiveConsentIds=(s.archiveConsentIds||[]).filter((id)=>id!==u.id);if(s.archiveConsentAt&&typeof s.archiveConsentAt==="object")delete s.archiveConsentAt[u.id];if(s.archiveConsentRevokedAt&&typeof s.archiveConsentRevokedAt==="object")delete s.archiveConsentRevokedAt[u.id];
      if(others.length){s.members=others;if(s.userId===u.id){s.userId=others[0].id;s.name="Deleted user";s.email="";s.roll="";s.sentBy="Deleted user"}backend.put("subs",s)}
      else {state.subs=state.subs.filter((x)=>x!==s);backend.del("subs",s.id)}
    }
  }
  res.clearCookie("ifx_s",{path:"/"});res.json({ok:true});
});
app.get("/student", (req, res) => res.sendFile(path.join(PUBLIC, "student-login.html")));
app.get("/teacher/login", (req, res) => res.sendFile(path.join(PUBLIC, "teacher-login.html")));
app.get("/login", (req, res) => res.redirect("/student"));
app.get("/register", (req, res) => res.redirect("/student#register"));

app.post("/api/analyze", async (req, res) => {
  try {
    const { idea, level = "final-year student", time = "4 months", budget = "", currency = "INR", tech = "" } = req.body;
    if (!idea || idea.length < 8) return res.status(400).json({ error: "Describe your idea first." });
    if (!GEMINI) return res.status(500).json({ error: "Set GEMINI_API_KEY in .env" });

    const key = keyOf({ v: 2, idea: idea.trim().replace(/\s+/g, " "), level, time, budget, currency, tech, DROP_AT, BUILD_AT });
    const hit = cache[key];
    if (hit && !req.body.fresh && Date.now() - hit.at < 7 * 864e5) return res.json({ ...hit.data, campusArchive: await campusArchiveMatches(req.user, idea), cached: true, checkId: req.user ? addCheck(req.user, { idea, tech, level, time, budget, currency }, hit.data) : undefined });

    if (LIMITS_ON) {
      if (!req.user && tooMany("guest", req.ip, 3)) return res.status(429).json({ error: "Guests can run 3 checks an hour. Register or log in to get more." });
      const cls=req.user?.classId?state.classes.find((c)=>c.id===req.user.classId):null;
      const inst=cls?.institutionId?state.institutions.find((x)=>x.id===cls.institutionId):null;
      const paid=institutionHasPremium(inst);
      const why = limitReached(req.user ? req.user.id : "g" + req.ip, paid ? (Number(process.env.PAID_RATE_PER_HOUR)||40) : RATE_PER_HOUR, paid);
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
      queries.slice(0, 3).map(async (q) => {
        const [arxiv, scholar, openalex, github, huggingface, kaggle] = await Promise.all([safe(searchArxiv(q)), safe(searchScholar(q)), safe(searchOpenAlex(q)), safe(searchGithub(q)), safe(searchHuggingFace(q)), safe(searchKaggle(q))]);
        return { q, arxiv, scholar, openalex, github, huggingface, kaggle };
      })
    );
    const devpost = await safe(searchDevpost(queries.slice(0, 3)));
    const answered = (k) => results.some((r) => r[k] !== null && r[k] !== undefined);
    const seenTitles = new Set();
    const papers = [...results.flatMap((r) => r.scholar || []), ...results.flatMap((r) => r.openalex || []), ...results.flatMap((r) => r.arxiv || [])]
      .filter((p) => {
        const k = String(p.title || "").toLowerCase().replace(/\W+/g, " ").trim();
        if (!k || seenTitles.has(k)) return false;
        seenTitles.add(k);
        return true;
      })
      .slice(0, 12);
    const evidence = {
      githubWorked: results.some((r) => r.github),
      githubTotalRepos: Math.max(0, ...results.map((r) => r.github?.total || 0)),
      repos: results.flatMap((r) => r.github?.items || []).slice(0, 8),
      huggingface: {
        models: results.flatMap((r) => r.huggingface?.models || []).slice(0, 8),
        datasets: results.flatMap((r) => r.huggingface?.datasets || []).slice(0, 8),
        spaces: results.flatMap((r) => r.huggingface?.spaces || []).slice(0, 8),
      },
      kaggle: results.flatMap((r) => r.kaggle || []).slice(0, 8),
      devpost: devpost || [],
      papers,
      sources: { openAlex: answered("openalex"), semanticScholar: answered("scholar"), arxiv: answered("arxiv"), github: answered("github"), huggingFace: results.some((r) => r.huggingface !== null), kaggle: results.some((r) => r.kaggle !== null), devpost: !!devpost },
    };

    // 3. Judge using the evidence
    const report = await gemini(
      `You are IdeaForge-X, a blunt decision tool for student projects. Do not flatter.
Student: ${level}, time: ${time}. Idea: ${idea}
Student budget: ${budget ? budget : "not given"}. Show all money amounts in ${currency}.
Technologies the student plans to use: ${tech ? tech : "not given"}. If given, build the tech_stack around them and say in "why" when one is a poor fit.
Evidence found (real search results): ${JSON.stringify(evidence)}
If githubWorked is true, matching repositories are evidence to inspect, not an automatic score deduction. If githubWorked is false, say GitHub search did not answer and do not claim any repository counts. Consider whatever papers, Hugging Face, Kaggle and Devpost evidence did answer. Use only exact project names and URLs in the supplied evidence; never invent them.
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
    res.json({ ...result, campusArchive: await campusArchiveMatches(req.user, idea), checkId: req.user ? addCheck(req.user, { idea, tech, level, time, budget, currency }, result) : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Student: my checks and sending to a teacher ----------
const submissionOf = (checkId) => state.subs.find((x) => (x.checkIds || [x.checkId]).includes(checkId));
const archiveGroupIds = (s) => {const ids=(s.members||[]).map((m)=>m.id).filter(Boolean);return ids.length?ids:[s.userId]};
function setArchiveConsent(s,userId,optIn){
  const previous=Array.isArray(s.archiveConsentIds)?s.archiveConsentIds:(s.archiveOptIn?[s.userId]:[]),ids=new Set(previous),group=archiveGroupIds(s);
  if(optIn)ids.add(userId);else ids.delete(userId);
  s.archiveConsentIds=[...ids];if(!s.archiveConsentAt||typeof s.archiveConsentAt!=="object")s.archiveConsentAt={};if(!s.archiveConsentRevokedAt||typeof s.archiveConsentRevokedAt!=="object")s.archiveConsentRevokedAt={};
  if(optIn)s.archiveConsentAt[userId]=Date.now();else s.archiveConsentRevokedAt[userId]=Date.now();
  s.archiveOptIn=group.every((id)=>ids.has(id));
  if(!s.archiveOptIn)delete s.archiveEmbedding;
}
const subInfo = (x,u) => (x ? { id: x.id, status: x.status, comment: x.comment, round: x.round || 1, idea: x.idea, latest: x.checkId, archiveOptIn: x.archiveOptIn === true, archiveOptedByMe:!!u&&((x.archiveConsentIds||[]).includes(u.id)||(!x.archiveConsentIds&&x.archiveOptIn===true&&x.userId===u.id)) } : null);

app.get("/api/my/checks", needUser, (req, res) => {
  res.json(state.checks.filter((c) => c.userId === req.user.id).sort((a, b) => b.at - a.at).map((c) => ({
    id: c.id, idea: c.idea, at: c.at, originality: c.data?.originality, verdict: c.data?.verdict, submission: subInfo(submissionOf(c.id),req.user),
  })));
});

app.get("/api/my/checks/:id", needUser, async (req, res) => {
  const c = state.checks.find((x) => x.id === req.params.id && x.userId === req.user.id);
  if (!c) return res.status(404).json({ error: "Not found." });
  res.json({ id: c.id, idea: c.idea, tech: c.tech || "", level: c.level, time: c.time, budget: c.budget || "", cur: c.currency || "INR", at: c.at, r: { ...c.data, campusArchive: await campusArchiveMatches(req.user, c.idea) }, submission: subInfo(submissionOf(c.id),req.user) });
});

app.delete("/api/my/checks", needUser, (req, res) => {
  const gone = state.checks.filter((c) => c.userId === req.user.id && !submissionOf(c.id));
  state.checks = state.checks.filter((c) => !gone.includes(c));
  gone.forEach((c) => backend.del("checks", c.id));
  res.json({ removed: gone.length });
});

const sameTeam = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const teamMembers = (u) => (u.team ? state.users.filter((x) => x.role === "student" && x.classId === u.classId && x.year === u.year && x.branch === u.branch && x.section === u.section && sameTeam(x.team, u.team)) : [u]);

app.get("/api/my/team", needStudent, (req, res) => {
  const u = req.user;
  if (!u.team || !u.classId) return res.json({ team: "", members: [], submission: null });
  const subs = state.subs.filter((s) => s.classId === u.classId && sameTeam(s.team, u.team)).sort((a, b) => b.at - a.at);
  res.json({ team: u.team, members: teamMembers(u).map((x) => ({ name: x.name, roll: x.roll })), submission: subs[0] ? subInfo(subs[0],u) : null });
});

app.post("/api/submit", needStudent, async (req, res) => {
  const u = req.user;
  const cls = u.classId ? state.classes.find((x) => x.id === u.classId) : null;
  if (!cls) return res.status(400).json({ error: "Your teacher has not connected your year, branch and section to a student group yet." });
  if (req.body?.archiveOptIn !== undefined && typeof req.body.archiveOptIn !== "boolean") return res.status(400).json({ error: "Choose whether to share the approved project anonymously." });
  const wantsArchive = req.body?.archiveOptIn === true;
  if (wantsArchive && (!cls.institutionId||!institutionHasPremium(state.institutions.find((i)=>i.id===cls.institutionId)))) return res.status(400).json({ error: "Your institution pilot has ended. Ask the archive owner to activate a campus plan before sharing." });
  const c = state.checks.find((x) => x.id === String(req.body?.checkId || "") && x.userId === u.id);
  if (!c) return res.status(404).json({ error: "We could not find that check. Check your idea again, then send it." });
  const already = submissionOf(c.id);
  if (already) return res.json({ submission: subInfo(already,u) });
  if (tooMany("submit", u.id, 20)) return res.status(429).json({ error: "Too many submissions. Try again in an hour." });
  const d = c.data || {};
  const replaces = String(req.body?.replaces || "");
  const members = u.team ? teamMembers(u).map((x) => ({ id: x.id, name: x.name, roll: x.roll })) : [];
  if (replaces) {
    const s = state.subs.find((x) => x.id === replaces && (x.userId === u.id || (u.team && x.classId === cls.id && sameTeam(x.team, u.team))));
    if (!s) return res.status(404).json({ error: "We could not find the idea you want to improve." });
    if (s.status !== "Needs change") return res.status(400).json({ error: "Only ideas marked Needs change can be improved and sent again." });
    if (s.classId !== cls.id) return res.status(400).json({ error: "That idea was sent to a different class." });
    (s.history ||= []).push({ round: s.round || 1, idea: s.idea, originality: s.originality, verdict: s.verdict, status: s.status, comment: s.comment, by: s.by || "", at: s.at });
    Object.assign(s, {
      checkId: c.id, idea: c.idea, tech: c.tech || "", level: c.level, time: c.time, at: Date.now(),
      originality: d.originality, verdict: d.verdict, difficulty: d.difficulty,
      status: "Pending", comment: "", by: "", decidedAt: null, data: d, round: (s.round || 1) + 1, members, sentBy: u.name,
      archiveOptIn:false, archiveConsentIds:[], archiveConsentAt:{}, archiveConsentRevokedAt:{}, archiveEmbedding:null,
    });
    setArchiveConsent(s,u.id,wantsArchive);
    if(s.archiveOptIn)s.archiveEmbedding=await embedText(c.idea);
    s.checkIds = [...(s.checkIds || []), c.id];
    backend.put("subs", s);
    return res.json({ submission: subInfo(s,u) });
  }
  const open = u.team ? state.subs.find((s) => s.classId === cls.id && sameTeam(s.team, u.team) && s.status !== "Rejected") : null;
  if (open) {
    return res.status(409).json({ error: open.status === "Needs change"
      ? "Your team's idea needs changes. Send your improved version with the option 'An improved version of'."
      : "Your team already sent an idea (" + open.status + "). A team sends one idea at a time." });
  }
  if (state.subs.length >= 5000) return res.status(507).json({ error: "The teacher's list is full." });
  const sub = {
    id: rid(6), checkId: c.id, checkIds: [c.id], userId: u.id, name: u.name, email: u.email, roll: u.roll,
    classId: cls.id, teacherId: cls.teacherId, batch: cls.name, team: u.team || "", members, sentBy: u.name, round: 1, history: [],
    idea: c.idea, tech: c.tech || "", level: c.level, time: c.time, at: Date.now(),
    originality: d.originality, verdict: d.verdict, difficulty: d.difficulty,
    status: "Pending", comment: "", data: d, archiveOptIn:false, archiveConsentIds:[], archiveConsentAt:{}, archiveConsentRevokedAt:{}, archiveEmbedding:null,
  };
  setArchiveConsent(sub,u.id,wantsArchive);
  if(sub.archiveOptIn)sub.archiveEmbedding=await embedText(c.idea);
  state.subs.push(sub);
  backend.put("subs", sub);
  res.json({ submission: subInfo(sub,u) });
});

app.patch("/api/my/submissions/:id/archive", needStudent, async (req, res) => {
  const u = req.user;
  const s = state.subs.find((x) => x.id === req.params.id && (x.userId === u.id || (u.team && x.classId === u.classId && sameTeam(x.team, u.team))));
  if (!s) return res.status(404).json({ error: "Not found." });
  if (typeof req.body?.archiveOptIn !== "boolean") return res.status(400).json({ error: "Choose whether to share the approved project anonymously." });
  if (req.body.archiveOptIn) {
    const cls = state.classes.find((x) => x.id === s.classId);
    if (!cls?.institutionId||!institutionHasPremium(state.institutions.find((i)=>i.id===cls.institutionId))) return res.status(400).json({ error: "Your institution pilot has ended. Ask the archive owner to activate a campus plan." });
  }
  setArchiveConsent(s,u.id,req.body.archiveOptIn);
  if (s.archiveOptIn && !s.archiveEmbedding) s.archiveEmbedding = await embedText(s.idea);
  if (!s.archiveOptIn) delete s.archiveEmbedding;
  backend.put("subs", s);
  res.json({ submission: subInfo(s,u), campusArchive: await campusArchiveMatches(u, s.idea) });
});

app.get("/api/my/submissions/:id/artifacts", needStudent, async (req, res) => {
  const u = req.user;
  const s = state.subs.find((x) => x.id === req.params.id && (x.userId === u.id || (u.team && x.classId === u.classId && sameTeam(x.team, u.team))));
  if (!s) return res.status(404).json({ error: "Not found." });
  if (s.status !== "Approved") return res.status(403).json({ error: "The roadmap and review materials are available after approval." });
  if (!Array.isArray(s.roadmap)) {
    try {
      const result = await gemini(`Create a practical ${s.time || "12-week"} student project roadmap for: ${s.idea}. Technologies: ${s.tech || "choose an appropriate student-friendly stack"}. Return JSON {"weeks":[{"week":1,"title":"short action","deliverable":"concrete output","checkpoint":"how to verify progress"}]} with one milestone per week, maximum 16 weeks. Include literature review, requirements, prototype, testing, evaluation and final presentation. Make it feasible for students.`, { temperature: 0.2 });
      const weeks = (Array.isArray(result.weeks) ? result.weeks : []).filter((x) => x && x.title).slice(0, 16);
      s.roadmap = weeks.length ? weeks : fallbackRoadmap();
    } catch {
      s.roadmap = fallbackRoadmap();
    }
    backend.put("subs", s);
  }
  const d = s.data || {}, evidence = d.evidence || {};
  const papers = (evidence.papers || []).slice(0, 12).map((p) => ({ title: p.title, url: p.url, year: p.year || "", citations: p.citationCount ?? null }));
  const savedLiterature=s.workspace?.literature||[];
  const literature=papers.map((p)=>{const old=savedLiterature.find((n)=>n.url===p.url)||{};return{...p,problem:old.problem||"",method:old.method||"",finding:old.finding||"",limitation:old.limitation||"",relevance:old.relevance||""}});
  for(const old of savedLiterature.filter((n)=>n.custom&&!literature.some((p)=>p.url===n.url)))literature.push(old);
  const dataSheet=s.workspace?.dataSheet||{source:"",permission:"",collection:"",variables:"",sampleTarget:"",privacy:"",validation:"",limitations:""};
  const dataPlan=[dataSheet.source&&"Source: "+dataSheet.source,dataSheet.variables&&"Fields: "+dataSheet.variables,dataSheet.validation&&"Validation: "+dataSheet.validation,dataSheet.limitations&&"Limitations: "+dataSheet.limitations].filter(Boolean);
  res.json({ project: { idea: s.idea, tech: s.tech || "", className: s.batch || "", team: s.team || "", approvedAt: s.decidedAt || s.at, comment: s.comment || "" }, roadmap: s.roadmap, literature: papers, slides: [
    { title: "Project proposal", bullets: [s.idea, "Team: " + (s.team || "Individual project"), "Class: " + (s.batch || "")] },
    { title: "Problem and motivation", bullets: d.weaknesses || [d.verdict_reason || "State the need and intended users", "Define the scope and constraints"] },
    { title: "Existing work", bullets: papers.slice(0, 4).map((p) => `${p.title}${p.year ? " (" + p.year + ")" : ""}`) },
    { title: "Literature review", bullets: (s.workspace?.literature || []).slice(0, 4).map((p) => `${p.title}: ${p.finding || "Add the main finding from this source"}`) },
    { title: "Proposed solution", bullets: d.uniqueness?.map((x) => x.unique) || [s.idea] },
    { title: "Technology and method", bullets: (d.tech_stack || []).map((x) => `${x.layer}: ${x.tool}`) },
    { title: "Data plan", bullets: dataPlan.length ? dataPlan : ["Describe data source, fields, permission, privacy and validation"] },
    { title: "Evaluation plan", bullets: ["Define measurable success criteria", "Test with representative users or data", "Report results, limits and next steps"] },
    { title: "Roadmap", bullets: s.roadmap.map((x) => `Week ${x.week}: ${x.title}`) },
    { title: "References and next steps", bullets: papers.slice(0, 4).map((p) => p.title).concat(["Review the linked sources and cite them in the final report."]) },
  ], progressReports:s.progressReports||[], workspace:{literature,dataSheet}, teacherFeedback:s.workspaceFeedback||"", workspaceFeedbackBy:s.workspaceFeedbackBy||"" });
});

const studentOwnsSubmission=(s,u)=>!!s&&(s.userId===u.id||(u.team&&s.classId===u.classId&&sameTeam(s.team,u.team)));
app.post("/api/my/submissions/:id/progress",needStudent,(req,res)=>{
  const u=req.user,s=state.subs.find((x)=>x.id===req.params.id&&studentOwnsSubmission(x,u));
  if(!s)return res.status(404).json({error:"Project not found."});
  if(s.status!=="Approved")return res.status(403).json({error:"Weekly reports are available after the teacher approves the idea."});
  if(tooMany("progress-report",u.id,12))return res.status(429).json({error:"You have sent several updates recently. Try again later."});
  const week=Number(req.body?.week),summary=clean(req.body?.summary,1600),deliverable=clean(req.body?.deliverable,1000),blockers=clean(req.body?.blockers,1000),next=clean(req.body?.next,1000),evidence=clean(req.body?.evidence,500);
  if(!Number.isInteger(week)||week<1||week>16)return res.status(400).json({error:"Choose a roadmap week between 1 and 16."});
  if(summary.length<10)return res.status(400).json({error:"Write at least a short sentence about this week’s progress."});
  if(evidence&&!/^https?:\/\//i.test(evidence))return res.status(400).json({error:"Evidence must be a web link beginning with http or https."});
  s.progressReports||=[];if(s.progressReports.length>=64)return res.status(507).json({error:"This project has reached its weekly update limit."});
  const report={id:rid(6),week,summary,deliverable,blockers,next,evidence,author:u.name,authorId:u.id,at:Date.now(),status:"Waiting for teacher",replies:[]};
  s.progressReports.push(report);backend.put("subs",s);res.json({ok:true,report});
});
app.post("/api/my/submissions/:id/workspace",needStudent,(req,res)=>{
  const u=req.user,s=state.subs.find((x)=>x.id===req.params.id&&studentOwnsSubmission(x,u));
  if(!s)return res.status(404).json({error:"Project not found."});
  if(s.status!=="Approved")return res.status(403).json({error:"Project worksheets are available after approval."});
  const d=req.body?.dataSheet||{},papers=(s.data?.evidence?.papers||[]).slice(0,12),input=Array.isArray(req.body?.literature)?req.body.literature:[];
  const literature=papers.map((p)=>{const n=input.find((x)=>clean(x?.url,500)===p.url)||{};return{title:clean(p.title,300),url:clean(p.url,500),custom:false,problem:clean(n.problem,1200),method:clean(n.method,1200),finding:clean(n.finding,1200),limitation:clean(n.limitation,1200),relevance:clean(n.relevance,1200)}});
  for(const n of input.filter((x)=>x?.custom).slice(0,12-literature.length)){const title=clean(n.title,300),url=clean(n.url,500);if(!title||!/^https?:\/\//i.test(url))return res.status(400).json({error:"Every added literature source needs a title and a valid http or https link."});if(literature.some((p)=>p.url===url))continue;literature.push({title,url,custom:true,problem:clean(n.problem,1200),method:clean(n.method,1200),finding:clean(n.finding,1200),limitation:clean(n.limitation,1200),relevance:clean(n.relevance,1200)})}
  const dataSheet={source:clean(d.source,1200),permission:clean(d.permission,1200),collection:clean(d.collection,1200),variables:clean(d.variables,1600),sampleTarget:clean(d.sampleTarget,500),privacy:clean(d.privacy,1200),validation:clean(d.validation,1200),limitations:clean(d.limitations,1200)};
  s.workspace={literature,dataSheet,savedAt:Date.now(),savedBy:u.name};backend.put("subs",s);res.json({ok:true,savedAt:s.workspace.savedAt});
});
app.post("/api/teacher/submissions/:id/progress/:reportId/reply",needTeacher,(req,res)=>{
  const s=findVisible(req.user,req.params.id);if(!s)return res.status(404).json({error:"Project not found."});
  const report=(s.progressReports||[]).find((x)=>x.id===req.params.reportId);if(!report)return res.status(404).json({error:"Progress update not found."});
  const message=clean(req.body?.message,1600),status=req.body?.status==="needs_update"?"Needs another update":"Reviewed";
  if(message.length<3)return res.status(400).json({error:"Write feedback so the students know what to do next."});
  report.replies||=[];report.replies.push({id:rid(5),teacher:req.user.name,message,status,at:Date.now()});report.status=status;backend.put("subs",s);res.json({ok:true});
});
app.post("/api/teacher/submissions/:id/workspace-feedback",needTeacher,(req,res)=>{
  const s=findVisible(req.user,req.params.id);if(!s)return res.status(404).json({error:"Project not found."});
  const feedback=clean(req.body?.feedback,1600);if(feedback.length<3)return res.status(400).json({error:"Write feedback for the project worksheets."});
  s.workspaceFeedback=feedback;s.workspaceFeedbackBy=req.user.name;s.workspaceFeedbackAt=Date.now();backend.put("subs",s);res.json({ok:true});
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
async function embedText(text) {
  if (!GEMINI || !text) return null;
  try {
    const r = await fetch(`${process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com"}/v1beta/models/${encodeURIComponent(process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001")}:embedContent?key=${GEMINI}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text: String(text).slice(0, 8000) }] }, outputDimensionality: 768 }),
    });
    if (!r.ok) return null;
    const values = (await r.json()).embedding?.values;
    return Array.isArray(values) && values.length ? values : null;
  } catch { return null; }
}
async function campusArchiveMatches(user, idea) {
  if (user?.role !== "student") return null;
  const studentClass = state.classes.find((c) => c.id === user.classId);
  const institutionId = studentClass?.institutionId;
  if (!institutionId) return { enabled: false, total: 0, projects: [] };
  const institution=state.institutions.find((x)=>x.id===institutionId);
  if(!institutionHasPremium(institution))return {enabled:false,total:0,projects:[]};
  const classById = new Map(state.classes.filter((c) => c.institutionId === institutionId).map((c) => [c.id, c]));
  const approved = state.subs.filter((s) => s.status === "Approved" && s.archiveOptIn === true && classById.has(s.classId)
    && s.userId !== user.id && !(user.team && s.classId === user.classId && sameTeam(s.team, user.team)));
  if (!approved.length) return { enabled: true, total: 0, matching: "semantic", projects: [] };
  const query = words(idea);
  const queryEmbedding = await embedText(idea);
  const projects = approved.map((s) => {
    const semantic = cosineSimilarity(queryEmbedding, s.archiveEmbedding);
    const score = semantic ?? overlap(query, words(s.idea));
    return { idea: s.idea, tech: s.tech || "", className: classById.get(s.classId)?.name || "", similarity: Math.round(score * 100), score, matchType: semantic === null ? "keyword" : "semantic", threshold: semantic === null ? 0.15 : 0.55 };
  }).filter((s) => s.score >= s.threshold).sort((a, b) => b.score - a.score).slice(0, 5)
    .map(({ idea: projectIdea, tech, className, similarity, matchType }) => ({ idea: projectIdea, tech, className, similarity, matchType }));
  return { enabled: true, total: approved.length, matching: queryEmbedding ? "semantic" : "keyword", projects };
}
// Ideas in the same class that share many words. A pointer for the teacher, not proof.
function similarFor(list) {
  const toks = list.map((s) => words(s.idea));
  return list.map((s, i) => {
    const found = [];
    list.forEach((o, j) => {
      if (i === j || !s.classId || o.classId !== s.classId || o.userId === s.userId || sameTeam(o.team, s.team)) return;
      const p = overlap(toks[i], toks[j]);
      if (p >= 0.35) found.push({ id: o.id, name: o.name, roll: o.roll, idea: o.idea, pct: Math.round(p * 100) });
    });
    return found.sort((x, y) => y.pct - x.pct).slice(0, 3);
  });
}
const visibleSubs = (u) => state.subs.filter((s) => s.teacherId === u.id);
const findVisible = (u, id) => visibleSubs(u).find((x) => x.id === id);

app.get("/teacher", (req, res) => {
  if (!req.user) return res.redirect("/teacher/login");
  if (req.user.role !== "teacher") return res.redirect("/");
  if(!req.user.termsAcceptedAt)return res.redirect("/consent");
  res.sendFile(path.join(PUBLIC, "teacher.html"));
});

const ownClass = (u, id) => state.classes.find((c) => c.id === id && c.teacherId === u.id);
const studentOf = (u, id) => {
  const st = state.users.find((x) => x.id === id && x.role === "student");
  const c = st && state.classes.find((k) => k.id === st.classId);
  return c && c.teacherId === u.id ? st : null;
};

app.get("/api/teacher/classes", needTeacher, (req, res) => {
  res.json(state.classes.filter((c) => c.teacherId === req.user.id).map((c) => ({
    id: c.id, name: c.name, at: c.at,
    teacher: (state.users.find((u) => u.id === c.teacherId) || {}).name || "",
    students: state.users.filter((u) => u.role === "student" && u.classId === c.id).length,
    ideas: state.subs.filter((s) => s.classId === c.id).length,
  })).sort((a, b) => b.at - a.at));
});

app.post("/api/teacher/classes", needTeacher, (req, res) => {
  const year=clean(req.body?.year,20),branch=clean(req.body?.branch,60),section=clean(req.body?.section,20);
  const cohortMode=!!(year||branch||section);
  const name=cohortMode?clean([branch,year,section].join(" "),60):clean(req.body?.name,60);
  if(cohortMode&&(!year||!branch||!section))return res.status(400).json({error:"Choose a year and enter a branch and section."});
  if (!name) return res.status(400).json({ error: "Choose a year, branch and section." });
  const existingCohort=cohortMode?state.classes.find((c)=>academicClassKey(c.name)===academicClassKey(name)):null;
  if(existingCohort&&existingCohort.teacherId!==req.user.id)return res.status(409).json({error:"This year, branch and section are already connected to another teacher."});
  if(existingCohort){
    const pending=state.users.filter((u)=>u.role==="student"&&!u.classId&&academicClassKey([u.branch,u.year,u.section].join(" "))===academicClassKey(name));
    const instId=existingCohort.institutionId,inst=instId?state.institutions.find((x)=>x.id===instId):null,existingPlan=institutionPlan(inst);
    if(existingPlan?.type==="per_student"){
      const current=state.users.filter((u)=>u.role==="student"&&state.classes.some((c)=>c.id===u.classId&&c.institutionId===instId)).length;
      if(current+pending.length>existingPlan.seats)return res.status(409).json({error:"This group has more students than the college plan’s remaining seats. Ask the archive owner to add seats."});
    }
    existingCohort.year=year;existingCohort.branch=branch;existingCohort.section=section;backend.put("classes",existingCohort);
    pending.forEach((u)=>{u.classId=existingCohort.id;backend.put("users",u)});
    return res.json({id:existingCohort.id,name:existingCohort.name});
  }
  if (state.classes.some((c) => c.teacherId === req.user.id && c.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "You already have a class with that name." });
  if (state.classes.length >= 500) return res.status(507).json({ error: "Too many classes." });
  const cohortStudents=cohortMode?state.users.filter((u)=>u.role==="student"&&!u.classId&&academicClassKey([u.branch,u.year,u.section].join(" "))===academicClassKey(name)):[];
  const institutionId=req.user.institutionId||null,institution=institutionId?state.institutions.find((x)=>x.id===institutionId):null,plan=institutionPlan(institution);
  if(cohortMode&&plan?.type==="per_student"){
    const current=state.users.filter((u)=>u.role==="student"&&state.classes.some((c)=>c.id===u.classId&&c.institutionId===institutionId)).length;
    if(current+cohortStudents.length>plan.seats)return res.status(409).json({error:"This group has more students than the college plan’s remaining seats. Ask the archive owner to add seats."});
  }
  const cls = { id: rid(5), name, year:cohortMode?year:"", branch:cohortMode?branch:"", section:cohortMode?section:"", teacherId: req.user.id, institutionId: req.user.institutionId || null, at: Date.now() };
  state.classes.push(cls);
  backend.put("classes", cls);
  cohortStudents.forEach((u)=>{u.classId=cls.id;backend.put("users",u)});
  res.json({ id: cls.id, name: cls.name });
});

app.get("/api/teacher/classes/:id/students", needTeacher, (req, res) => {
  const cls = ownClass(req.user, req.params.id);
  if (!cls) return res.status(404).json({ error: "Not found." });
  res.json(state.users.filter((u) => u.role === "student" && u.classId === cls.id).sort((a, b) => a.roll.localeCompare(b.roll, undefined, { numeric: true })).map((u) => ({
    id: u.id, roll: u.roll, name: u.name, email: u.email || "", team: u.team || "", firstLoginDone: !u.mustChange,
    ideas: state.subs.filter((s) => s.userId === u.id).length,
  })));
});

// One line per student: roll number, name, then optionally a team name and an email. Pasting from Excel works too.
app.post("/api/teacher/classes/:id/students", needTeacher, async (req, res) => {
  try {
    const cls = ownClass(req.user, req.params.id);
    if (!cls) return res.status(404).json({ error: "Not found." });
    const rows = parseRoster(req.body?.text);
    if (!rows.length) return res.status(400).json({ error: "Type one student per line: roll number, then name." });
    const out = [];
    for (const r of rows) {
      const loginId = r.roll.toLowerCase();
      if (!/^[A-Za-z0-9._\-\/]{1,40}$/.test(r.roll)) { out.push({ roll: r.roll, name: r.name, result: "Skipped: the roll number can use letters, numbers and - . _ / only" }); continue; }
      const old = state.users.find((x) => x.role === "student" && x.loginId === loginId);
      if (old) {
        if (old.classId !== cls.id) { out.push({ roll: r.roll, name: r.name || old.name, result: "Skipped: this roll number is used in another class" }); continue; }
        if (r.team && r.team !== old.team) { old.team = r.team; backend.put("users", old); out.push({ roll: r.roll, name: old.name, result: "Already in this class. Team updated" }); }
        else out.push({ roll: r.roll, name: r.name || old.name, result: "Already in this class" });
        continue;
      }
      const capacityError=studentCapacityError(cls.id);if(capacityError){out.push({roll:r.roll,name:r.name,result:"Skipped: "+capacityError});continue;}
      if (r.email && !EMAIL.test(r.email)) r.email = "";
      const pwd = tempPassword();
      const u = { id: rid(8), role: "student", name: r.name || r.roll, email: r.email, emailVerified: true, roll: r.roll, team: r.team || "", loginId, classId: cls.id, pw: await hashPw(pwd), mustChange: true, at: Date.now(), createdBy: req.user.id };
      state.users.push(u);
      backend.put("users", u);
      let result="Created";
      out.push({ roll: r.roll, name: u.name, result, tempPassword: pwd });
    }
    res.json({ results: out });
  } catch (e) {
    res.status(500).json({ error: "Could not create the accounts. Please try again." });
  }
});

app.post("/api/teacher/students/:id/reset", needTeacher, async (req, res) => {
  const st = studentOf(req.user, req.params.id);
  if (!st) return res.status(404).json({ error: "Not found." });
  const pwd = tempPassword();
  st.pw = await hashPw(pwd);
  st.mustChange = true;
  backend.put("users", st);
  res.json({ roll: st.roll, name: st.name, tempPassword: pwd });
});

app.patch("/api/teacher/students/:id/team", needTeacher, (req, res) => {
  const st = studentOf(req.user, req.params.id);
  if (!st) return res.status(404).json({ error: "Not found." });
  st.team = clean(req.body?.team, 40);
  backend.put("users", st);
  res.json({ team: st.team });
});

app.delete("/api/teacher/students/:id", needTeacher, (req, res) => {
  const st = studentOf(req.user, req.params.id);
  if (!st) return res.status(404).json({ error: "Not found." });
  state.users = state.users.filter((x) => x !== st);
  backend.del("users", st.id);
  const mine = state.checks.filter((c) => c.userId === st.id); // sent ideas stay with the teacher; the student's saved checks go
  state.checks = state.checks.filter((c) => !mine.includes(c));
  mine.forEach((c) => backend.del("checks", c.id));
  res.json({ ok: true });
});

app.get("/api/teacher/submissions", needTeacher, (req, res) => {
  const list = visibleSubs(req.user);
  const sim = similarFor(list);
  res.json(list.map((s, i) => ({
    id: s.id, name: s.name, email: s.email, roll: s.roll, batch: s.batch, classId: s.classId || null, team: s.team || "", members: s.members || [], idea: s.idea, tech: s.tech, at: s.at,
    originality: s.originality, verdict: s.verdict, difficulty: s.difficulty, status: s.status, comment: s.comment, by: s.by || "",
    round: s.round || 1, before: s.history?.length ? s.history[s.history.length - 1].originality : null, aiAlignment: s.aiAlignment || "unrated", archiveOptIn: s.archiveOptIn === true, progressWaiting:(s.progressReports||[]).filter((r)=>r.status==="Waiting for teacher"||r.status==="Needs another update").length, similar: sim[i],
  })).reverse());
});

app.get("/api/teacher/submissions/:id", needTeacher, (req, res) => {
  const list = visibleSubs(req.user);
  const i = list.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Not found." });
  res.json({ ...list[i], similar: similarFor(list)[i] });
});

app.patch("/api/teacher/submissions/:id", needTeacher, (req, res) => {
  const s = findVisible(req.user, req.params.id);
  if (!s) return res.status(404).json({ error: "Not found." });
  const status = String(req.body?.status || "");
  if (!["Pending", "Approved", "Needs change", "Rejected"].includes(status)) return res.status(400).json({ error: "Pick a decision." });
  const comment = clean(req.body?.comment, 500);
  if ((status === "Needs change" || status === "Rejected") && comment.length < 3) return res.status(400).json({ error: "Write a short comment so the student knows what to do next." });
  const aiAlignment = String(req.body?.aiAlignment || "unrated");
  if (!["unrated", "aligned", "partly", "not_aligned"].includes(aiAlignment)) return res.status(400).json({ error: "Pick a valid AI agreement rating." });
  s.status = status;
  s.comment = comment;
  s.aiAlignment = aiAlignment;
  s.by = req.user.name;
  s.decidedAt = Date.now();
  backend.put("subs", s);
  res.json({ ok: true });
});

app.delete("/api/teacher/submissions/:id", needTeacher, (req, res) => {
  const s = findVisible(req.user, req.params.id);
  if (!s) return res.status(404).json({ error: "Not found." });
  state.subs = state.subs.filter((x) => x !== s);
  backend.del("subs", s.id);
  res.json({ ok: true });
});

// ---------- Topic overview ----------
const TOPIC_STOP = new Set(["management", "application", "applications", "smart", "automated", "automatic", "intelligent", "online", "mobile", "website", "platform", "software", "solution", "android", "portal", "framework", "development", "implementation", "design", "with", "without"]);
const stem = (w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const topicWords = (idea) => new Set([...words(idea)].map(stem).filter((w) => !TOPIC_STOP.has(w) && w.length > 2));

// Groups ideas that share a main word, counting a team once. Words only, so it is a quick pointer and not an exact grouping.
function topicsFor(list) {
  const key = (s) => (s.team ? s.classId + ":" + s.team.toLowerCase() : "u:" + s.userId);
  const info = list.map((s) => ({ s, k: key(s), w: topicWords(s.idea) }));
  const byWord = new Map();
  for (const it of info) for (const w of it.w) { if (!byWord.has(w)) byWord.set(w, []); byWord.get(w).push(it); }
  const cand = [...byWord.entries()]
    .map(([w, arr]) => ({ w, arr, units: new Set(arr.map((x) => x.k)).size }))
    .filter((c) => c.units >= 2)
    .sort((a, b) => b.units - a.units || b.arr.length - a.arr.length || a.w.localeCompare(b.w));
  const used = new Set(), topics = [];
  for (const c of cand) {
    const ids = [...new Set(c.arr.map((x) => x.s.id))];
    if (ids.filter((id) => used.has(id)).length / ids.length >= 0.7) continue; // the same ideas as an earlier topic
    ids.forEach((id) => used.add(id));
    const co = new Map();
    for (const x of c.arr) for (const w of x.w) if (w !== c.w) co.set(w, (co.get(w) || 0) + 1);
    const label = [c.w, ...[...co.entries()].filter(([, n]) => n / c.arr.length >= 0.6).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w]) => w)].join(" + ");
    const ideas = c.arr.map((x) => ({
      id: x.s.id, idea: x.s.idea, who: x.s.team || x.s.name, className: x.s.batch || "", originality: x.s.originality, status: x.s.status,
    })).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
    topics.push({ label, word: c.w, units: c.units, count: ideas.length, avg: Math.round(ideas.reduce((t, x) => t + (Number(x.originality) || 0), 0) / ideas.length), ideas });
    if (topics.length >= 12) break;
  }
  return { topics, alone: list.filter((s) => !used.has(s.id)).length, units: new Set(list.map(key)).size };
}

app.get("/api/teacher/topics", needTeacher, (req, res) => {
  const list = visibleSubs(req.user);
  const t = topicsFor(list);
  const buckets = [0, 0, 0, 0, 0];
  const verdicts = { build: 0, change: 0, drop: 0 };
  for (const s of list) {
    buckets[Math.min(4, Math.floor((Number(s.originality) || 0) / 20))]++;
    if (s.verdict === "BUILD") verdicts.build++; else if (s.verdict === "CHANGE IT") verdicts.change++; else verdicts.drop++;
  }
  res.json({
    total: list.length, units: t.units, alone: t.alone, topics: t.topics, buckets, verdicts,
    avg: list.length ? Math.round(list.reduce((a, s) => a + (Number(s.originality) || 0), 0) / list.length) : 0,
  });
});

app.get("/api/teacher/institution/analytics", needTeacher, (req, res) => {
  const inst = institutionFor(req.user);
  if (!inst) return res.status(404).json({ error: "Join or create a college archive first." });
  if(!institutionHasPremium(inst))return res.status(402).json({error:"The free pilot has ended. Activate a campus plan to use department analytics."});
  const classIds = new Set(state.classes.filter((c) => c.institutionId === inst.id).map((c) => c.id));
  const list = state.subs.filter((s) => classIds.has(s.classId));
  const revised = list.filter((s) => (s.history || []).length > 0);
  const before = revised.map((s) => Number(s.history.at(-1).originality)).filter(Number.isFinite);
  const after = revised.map((s) => Number(s.originality)).filter(Number.isFinite);
  res.json({ institution: inst.name, classes: classIds.size, ideas: list.length, approved: list.filter((s) => s.status === "Approved").length, revised: revised.length,
    avgOriginality: list.length ? Math.round(list.reduce((n,s)=>n+(Number(s.originality)||0),0)/list.length) : 0,
    averageGain: before.length && before.length === after.length ? Math.round(after.reduce((n,x,i)=>n+x-before[i],0)/after.length) : null,
    aiRated: list.filter((s) => ["aligned","partly","not_aligned"].includes(s.aiAlignment)).length,
    aiAligned: list.filter((s) => s.aiAlignment === "aligned").length,
    status: Object.fromEntries(["Pending","Approved","Needs change","Rejected"].map((x)=>[x,list.filter((s)=>s.status===x).length])),
  });
});

app.get("/api/teacher/institution/accreditation.csv", needTeacher, (req, res) => {
  const inst = institutionFor(req.user);
  if (!inst) return res.status(404).send("Join or create a college archive first.");
  if(!institutionHasPremium(inst))return res.status(402).send("The free pilot has ended. Activate a campus plan to export accreditation evidence.");
  const classById = new Map(state.classes.filter((c) => c.institutionId === inst.id).map((c) => [c.id, c]));
  const rows = [["Institution","Department or class","Project reference","Project title","Status","Submitted on","Decision on","Originality score","Previous score","Score change","AI agreement","Review round","Anonymous archive consent"]];
  state.subs.filter((s) => classById.has(s.classId)).forEach((s) => {
    const prev = s.history?.length ? Number(s.history.at(-1).originality) : "";
    rows.push([inst.name,classById.get(s.classId)?.name || "",s.id,s.idea,s.status,new Date(s.at).toISOString(),s.decidedAt?new Date(s.decidedAt).toISOString():"",s.originality,prev,prev===""?"":Number(s.originality)-prev,s.aiAlignment || "Not rated",s.round || 1,s.archiveOptIn?"Yes":"No"]);
  });
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  res.set({ "Content-Type":"text/csv; charset=utf-8", "Content-Disposition":"attachment; filename=ideaforge-accreditation.csv" }).send("\ufeff"+csv);
});

// ---------- Approval letter ----------
app.get("/letter", (req, res) => (req.user ? res.sendFile(path.join(PUBLIC, "letter.html")) : res.redirect("/student")));
app.get("/review-pack", needStudent, (req, res) => res.sendFile(path.join(PUBLIC, "review-pack.html")));
app.get("/api/letter/:id", needUser, (req, res) => {
  const u = req.user, s = state.subs.find((x) => x.id === req.params.id);
  const mine = s && (u.role === "teacher" ? s.teacherId === u.id : s.userId === u.id || (u.team && s.classId === u.classId && sameTeam(s.team, u.team)));
  if (!mine) return res.status(404).json({ error: "Not found." });
  if (s.status !== "Approved") return res.status(400).json({ error: "The letter is available after the idea is approved." });
  const cls = state.classes.find((c) => c.id === s.classId), t = cls && state.users.find((x) => x.id === cls.teacherId);
  res.json({
    ref: s.id.toUpperCase(), idea: s.idea, tech: s.tech || "", team: s.team || "", className: s.batch || "",
    members: (s.members && s.members.length ? s.members : [{ name: s.name, roll: s.roll }]).map((m) => ({ name: m.name, roll: m.roll })),
    teacher: s.by || (t ? t.name : ""), approvedAt: s.decidedAt || s.at, comment: s.comment || "",
    originality: s.originality, verdict: s.verdict, difficulty: s.difficulty, level: s.level, time: s.time, round: s.round || 1,
  });
});

async function captureException(error, req) {
  const raw = process.env.SENTRY_DSN;
  if (!raw) return;
  try {
    const d = new URL(raw), project = d.pathname.split("/").filter(Boolean).at(-1), key = decodeURIComponent(d.username);
    if (!project || !key) return;
    const prefix = d.pathname.slice(0, d.pathname.lastIndexOf("/"));
    const id = crypto.randomBytes(16).toString("hex"), stack = String(error?.stack || "").split("\n").slice(1).reverse().map((line) => ({ function: line.trim(), filename: line.trim().slice(0, 200) }));
    const event = { event_id:id, timestamp:new Date().toISOString(), platform:"node", level:"error", exception:{values:[{type:String(error?.name||"Error").slice(0,80),value:String(error?.message||"Unexpected error").replace(/(AIza[\w-]{20,}|Bearer\s+\S+)/g,"[redacted]").slice(0,500),stacktrace:{frames:stack}}]}, tags:req?{method:req.method,path:req.path}:{} };
    const envelope=[{event_id:id,sent_at:new Date().toISOString(),dsn:raw},{type:"event"},event].map((x)=>JSON.stringify(x)).join("\n");
    await fetch(`${d.origin}${prefix}/api/${project}/envelope/`,{method:"POST",headers:{"Content-Type":"application/x-sentry-envelope","X-Sentry-Auth":`Sentry sentry_version=7, sentry_client=ideaforge-x/1, sentry_key=${key}`},body:envelope});
  } catch (e) { console.log("Error-monitoring delivery failed:",e.message); }
}

app.use((err, req, res, next) => {
  console.error("Request error:", req.method, req.path, err?.message || err);
  captureException(err, req);
  if (res.headersSent) return next(err);
  res.status(500).json({ error:"Something went wrong. The error was recorded for the site operator." });
});
process.on("unhandledRejection", (reason) => { const e=reason instanceof Error?reason:new Error(String(reason));console.error("Unhandled rejection:",e.message);captureException(e); });
process.on("uncaughtException", (error) => { console.error("Uncaught exception:",error.message);captureException(error).finally(()=>process.exit(1)); });

// Brings older data up to date. The old admin role is gone: that account is now an ordinary teacher.
async function migrate() {
  const seen = new Set();
  for (const u of state.users) {
    let changed = false;
    if (u.role === "teacher") {
      if (u.admin !== undefined) { delete u.admin; changed = true; }
      if (!u.status || u.status === "pending") { u.status = "approved"; changed = true; }
    }
    if (u.role === "student" && (!u.status || u.status === "pending")) { u.status = "approved"; changed = true; } // student approval was removed
    if (u.emailVerified !== true) { u.emailVerified = true; changed = true; }
    if (!u.loginId) { u.loginId = u.role === "teacher" ? u.email : String(u.roll || u.email || u.id).toLowerCase(); changed = true; }
    if (seen.has(u.role + u.loginId)) { u.loginId = u.loginId + "-" + u.id.slice(0, 3); changed = true; }
    seen.add(u.role + u.loginId);
    if (changed) backend.put("users", u);
  }
  // Emergency: a teacher who forgot the password and has no recovery question. Set both lines in .env, restart once, then delete them.
  const resetEmail = (process.env.RESET_EMAIL || "").trim().toLowerCase();
  if (resetEmail && process.env.RESET_PASSWORD) {
    const a = state.users.find((u) => u.role === "teacher" && u.email === resetEmail);
    if (a) {
      a.pw = await hashPw(process.env.RESET_PASSWORD);
      a.mustChange = true;
      a.status = "approved";
      backend.put("users", a);
      console.log("The password for " + resetEmail + " was reset from RESET_PASSWORD. Remove RESET_EMAIL and RESET_PASSWORD now, or it will reset again at every restart.");
    } else console.log("RESET_EMAIL is set, but no teacher has that email.");
  }
  for (const u of state.users) { if (u.emailVerified !== true || u.emailTokenHash || u.emailTokenExpiry) { u.emailVerified=true;delete u.emailTokenHash;delete u.emailTokenExpiry;backend.put("users",u); } }
  for (const s of state.subs) {
    let changed = false;
    if (!s.checkIds) { s.checkIds = [s.checkId]; changed = true; }
    if (!s.round) { s.round = 1; changed = true; }
    if (!s.history) { s.history = []; changed = true; }
    if (s.classId === undefined) { s.classId = null; s.teacherId = null; changed = true; }
    if(!Array.isArray(s.archiveConsentIds)){
      if(s.archiveOptIn&&s.team){s.archiveOptIn=false;delete s.archiveEmbedding}
      s.archiveConsentIds=s.archiveOptIn&&s.userId?[s.userId]:[];
      s.archiveConsentAt=s.archiveOptIn&&s.userId?{[s.userId]:typeof s.archiveConsentAt==="number"?s.archiveConsentAt:s.at}:{};
      s.archiveConsentRevokedAt={};changed=true;
    }
    if (changed) backend.put("subs", s);
  }
  for(const inst of state.institutions){if(!inst.pilotExpiresAt){inst.pilotExpiresAt=Date.now()+(Number(process.env.FREE_PILOT_DAYS)||90)*864e5;backend.put("institutions",inst)}}
}

await initStorage();
await migrate();
app.listen(process.env.PORT || 3000, () => console.log("IdeaForge-X on http://localhost:" + (process.env.PORT || 3000)));
