#!/usr/bin/env node
/**
 * Reference webhook receiver.
 *
 * Security posture (audit SEC-01, RCV-01..05):
 *  - binds to 127.0.0.1 unless LWE_HOST is set explicitly
 *  - refuses to start without LWE_SECRET unless LWE_ALLOW_UNSIGNED=1 (dev only)
 *  - read endpoints (/leads, /searches, /imports) require LWE_ADMIN_TOKEN
 *    (Authorization: Bearer …) and are disabled when it is unset
 *  - CORS only for an explicit LWE_CORS_ORIGIN, never "*"
 *  - byte-bounded bodies (413), request error handlers, every request inside
 *    one error boundary (400/500, never a crash)
 *  - every field validated and bounded before it touches SQLite; URLs must be
 *    LinkedIn hosts; identity fallback is a namespaced hash
 *  - replay protection by event id (header must match body), integer timestamps
 *  - redacted logs (event id + counts, no names)
 *
 *   LWE_SECRET=... LWE_ADMIN_TOKEN=... node receiver/server.mjs
 */
import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const HOST = process.env.LWE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.LWE_SECRET ?? "";
const ALLOW_UNSIGNED = process.env.LWE_ALLOW_UNSIGNED === "1";
const ADMIN_TOKEN = process.env.LWE_ADMIN_TOKEN ?? "";
const CORS_ORIGIN = process.env.LWE_CORS_ORIGIN ?? "";
const TOLERANCE = Number(process.env.LWE_TOLERANCE_SECONDS ?? 300);
const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const LOG = process.env.LWE_QUIET === "1" ? () => {} : (...a) => console.log("[lwe]", ...a);

// Unsigned mode is development-only: it needs the explicit flag, a loopback
// bind, and NODE_ENV that is not "production" (NF-03).
const UNSIGNED_OK = ALLOW_UNSIGNED && (HOST === "127.0.0.1" || HOST === "localhost") && process.env.NODE_ENV === "development";
if (!SECRET && !UNSIGNED_OK) {
  console.error(ALLOW_UNSIGNED ? "[lwe] LWE_ALLOW_UNSIGNED=1 is only honored on a loopback bind with NODE_ENV=development." : "[lwe] LWE_SECRET is required. For local development set NODE_ENV=development LWE_ALLOW_UNSIGNED=1.");
  process.exit(2);
}
if (HOST !== "127.0.0.1" && HOST !== "localhost" && !ADMIN_TOKEN) console.warn("[lwe] WARNING: binding to a non-loopback host without LWE_ADMIN_TOKEN; read endpoints stay disabled.");

const db = new DatabaseSync(process.env.LWE_DB ?? "leads.sqlite");
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    dedupe_key TEXT PRIMARY KEY,
    linkedin_url TEXT, sales_navigator_url TEXT, linkedin_member_urn TEXT,
    full_name TEXT NOT NULL, first_name TEXT, last_name TEXT,
    headline TEXT, title TEXT, company_name TEXT, company_linkedin_url TEXT, location TEXT,
    connection_degree TEXT, profile_image_url TEXT, about TEXT,
    experience_json TEXT, education_json TEXT, parse_warnings TEXT,
    page_type TEXT, page_url TEXT, captured_by TEXT, custom_json TEXT,
    captured_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, send_count INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL, event TEXT, lead_count INTEGER);
  CREATE TABLE IF NOT EXISTS sales_nav_imports (
    import_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
    imported_by TEXT, imported_at TEXT, import_kind TEXT, search_url TEXT, search_name TEXT, list_id TEXT, page INTEGER,
    full_name TEXT, first_name TEXT, last_name TEXT, title TEXT, company_name TEXT, linkedin_url TEXT, sales_navigator_url TEXT, location TEXT,
    event_id TEXT, received_at TEXT NOT NULL,
    PRIMARY KEY (import_id, dedupe_key)
  );
  CREATE TABLE IF NOT EXISTS searches (
    search_key TEXT PRIMARY KEY, search_url TEXT NOT NULL, surface TEXT, page_type TEXT, query_expression TEXT, keywords TEXT,
    filters_json TEXT, params_json TEXT, total_hint INTEGER, list_id TEXT, captured_by TEXT, custom_json TEXT,
    captured_at TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1
  );
