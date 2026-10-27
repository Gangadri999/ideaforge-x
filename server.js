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
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'",
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
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
    `${process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com"}/v1beta/models/${model}:generateContent?key=${GEMINI}`,
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

// Each search returns null when the service did not answer, and a list (maybe empty) when it did.
async function searchArxiv(q) {
  const r = await fetch(`${process.env.ARXIV_URL || "http://export.arxiv.org/api/query"}?search_query=all:${encodeURIComponent(q)}&max_results=5&sortBy=relevance`);
  if (!r.ok) return null;
  const xml = await r.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
    title: (m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").replace(/\s+/g, " ").trim(),
    url: m[1].match(/<id>(.*?)<\/id>/)?.[1],
    year: m[1].match(/<published>(\d{4})/)?.[1],
  }));
}

async function searchScholar(q) {
  const r = await fetch(`${process.env.SCHOLAR_URL || "https://api.semanticscholar.org/graph/v1/paper/search"}?query=${encodeURIComponent(q)}&limit=5&fields=title,year,url,citationCount`);
  if (!r.ok) return null;
  return (await r.json()).data || [];
}

// OpenAlex is free and covers a very large number of papers.
async function searchOpenAlex(q) {
  const mail = process.env.OPENALEX_EMAIL ? "&mailto=" + encodeURIComponent(process.env.OPENALEX_EMAIL) : "";
  const r = await fetch(`${process.env.OPENALEX_URL || "https://api.openalex.org/works"}?search=${encodeURIComponent(q)}&per_page=5${mail}`);
  if (!r.ok) return null;
  const j = await r.json();
  return (j.results || [])
    .map((w) => ({ title: w.display_name || w.title || "", url: w.doi || w.id, year: w.publication_year, citationCount: w.cited_by_count }))
    .filter((p) => p.title && p.url);
}