`);
try {
  db.exec("ALTER TABLE leads ADD COLUMN parse_warnings TEXT");
} catch {
  /* column exists */
}

const upsert = db.prepare(`
  INSERT INTO leads (dedupe_key, linkedin_url, sales_navigator_url, linkedin_member_urn, full_name, first_name, last_name, headline, title, company_name, company_linkedin_url, location, connection_degree, profile_image_url, about, experience_json, education_json, parse_warnings, page_type, page_url, captured_by, custom_json, captured_at, first_seen_at, last_seen_at)
  VALUES (@dedupe_key, @linkedin_url, @sales_navigator_url, @linkedin_member_urn, @full_name, @first_name, @last_name, @headline, @title, @company_name, @company_linkedin_url, @location, @connection_degree, @profile_image_url, @about, @experience_json, @education_json, @parse_warnings, @page_type, @page_url, @captured_by, @custom_json, @captured_at, @now, @now)
  ON CONFLICT(dedupe_key) DO UPDATE SET
    linkedin_url = COALESCE(excluded.linkedin_url, leads.linkedin_url),
    full_name = excluded.full_name, first_name = excluded.first_name, last_name = excluded.last_name,
    headline = COALESCE(excluded.headline, leads.headline), title = COALESCE(excluded.title, leads.title),
    company_name = COALESCE(excluded.company_name, leads.company_name), company_linkedin_url = COALESCE(excluded.company_linkedin_url, leads.company_linkedin_url),
    location = COALESCE(excluded.location, leads.location), connection_degree = COALESCE(excluded.connection_degree, leads.connection_degree),
    profile_image_url = COALESCE(excluded.profile_image_url, leads.profile_image_url), about = COALESCE(excluded.about, leads.about),
    experience_json = COALESCE(excluded.experience_json, leads.experience_json), education_json = COALESCE(excluded.education_json, leads.education_json),
    parse_warnings = excluded.parse_warnings,
    page_type = excluded.page_type, page_url = excluded.page_url, captured_by = excluded.captured_by, custom_json = excluded.custom_json,
    captured_at = excluded.captured_at, last_seen_at = excluded.last_seen_at, send_count = leads.send_count + 1
`);
const insertImport = db.prepare(`
  INSERT OR IGNORE INTO sales_nav_imports (import_id, dedupe_key, imported_by, imported_at, import_kind, search_url, search_name, list_id, page, full_name, first_name, last_name, title, company_name, linkedin_url, sales_navigator_url, location, event_id, received_at)
  VALUES (@import_id, @dedupe_key, @imported_by, @imported_at, @import_kind, @search_url, @search_name, @list_id, @page, @full_name, @first_name, @last_name, @title, @company_name, @linkedin_url, @sales_navigator_url, @location, @event_id, @now)
`);
const upsertSearch = db.prepare(`
  INSERT INTO searches (search_key, search_url, surface, page_type, query_expression, keywords, filters_json, params_json, total_hint, list_id, captured_by, custom_json, captured_at, first_seen_at, last_seen_at)
  VALUES (@search_key, @search_url, @surface, @page_type, @query_expression, @keywords, @filters_json, @params_json, @total_hint, @list_id, @captured_by, @custom_json, @captured_at, @now, @now)
  ON CONFLICT(search_key) DO UPDATE SET total_hint = COALESCE(excluded.total_hint, searches.total_hint), last_seen_at = excluded.last_seen_at, seen_count = searches.seen_count + 1
`);
const insertEvent = db.prepare("INSERT INTO events (event_id, received_at, event, lead_count) VALUES (?, ?, ?, ?)");
const seenEvent = db.prepare("SELECT 1 FROM events WHERE event_id = ?");

/* ------------------------------------------------------------ validation */

class BadRequest extends Error {
  constructor(msg) {
    super(msg);
    this.status = 400;
  }
}
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PAGE_TYPES = new Set(["profile", "people_search", "salesnav_search", "salesnav_list", "salesnav_lead"]);
const EVENTS = new Set(["lead.captured", "leads.captured", "search.captured", "test"]);
const MAX = { name: 200, text: 300, headline: 500, about: 4000, url: 2048, json: 200_000, leads: 500 };
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

const str = (v, max) => (typeof v === "string" && v.trim() ? v.replace(ZERO_WIDTH, "").trim().slice(0, max) || null : null);
const isLinkedInHost = (h) => h === "linkedin.com" || h === "www.linkedin.com" || /^[a-z]{2}\.linkedin\.com$/.test(h);
function linkedinUrl(v, re) {
  const s = str(v, MAX.url);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || !isLinkedInHost(u.hostname) || u.username || u.password || u.port) return null;
    return re.test(u.pathname) ? `https://www.linkedin.com${u.pathname.replace(/\/$/, "")}` : null;
  } catch {
    return null;
  }
}
const profileUrl = (v) => linkedinUrl(v, /^\/in\/[^/]+\/?$/);
const salesNavUrl = (v) => linkedinUrl(v, /^\/sales\/lead\/[A-Za-z0-9_-]{8,80}\/?$/);
const companyUrl = (v) => linkedinUrl(v, /^\/(company|school)\/[^/]+\/?$/);
function jsonArray(v, max = MAX.json) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? JSON.stringify(v.slice(0, 50)).slice(0, max) : null;
  if (typeof v !== "string" || v.length > max) throw new BadRequest("bad_json_array");
  let x;
  try {
    x = JSON.parse(v);
  } catch {
    throw new BadRequest("bad_json_array");
  }
  if (!Array.isArray(x)) throw new BadRequest("bad_json_array");
  return x.length ? JSON.stringify(x.slice(0, 50)) : null;
}
function customJson(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const [k, val] of Object.entries(v).slice(0, 20)) if (typeof val === "string") out[String(k).slice(0, 60)] = val.slice(0, 500);
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
function dedupeKey(l) {
  if (l.linkedin_url) return l.linkedin_url.toLowerCase();
  if (l.sales_navigator_url) return l.sales_navigator_url.toLowerCase();
  // Weak identity: namespaced hash so unrelated same-name people at least do
  // not collide with URL keys; still flagged via parse_warnings.
  return "name:" + createHash("sha256").update(`${l.full_name.toLowerCase().normalize("NFKC")}|${(l.company_name ?? "").toLowerCase().normalize("NFKC")}`).digest("hex").slice(0, 32);
}

function customFromFlat(o) {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => k.startsWith("custom_") && typeof v === "string").map(([k, v]) => [k.slice(7), v]));
}

function normLead(l, source, custom) {
  if (!l || typeof l !== "object" || Array.isArray(l)) throw new BadRequest("bad_lead");
  const full_name = str(l.full_name, MAX.name);
  if (!full_name) throw new BadRequest("lead_without_name");
  const degree = ["1st", "2nd", "3rd"].includes(l.connection_degree) ? l.connection_degree : null;
  const warnings = Array.isArray(l.parse_warnings) ? l.parse_warnings.filter((w) => typeof w === "string").slice(0, 20) : typeof l.parse_warnings === "string" ? l.parse_warnings.split(",").filter(Boolean).slice(0, 20) : [];
  const urn = str(l.linkedin_member_urn, 80);
  const img = str(l.profile_image_url, MAX.url);
  const captured = str(l.captured_at, 40);
  const out = {
    linkedin_url: profileUrl(l.linkedin_url),
    sales_navigator_url: salesNavUrl(l.sales_navigator_url),
    linkedin_member_urn: urn && /^[A-Za-z0-9_-]{8,80}$/.test(urn) ? urn : null,
    full_name,
    first_name: str(l.first_name, MAX.name),
    last_name: str(l.last_name, MAX.name),
    headline: str(l.headline, MAX.headline),
    title: str(l.title ?? l.job_title, MAX.text),
    company_name: str(l.company_name, MAX.text),
    company_linkedin_url: companyUrl(l.company_linkedin_url),
    location: str(l.location, MAX.text),
    connection_degree: degree,
    profile_image_url: img && /^https:\/\/([a-z0-9-]+\.)*licdn\.com\//i.test(img) ? img : null,
    about: str(l.about, MAX.about),
    experience_json: jsonArray(l.experience ?? l.experience_json),
    education_json: jsonArray(l.education ?? l.education_json),
    page_type: PAGE_TYPES.has(source?.page_type) ? source.page_type : null,
    page_url: provenanceUrl(source?.page_url),
    captured_by: str(source?.captured_by, 200),
    custom_json: customJson(custom),
    captured_at: captured && !Number.isNaN(Date.parse(captured)) ? captured : null
  };
  if (!out.linkedin_url && !out.sales_navigator_url) warnings.push("name_fallback_key");
  out.parse_warnings = warnings.length ? [...new Set(warnings)].join(",") : null;
  out.dedupe_key = dedupeKey(out);
  return out;
}