async function searchGithub(q) {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(
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
const state = { users: [], checks: [], subs: [], classes: [] };
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
      for (const c of ["users", "checks", "subs", "classes"]) {
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
      state.users = []; state.checks = []; state.subs = []; state.classes = [];
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
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase(); // the first admin teacher is created from these two settings
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
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
  return {
    id: u.id, name: u.name, email: u.email || "", role: u.role, roll: u.roll || "", loginId: u.loginId || "",
    status: u.status || "approved", admin: !!u.admin, mustChange: !!u.mustChange, team: u.team || "",
    cls: c ? { id: c.id, name: c.name, teacher: t ? t.name : "" } : null,
  };
};
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
// A new account must set its own password before anything else works.
app.use((req, res, next) => {
  if (req.user?.mustChange && req.path.startsWith("/api/") && !["/api/me", "/api/auth/change-password", "/api/auth/logout"].includes(req.path)) {
    return res.status(403).json({ error: "Please set a new password first.", mustChange: true });
  }
  next();
});
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Please log in first." }));
const needStudent = (req, res, next) => (!req.user ? res.status(401).json({ error: "Please log in first." }) : req.user.role !== "student" ? res.status(403).json({ error: "Only students can send ideas to a teacher." }) : next());
const needTeacher = (req, res, next) =>
  !req.user ? res.status(401).json({ error: "Please log in first." })
  : req.user.role !== "teacher" ? res.status(403).json({ error: "Teachers only." })
  : (req.user.status || "approved") !== "approved" ? res.status(403).json({ error: "This teacher account is turned off. Ask the site admin." })
  : next();
const needAdmin = (req, res, next) => needTeacher(req, res, () => (req.user.admin ? next() : res.status(403).json({ error: "Only the site admin can do this." })));

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/;
const PW_CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const tempPassword = () => Array.from({ length: 8 }, () => PW_CHARS[crypto.randomInt(PW_CHARS.length)]).join("");

// Student and teacher have separate logins. Accounts are made by the teacher (students) or the admin (teachers), never by sign-up.
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
    if (u.role === "teacher" && (u.status || "approved") !== "approved") return res.status(403).json({ error: "This teacher account is turned off. Ask the site admin." });
    fails.delete("e" + portal + id);
    startSession(req, res, u);
    res.json({ user: publicUser(u), next: u.role === "teacher" ? "/teacher" : "/", mustChange: !!u.mustChange });
  } catch (e) {
    res.status(500).json({ error: "Could not log in. Please try again." });
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
app.get("/student", (req, res) => res.sendFile(path.join(PUBLIC, "student-login.html")));
app.get("/teacher/login", (req, res) => res.sendFile(path.join(PUBLIC, "teacher-login.html")));
app.get("/login", (req, res) => res.redirect("/student"));

app.post("/api/analyze", async (req, res) => {
  try {
    const { idea, level = "final-year student", time = "4 months", budget = "", currency = "INR", tech = "" } = req.body;
    if (!idea || idea.length < 8) return res.status(400).json({ error: "Describe your idea first." });
    if (!GEMINI) return res.status(500).json({ error: "Set GEMINI_API_KEY in .env" });

    const key = keyOf({ idea: idea.trim().replace(/\s+/g, " "), level, time, budget, currency, tech, DROP_AT, BUILD_AT });
    const hit = cache[key];
    if (hit && !req.body.fresh && Date.now() - hit.at < 7 * 864e5) return res.json({ ...hit.data, cached: true, checkId: req.user ? addCheck(req.user, { idea, tech, level, time, budget, currency }, hit.data) : undefined });

    if (LIMITS_ON) {
      if (!req.user && tooMany("guest", req.ip, 3)) return res.status(429).json({ error: "Guests can run 3 checks an hour. Students and teachers who log in get more." });
      const why = limitReached(req.user ? req.user.id : "g" + req.ip);
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
        const [arxiv, scholar, openalex, github] = await Promise.all([safe(searchArxiv(q)), safe(searchScholar(q)), safe(searchOpenAlex(q)), safe(searchGithub(q))]);
        return { q, arxiv, scholar, openalex, github };
      })
    );
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
      papers,
      sources: { openAlex: answered("openalex"), semanticScholar: answered("scholar"), arxiv: answered("arxiv"), github: answered("github") },
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
    res.json({ ...result, checkId: req.user ? addCheck(req.user, { idea, tech, level, time, budget, currency }, result) : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Student: my checks and sending to a teacher ----------
const submissionOf = (checkId) => state.subs.find((x) => (x.checkIds || [x.checkId]).includes(checkId));
const subInfo = (x) => (x ? { id: x.id, status: x.status, comment: x.comment, round: x.round || 1, idea: x.idea, latest: x.checkId } : null);

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

const sameTeam = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const teamMembers = (u) => (u.team ? state.users.filter((x) => x.role === "student" && x.classId === u.classId && sameTeam(x.team, u.team)) : [u]);

app.get("/api/my/team", needStudent, (req, res) => {
  const u = req.user;
  if (!u.team || !u.classId) return res.json({ team: "", members: [], submission: null });
  const subs = state.subs.filter((s) => s.classId === u.classId && sameTeam(s.team, u.team)).sort((a, b) => b.at - a.at);
  res.json({ team: u.team, members: teamMembers(u).map((x) => ({ name: x.name, roll: x.roll })), submission: subs[0] ? subInfo(subs[0]) : null });
});

app.post("/api/submit", needStudent, (req, res) => {
  const u = req.user;
  const cls = u.classId ? state.classes.find((x) => x.id === u.classId) : null;
  if (!cls) return res.status(400).json({ error: "Your teacher has not added you to a class yet." });
  const c = state.checks.find((x) => x.id === String(req.body?.checkId || "") && x.userId === u.id);
  if (!c) return res.status(404).json({ error: "We could not find that check. Check your idea again, then send it." });
  const already = submissionOf(c.id);
  if (already) return res.json({ submission: subInfo(already) });
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
    });
    s.checkIds = [...(s.checkIds || []), c.id];
    backend.put("subs", s);
    return res.json({ submission: subInfo(s) });
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
const visibleSubs = (u) => (u.admin ? state.subs : state.subs.filter((s) => s.teacherId === u.id));
const findVisible = (u, id) => visibleSubs(u).find((x) => x.id === id);

app.get("/teacher", (req, res) => {
  if (!req.user) return res.redirect("/teacher/login");
  if (req.user.role !== "teacher") return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "teacher.html"));
});

const ownClass = (u, id) => state.classes.find((c) => c.id === id && (u.admin || c.teacherId === u.id));
const studentOf = (u, id) => {
  const st = state.users.find((x) => x.id === id && x.role === "student");
  const c = st && state.classes.find((k) => k.id === st.classId);
  return c && (u.admin || c.teacherId === u.id) ? st : null;
};

app.get("/api/teacher/classes", needTeacher, (req, res) => {
  res.json(state.classes.filter((c) => req.user.admin || c.teacherId === req.user.id).map((c) => ({
    id: c.id, name: c.name, at: c.at,
    teacher: (state.users.find((u) => u.id === c.teacherId) || {}).name || "",
    students: state.users.filter((u) => u.classId === c.id).length,
    ideas: state.subs.filter((s) => s.classId === c.id).length,
  })).sort((a, b) => b.at - a.at));
});

app.post("/api/teacher/classes", needTeacher, (req, res) => {
  const name = clean(req.body?.name, 60);
  if (!name) return res.status(400).json({ error: "Give the class a name, like CSE 4th year A." });
  if (state.classes.some((c) => c.teacherId === req.user.id && c.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: "You already have a class with that name." });
  if (state.classes.length >= 500) return res.status(507).json({ error: "Too many classes." });
  const cls = { id: rid(5), name, teacherId: req.user.id, at: Date.now() };
  state.classes.push(cls);
  backend.put("classes", cls);
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
function parseRoster(text) {
  const rows = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const p = l.split(/\t|,|;/).map((x) => x.trim());
    let team = "", email = "";
    for (const x of [p[2] || "", p[3] || ""]) {
      if (/@/.test(x)) email = clean(x, 120).toLowerCase();
      else if (x) team = clean(x, 40);
    }
    return { roll: clean(p[0], 40), name: clean(p[1] || "", 80), team, email };
  });
  if (rows.length && /^(roll|rollno|roll no|id|reg|regno)/i.test(rows[0].roll) && /name/i.test(rows[0].name)) rows.shift(); // skip a header row
  return rows.slice(0, 200);
}

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
      if (r.email && !EMAIL.test(r.email)) r.email = "";
      const pwd = tempPassword();
      const u = { id: rid(8), role: "student", name: r.name || r.roll, email: r.email, roll: r.roll, team: r.team || "", loginId, classId: cls.id, pw: await hashPw(pwd), mustChange: true, at: Date.now(), createdBy: req.user.id };
      state.users.push(u);
      backend.put("users", u);
      out.push({ roll: r.roll, name: u.name, result: "Created", tempPassword: pwd });
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
    round: s.round || 1, before: s.history?.length ? s.history[s.history.length - 1].originality : null, similar: sim[i],
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
  s.status = status;
  s.comment = clean(req.body?.comment, 500);
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

// ---------- Approval letter ----------
app.get("/letter", (req, res) => (req.user ? res.sendFile(path.join(PUBLIC, "letter.html")) : res.redirect("/student")));
app.get("/api/letter/:id", needUser, (req, res) => {
  const u = req.user, s = state.subs.find((x) => x.id === req.params.id);
  const mine = s && (u.role === "teacher" ? u.admin || s.teacherId === u.id : s.userId === u.id || (u.team && s.classId === u.classId && sameTeam(s.team, u.team)));
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

// ---------- Admin: create and manage teachers ----------
app.get("/api/admin/teachers", needAdmin, (req, res) => {
  res.json(state.users.filter((u) => u.role === "teacher").map((u) => ({
    id: u.id, name: u.name, email: u.email, status: u.status || "approved", admin: !!u.admin, at: u.at, firstLoginDone: !u.mustChange,
    classes: state.classes.filter((c) => c.teacherId === u.id).length,
  })).sort((a, b) => b.at - a.at));
});

app.post("/api/admin/teachers", needAdmin, async (req, res) => {
  try {
    const name = clean(req.body?.name, 80), email = clean(req.body?.email, 120).toLowerCase();
    if (!name) return res.status(400).json({ error: "Enter the teacher's name." });
    if (!EMAIL.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (state.users.some((u) => u.role === "teacher" && (u.loginId === email || u.email === email))) return res.status(409).json({ error: "A teacher with this email already exists." });
    const pwd = tempPassword();
    const u = { id: rid(8), role: "teacher", name, email, loginId: email, roll: "", classId: null, status: "approved", admin: false, pw: await hashPw(pwd), mustChange: true, at: Date.now() };
    state.users.push(u);
    backend.put("users", u);
    res.json({ id: u.id, name, email, tempPassword: pwd });
  } catch (e) {
    res.status(500).json({ error: "Could not create the teacher account." });
  }
});

app.post("/api/admin/teachers/:id/reset", needAdmin, async (req, res) => {
  const u = state.users.find((x) => x.id === req.params.id && x.role === "teacher");
  if (!u) return res.status(404).json({ error: "Not found." });
  if (u.id === req.user.id) return res.status(400).json({ error: "Use Change password for your own account." });
  const pwd = tempPassword();
  u.pw = await hashPw(pwd);
  u.mustChange = true;
  backend.put("users", u);
  res.json({ name: u.name, email: u.email, tempPassword: pwd });
});

app.post("/api/admin/teachers/:id/status", needAdmin, (req, res) => {
  const u = state.users.find((x) => x.id === req.params.id && x.role === "teacher");
  if (!u) return res.status(404).json({ error: "Not found." });
  if (u.id === req.user.id) return res.status(400).json({ error: "You cannot change your own account." });
  const status = String(req.body?.status || "");
  if (!["approved", "declined"].includes(status)) return res.status(400).json({ error: "Pick on or off." });
  u.status = status;
  backend.put("users", u);
  res.json({ ok: true });
});

// Brings older data up to date and makes sure there is an admin teacher.
async function migrate() {
  const seen = new Set();
  for (const u of state.users) {
    let changed = false;
    if (u.role === "teacher") {
      if (!u.status) { u.status = "approved"; changed = true; }
      if (u.status === "pending") { u.status = "declined"; changed = true; } // sign-up was removed; the admin can create the account again
    }
    if (!u.loginId) { u.loginId = u.role === "teacher" ? u.email : String(u.roll || u.email || u.id).toLowerCase(); changed = true; }
    if (seen.has(u.role + u.loginId)) { u.loginId = u.loginId + "-" + u.id.slice(0, 3); changed = true; }
    seen.add(u.role + u.loginId);
    if (changed) backend.put("users", u);
  }
  if (!state.users.some((u) => u.role === "teacher" && u.admin)) {
    const ok = state.users.filter((u) => u.role === "teacher" && u.status === "approved").sort((a, b) => a.at - b.at);
    const pick = ok.find((u) => ADMIN_EMAIL && u.email === ADMIN_EMAIL) || ok[0];
    if (pick) { pick.admin = true; backend.put("users", pick); console.log("Admin teacher:", pick.email); }
    else if (ADMIN_EMAIL && ADMIN_PASSWORD) {
      const u = { id: rid(8), role: "teacher", name: "Admin", email: ADMIN_EMAIL, loginId: ADMIN_EMAIL, roll: "", classId: null, status: "approved", admin: true, pw: await hashPw(ADMIN_PASSWORD), mustChange: true, at: Date.now() };
      state.users.push(u);
      backend.put("users", u);
      console.log("Created the admin teacher account for " + ADMIN_EMAIL + ". Log in at /teacher/login, then set a new password.");
    } else console.log("There is no admin teacher yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in your settings, then restart.");
  }
  if (process.env.ADMIN_RESET_PASSWORD && ADMIN_EMAIL) {
    const a = state.users.find((u) => u.role === "teacher" && u.admin && u.email === ADMIN_EMAIL);
    if (a) {
      a.pw = await hashPw(process.env.ADMIN_RESET_PASSWORD);
      a.mustChange = true;
      a.status = "approved";
      backend.put("users", a);
      console.log("The admin password was reset from ADMIN_RESET_PASSWORD. Remove that setting now, or it will reset again at every restart.");
    } else console.log("ADMIN_RESET_PASSWORD is set, but no admin teacher has the email in ADMIN_EMAIL.");
  }
  for (const s of state.subs) {
    let changed = false;
    if (!s.checkIds) { s.checkIds = [s.checkId]; changed = true; }
    if (!s.round) { s.round = 1; changed = true; }
    if (!s.history) { s.history = []; changed = true; }
    if (s.classId === undefined) { s.classId = null; s.teacherId = null; changed = true; }
    if (changed) backend.put("subs", s);
  }
}

await initStorage();
await migrate();
app.listen(process.env.PORT || 3000, () => console.log("IdeaForge-X on http://localhost:" + (process.env.PORT || 3000)));