/** Accepts generic (nested), flat, and Deepline-preset bodies. */
export function extractLeads(payload) {
  const source = payload.source && typeof payload.source === "object" ? payload.source : { page_type: payload.page_type, page_url: payload.page_url, captured_by: payload.captured_by };
  const custom = payload.custom && typeof payload.custom === "object" ? payload.custom : customFromFlat(payload);
  if (Array.isArray(payload.leads)) {
    if (payload.leads.length > MAX.leads) throw new BadRequest("too_many_leads");
    return payload.leads.map((l) => normLead(l, source, custom));
  }
  if (payload.lead) return [normLead(payload.lead, source, custom)];
  if (Array.isArray(payload.rows)) {
    if (payload.rows.length > MAX.leads) throw new BadRequest("too_many_leads");
    return payload.rows.map((r) => normLead(r, { page_type: r?.page_type ?? source.page_type, page_url: r?.page_url ?? source.page_url, captured_by: r?.captured_by ?? source.captured_by }, customFromFlat(r)));
  }
  if (typeof payload.full_name === "string") return [normLead(payload, source, custom)];
  return [];
}

// Same sensitive-parameter list as src/shared/search.ts (NF-05); keep in sync.
const SENSITIVE_PARAMS = new Set(["sessionid", "_ntb", "trk", "trkinfo", "lici", "licu", "midtoken", "midsig", "trkemail", "otptoken", "eid", "refid", "trackingid", "origin", "originalsubdomain", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);
function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}
/** URL without fragment, page, and session/tracking params; used for both
 *  the stored search_url and the identity key. */
export function redactSearchUrl(url) {
  const noHash = url.split("#")[0];
  const q = noHash.indexOf("?");
  if (q < 0) return noHash;
  const parts = noHash
    .slice(q + 1)
    .split("&")
    .filter((kv) => {
      if (!kv) return false;
      const k = safeDecode(kv.split("=")[0]).toLowerCase();
      return k !== "page" && !SENSITIVE_PARAMS.has(k);
    });
  return noHash.slice(0, q) + (parts.length ? "?" + parts.join("&") : "");
}
function searchKey(url) {
  return redactSearchUrl(url).toLowerCase();
}
/** LinkedIn (or loopback) URL for provenance fields, redacted; else null. */
function provenanceUrl(v) {
  const s = str(v, MAX.url);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.username || u.password) return null;
    if ((u.protocol === "https:" && isLinkedInHost(u.hostname)) || (u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname))) return redactSearchUrl(s);
    return null;
  } catch {
    return null;
  }
}
export function extractSearch(payload) {
  const s = payload.search && typeof payload.search === "object" ? payload.search : payload.event === "search.captured" ? payload : null;
  if (!s) return null;
  const url = str(s.search_url, MAX.url);
  if (!url) throw new BadRequest("search_without_url");
  try {
    const u = new URL(url);
    if (!isLinkedInHost(u.hostname) && !/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) throw new BadRequest("search_url_not_linkedin");
  } catch (e) {
    if (e instanceof BadRequest) throw e;
    throw new BadRequest("search_url_invalid");
  }
  const custom = payload.custom && typeof payload.custom === "object" ? payload.custom : customFromFlat(payload);
  const obj = (v, max) => (v && typeof v === "object" ? JSON.stringify(v).slice(0, max) : typeof v === "string" && v.length <= max ? v : null);
  return {
    search_key: searchKey(url),
    search_url: redactSearchUrl(url),
    surface: s.surface === "sales_navigator" || s.surface === "linkedin" ? s.surface : null,
    page_type: PAGE_TYPES.has(s.page_type) ? s.page_type : null,
    query_expression: str(s.query_expression, 20_000),
    keywords: str(s.keywords, 500),
    filters_json: obj(s.filters ?? s.filters_json, 20_000),
    params_json: obj(s.params ?? s.params_json, 20_000),
    total_hint: Number.isInteger(s.total_hint) && s.total_hint >= 0 ? s.total_hint : null,
    list_id: str(s.list_id, 64),
    captured_by: str(payload.source?.captured_by ?? payload.captured_by, 200),
    custom_json: customJson(custom),
    captured_at: str(s.captured_at, 40)
  };
}
export function extractImport(payload) {
  const i = payload.import && typeof payload.import === "object" ? payload.import : typeof payload.import_id === "string" ? { import_id: payload.import_id, imported_by: payload.imported_by, imported_at: payload.imported_at, import_kind: payload.import_kind, search_url: payload.import_search_url, search_name: payload.import_search_name, list_id: payload.import_list_id, page: payload.import_page } : null;
  if (!i) return null;
  const id = str(i.import_id, 64);
  if (!id || !EVENT_ID_RE.test(id)) return null;
  return { import_id: id, imported_by: str(i.imported_by, 200), imported_at: str(i.imported_at, 40), import_kind: ["basket", "search", "export"].includes(i.import_kind) ? i.import_kind : "manual", search_url: provenanceUrl(i.search_url), search_name: str(i.search_name, 200), list_id: str(i.list_id, 64), page: Number.isInteger(i.page) && i.page > 0 ? i.page : null };
}

/* ------------------------------------------------------------ auth */

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function decodeStandardSecret(s) {
  const body = s.startsWith("whsec_") ? s.slice(6) : s;
  const std = body.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(std)) return s.startsWith("whsec_") ? null : Buffer.from(s);
  const bytes = Buffer.from(std, "base64");
  return bytes.length ? bytes : null;
}
/** Returns { ok, reason, eventId } — eventId is the signed id when the scheme carries one. */
export function verify(headers, raw) {
  if (!SECRET) return { ok: true, reason: "unsigned_mode", eventId: null };
  const now = Math.floor(Date.now() / 1000);
  if (headers["webhook-signature"]) {
    const id = headers["webhook-id"], ts = String(headers["webhook-timestamp"] ?? "");
    if (!id || !EVENT_ID_RE.test(String(id))) return { ok: false, reason: "bad_event_id" };
    if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: "bad_timestamp" };
    if (Math.abs(now - Number(ts)) > TOLERANCE) return { ok: false, reason: "timestamp_out_of_window" };
    const key = decodeStandardSecret(SECRET);
    if (!key) return { ok: false, reason: "bad_secret_config" };
    const expected = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
    const ok = String(headers["webhook-signature"]).split(/\s+/).some((c) => /^v1,[A-Za-z0-9+/]+={0,2}$/.test(c) && safeEq(c.slice(3), expected));
    return ok ? { ok: true, reason: null, eventId: String(id) } : { ok: false, reason: "signature_mismatch" };
  }
  const sig = headers["x-lwe-signature"];
  const tsRaw = String(headers["x-lwe-timestamp"] ?? "");
  if (!sig || !/^\d{1,12}$/.test(tsRaw)) return { ok: false, reason: "missing_signature" };
  const ts = Number(tsRaw);
  if (Math.abs(now - ts) > TOLERANCE) return { ok: false, reason: "timestamp_out_of_window" };
  if (!/^sha256=[0-9a-f]{64}$/.test(String(sig))) return { ok: false, reason: "bad_signature_format" };
  const expected = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
  return safeEq(expected, sig) ? { ok: true, reason: null, eventId: headers["x-lwe-event-id"] ? String(headers["x-lwe-event-id"]) : null } : { ok: false, reason: "signature_mismatch" };
}
function adminOk(req) {
  if (!ADMIN_TOKEN) return false;
  const h = String(req.headers.authorization ?? "");
  return h.startsWith("Bearer ") && safeEq(h.slice(7), ADMIN_TOKEN);
}

/* ------------------------------------------------------------ http */

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) return reject(Object.assign(new Error("payload_too_large"), { status: 413 }));
    const chunks = [];
    let bytes = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        done = true;
        req.pause();
        return reject(Object.assign(new Error("payload_too_large"), { status: 413 }));
      }
      chunks.push(c);
    });
    req.on("end", () => !done && resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => !done && reject(Object.assign(e, { status: 400 })));
    req.on("aborted", () => !done && reject(Object.assign(new Error("aborted"), { status: 400 })));
  });
}

async function handle(req, res) {
  if (CORS_ORIGIN && req.headers.origin === CORS_ORIGIN) {
    res.setHeader("access-control-allow-origin", CORS_ORIGIN);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "content-type, x-lwe-signature, x-lwe-timestamp, x-lwe-event-id, x-lwe-version, idempotency-key, webhook-id, webhook-timestamp, webhook-signature, authorization");
    res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
  }
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/health") return res.writeHead(200, { "cache-control": "no-store" }).end("ok");
  if (req.method === "GET" && ["/leads", "/searches", "/imports"].includes(url.pathname)) {
    if (!ADMIN_TOKEN) return json(res, 404, { error: "not_found" });
    if (!adminOk(req)) return json(res, 401, { error: "unauthorized" });
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
    if (url.pathname === "/leads") return json(res, 200, db.prepare("SELECT * FROM leads ORDER BY last_seen_at DESC LIMIT ?").all(limit));
    if (url.pathname === "/searches") return json(res, 200, db.prepare("SELECT * FROM searches ORDER BY last_seen_at DESC LIMIT ?").all(limit));
    return json(res, 200, db.prepare("SELECT import_id, imported_by, imported_at, import_kind, search_name, list_id, COUNT(*) AS leads, MIN(received_at) AS first_received FROM sales_nav_imports GROUP BY import_id ORDER BY imported_at DESC LIMIT ?").all(limit));
  }
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });

  const raw = await readBody(req);
  const v = verify(req.headers, raw);
  if (!v.ok) return json(res, 401, { error: v.reason });
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: "invalid_json" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json(res, 400, { error: "invalid_payload" });
  const eventId = typeof payload.event_id === "string" ? payload.event_id : typeof req.headers["x-lwe-event-id"] === "string" ? req.headers["x-lwe-event-id"] : v.eventId;
  if (!eventId || !EVENT_ID_RE.test(eventId)) return json(res, 400, { error: "missing_event_id" });
  if (v.eventId && v.eventId !== eventId) return json(res, 400, { error: "event_id_mismatch" });
  const event = typeof payload.event === "string" ? payload.event : "lead.captured";
  if (!EVENTS.has(event)) return json(res, 400, { error: "unknown_event" });

  // Replay protection: the event id row is inserted inside the transaction, so
  // two concurrent deliveries of the same id cannot both be processed.
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (seenEvent.get(eventId)) {
      db.exec("ROLLBACK");
      return json(res, 200, { ok: true, duplicate: true });
    }
    if (event === "test") {
      insertEvent.run(eventId, now, "test", 0);
      db.exec("COMMIT");
      LOG("test", eventId);
      return json(res, 200, { ok: true, test: true });
    }
    if ("custom" in payload && payload.custom != null && (typeof payload.custom !== "object" || Array.isArray(payload.custom))) throw new BadRequest("custom_not_object");
    if ("import" in payload && payload.import != null && (typeof payload.import !== "object" || Array.isArray(payload.import))) throw new BadRequest("import_not_object");
    if (event === "leads.captured" && !Array.isArray(payload.leads) && !Array.isArray(payload.rows)) throw new BadRequest("leads_not_array");
    const leads = extractLeads(payload);
    const search = extractSearch(payload);
    const imp = extractImport(payload);
    if (event === "search.captured" && !search) throw new BadRequest("search_missing");
    if (event === "lead.captured" && !leads.length) throw new BadRequest("lead_missing");
    if (search) upsertSearch.run({ ...search, now });
    for (const l of leads) {
      upsert.run({ ...l, now });
      if (imp) insertImport.run({ ...imp, dedupe_key: l.dedupe_key, full_name: l.full_name, first_name: l.first_name, last_name: l.last_name, title: l.title, company_name: l.company_name, linkedin_url: l.linkedin_url, sales_navigator_url: l.sales_navigator_url, location: l.location, event_id: eventId, now });
    }
    insertEvent.run(eventId, now, event, leads.length);
    db.exec("COMMIT");
    LOG(event, eventId, `leads=${leads.length}`, search ? "search=1" : "", imp ? `import=${imp.import_id}` : "");
    return json(res, 200, search ? { ok: true, stored: leads.length, search: true } : { ok: true, stored: leads.length });
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* not in tx */
    }
    throw e;
  }
}

const server = createServer((req, res) => {
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) json(res, 408, { error: "request_timeout" });
    req.destroy();
  });
  handle(req, res).catch((e) => {
    const status = e instanceof BadRequest ? 400 : typeof e?.status === "number" ? e.status : 500;
    if (status >= 500) console.error("[lwe] error", e?.message ?? e);
    if (!res.headersSent) json(res, status, { error: status >= 500 ? "internal_error" : (e?.message ?? "bad_request") });
    else res.end();
  });
});
server.headersTimeout = 10_000;
server.requestTimeout = REQUEST_TIMEOUT_MS;

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  server.listen(PORT, HOST, () => LOG(`receiver on http://${HOST}:${server.address().port} (${SECRET ? "signed" : "UNSIGNED DEV MODE"}; reads ${ADMIN_TOKEN ? "enabled with admin token" : "disabled"}; db=${process.env.LWE_DB ?? "leads.sqlite"})`));
}
export { server };
