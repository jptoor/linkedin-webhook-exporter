#!/usr/bin/env node
/**
 * Reference webhook receiver.
 *
 * Verifies the HMAC-SHA256 signature and timestamp window, rejects replayed
 * event ids, and upserts leads into SQLite using parameterized statements.
 * Zero dependencies (Node 22.5+ for node:sqlite).
 *
 *   LWE_SECRET=topsecret node receiver/server.mjs
 *   PORT=8787 LWE_DB=leads.sqlite LWE_SECRET=... node receiver/server.mjs
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.LWE_SECRET ?? "";
const TOLERANCE = Number(process.env.LWE_TOLERANCE_SECONDS ?? 300);
const MAX_BODY = 1_000_000;
const db = new DatabaseSync(process.env.LWE_DB ?? "leads.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    dedupe_key TEXT PRIMARY KEY,
    linkedin_url TEXT, sales_navigator_url TEXT, linkedin_member_urn TEXT,
    full_name TEXT NOT NULL, first_name TEXT, last_name TEXT,
    headline TEXT, title TEXT, company_name TEXT, company_linkedin_url TEXT, location TEXT,
    connection_degree TEXT, profile_image_url TEXT, about TEXT,
    experience_json TEXT, education_json TEXT,
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

const upsert = db.prepare(`
  INSERT INTO leads (dedupe_key, linkedin_url, sales_navigator_url, linkedin_member_urn, full_name, first_name, last_name, headline, title, company_name, company_linkedin_url, location, connection_degree, profile_image_url, about, experience_json, education_json, page_type, page_url, captured_by, custom_json, captured_at, first_seen_at, last_seen_at)
  VALUES (@dedupe_key, @linkedin_url, @sales_navigator_url, @linkedin_member_urn, @full_name, @first_name, @last_name, @headline, @title, @company_name, @company_linkedin_url, @location, @connection_degree, @profile_image_url, @about, @experience_json, @education_json, @page_type, @page_url, @captured_by, @custom_json, @captured_at, @now, @now)
  ON CONFLICT(dedupe_key) DO UPDATE SET
    linkedin_url = COALESCE(excluded.linkedin_url, leads.linkedin_url),
    full_name = excluded.full_name, first_name = excluded.first_name, last_name = excluded.last_name,
    headline = COALESCE(excluded.headline, leads.headline), title = COALESCE(excluded.title, leads.title),
    company_name = COALESCE(excluded.company_name, leads.company_name), company_linkedin_url = COALESCE(excluded.company_linkedin_url, leads.company_linkedin_url),
    location = COALESCE(excluded.location, leads.location), connection_degree = COALESCE(excluded.connection_degree, leads.connection_degree),
    profile_image_url = COALESCE(excluded.profile_image_url, leads.profile_image_url), about = COALESCE(excluded.about, leads.about),
    experience_json = COALESCE(excluded.experience_json, leads.experience_json), education_json = COALESCE(excluded.education_json, leads.education_json),
    page_type = excluded.page_type, page_url = excluded.page_url, captured_by = excluded.captured_by, custom_json = excluded.custom_json,
    captured_at = excluded.captured_at, last_seen_at = excluded.last_seen_at, send_count = leads.send_count + 1
`);
const upsertSearch = db.prepare(`
  INSERT INTO searches (search_key, search_url, surface, page_type, query_expression, keywords, filters_json, params_json, total_hint, list_id, captured_by, custom_json, captured_at, first_seen_at, last_seen_at)
  VALUES (@search_key, @search_url, @surface, @page_type, @query_expression, @keywords, @filters_json, @params_json, @total_hint, @list_id, @captured_by, @custom_json, @captured_at, @now, @now)
  ON CONFLICT(search_key) DO UPDATE SET total_hint = COALESCE(excluded.total_hint, searches.total_hint), last_seen_at = excluded.last_seen_at, seen_count = searches.seen_count + 1
`);
function searchKey(url) {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const parts = url.slice(q + 1).split("#")[0].split("&").filter((kv) => kv && !/^page=/.test(kv));
  return (url.slice(0, q) + (parts.length ? "?" + parts.join("&") : "")).toLowerCase();
}
function extractSearch(payload) {
  const s = payload.search ?? (payload.event === "search.captured" ? payload : null);
  if (!s || !s.search_url) return null;
  const custom = payload.custom ?? Object.fromEntries(Object.entries(payload).filter(([k]) => k.startsWith("custom_")).map(([k, v]) => [k.slice(7), v]));
  return {
    search_key: searchKey(s.search_url), search_url: s.search_url, surface: s.surface ?? null, page_type: s.page_type ?? null,
    query_expression: s.query_expression ?? null, keywords: s.keywords ?? null,
    filters_json: s.filters ? JSON.stringify(s.filters) : s.filters_json ?? null, params_json: s.params ? JSON.stringify(s.params) : s.params_json ?? null,
    total_hint: s.total_hint ?? null, list_id: s.list_id ?? null, captured_by: payload.source?.captured_by ?? payload.captured_by ?? null,
    custom_json: Object.keys(custom).length ? JSON.stringify(custom) : null, captured_at: s.captured_at ?? null
  };
}
const insertImport = db.prepare(`
  INSERT OR IGNORE INTO sales_nav_imports (import_id, dedupe_key, imported_by, imported_at, import_kind, search_url, search_name, list_id, page, full_name, first_name, last_name, title, company_name, linkedin_url, sales_navigator_url, location, event_id, received_at)
  VALUES (@import_id, @dedupe_key, @imported_by, @imported_at, @import_kind, @search_url, @search_name, @list_id, @page, @full_name, @first_name, @last_name, @title, @company_name, @linkedin_url, @sales_navigator_url, @location, @event_id, @now)
`);
function extractImport(payload) {
  const i = payload.import ?? (payload.import_id ? { import_id: payload.import_id, imported_by: payload.imported_by, imported_at: payload.imported_at, import_kind: payload.import_kind, search_url: payload.import_search_url, search_name: payload.import_search_name, list_id: payload.import_list_id, page: payload.import_page } : null);
  return i && i.import_id ? i : null;
}
const insertEvent = db.prepare("INSERT INTO events (event_id, received_at, event, lead_count) VALUES (?, ?, ?, ?)");
const seenEvent = db.prepare("SELECT 1 FROM events WHERE event_id = ?");

function safeEq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function decodeStandardSecret(s) {
  const body = s.startsWith("whsec_") ? s.slice(6) : s;
  const bytes = Buffer.from(body, "base64");
  return bytes.toString("base64").replace(/=+$/, "") === body.replace(/=+$/, "") ? bytes : Buffer.from(s);
}
/** Accepts either the LWE scheme or Standard Webhooks headers. */
function verify(headers, raw) {
  if (!SECRET) return { ok: true, reason: "unsigned_mode" };
  const now = Math.floor(Date.now() / 1000);
  if (headers["webhook-signature"]) {
    const id = headers["webhook-id"], ts = headers["webhook-timestamp"];
    if (!id || !/^\d+$/.test(String(ts))) return { ok: false, reason: "missing_signature" };
    if (Math.abs(now - Number(ts)) > TOLERANCE) return { ok: false, reason: "timestamp_out_of_window" };
    const expected = createHmac("sha256", decodeStandardSecret(SECRET)).update(`${id}.${ts}.${raw}`).digest("base64");
    const ok = String(headers["webhook-signature"]).split(/\s+/).some((c) => c.startsWith("v1,") && safeEq(c.slice(3), expected));
    return ok ? { ok: true, reason: null } : { ok: false, reason: "signature_mismatch" };
  }
  const sig = headers["x-lwe-signature"];
  const ts = Number(headers["x-lwe-timestamp"]);
  if (!sig || !Number.isFinite(ts)) return { ok: false, reason: "missing_signature" };
  if (Math.abs(now - ts) > TOLERANCE) return { ok: false, reason: "timestamp_out_of_window" };
  const expected = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
  return safeEq(expected, String(sig)) ? { ok: true, reason: null } : { ok: false, reason: "signature_mismatch" };
}

/** Accepts generic (nested), flat, and Deepline-preset bodies. Returns normalized lead rows. */
export function extractLeads(payload) {
  const source = payload.source ?? {};
  const custom = payload.custom ?? {};
  if (Array.isArray(payload.leads)) return payload.leads.map((l) => norm(l, source, custom));
  if (payload.lead) return [norm(payload.lead, source, custom)];
  if (Array.isArray(payload.rows)) return payload.rows.map((r) => normFlat(r));
  if (payload.full_name) return [normFlat(payload)];
  return [];
}
function dedupeKey(l) {
  if (l.linkedin_url) return l.linkedin_url.toLowerCase();
  if (l.sales_navigator_url) return l.sales_navigator_url.toLowerCase();
  return `name:${String(l.full_name).toLowerCase()}|${String(l.company_name ?? "").toLowerCase()}`;
}
function norm(l, source, custom) {
  return {
    dedupe_key: dedupeKey(l), linkedin_url: l.linkedin_url ?? null, sales_navigator_url: l.sales_navigator_url ?? null, linkedin_member_urn: l.linkedin_member_urn ?? null,
    full_name: l.full_name, first_name: l.first_name ?? null, last_name: l.last_name ?? null, headline: l.headline ?? null, title: l.title ?? null,
    company_name: l.company_name ?? null, company_linkedin_url: l.company_linkedin_url ?? null, location: l.location ?? null, connection_degree: l.connection_degree ?? null,
    profile_image_url: l.profile_image_url ?? null, about: l.about ?? null,
    experience_json: l.experience?.length ? JSON.stringify(l.experience) : null, education_json: l.education?.length ? JSON.stringify(l.education) : null,
    page_type: source.page_type ?? null, page_url: source.page_url ?? null, captured_by: source.captured_by ?? null,
    custom_json: Object.keys(custom).length ? JSON.stringify(custom) : null, captured_at: l.captured_at ?? null
  };
}
function normFlat(r) {
  const custom = {};
  for (const [k, v] of Object.entries(r)) if (k.startsWith("custom_")) custom[k.slice(7)] = v;
  return { ...norm({ ...r, title: r.title ?? r.job_title ?? null, experience: r.experience_json ? JSON.parse(r.experience_json) : [], education: r.education_json ? JSON.parse(r.education_json) : [] }, { page_type: r.page_type, page_url: r.page_url, captured_by: r.captured_by }, custom) };
}

const CORS = process.env.LWE_CORS === "1";
const server = createServer((req, res) => {
  if (CORS) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
  }
  if (req.method === "GET" && req.url === "/health") return res.writeHead(200).end("ok");
  if (req.method === "GET" && req.url === "/imports") {
    const rows = db.prepare("SELECT import_id, imported_by, imported_at, import_kind, search_name, list_id, COUNT(*) AS leads, MIN(received_at) AS first_received FROM sales_nav_imports GROUP BY import_id ORDER BY imported_at DESC LIMIT 100").all();
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
  }
  if (req.method === "GET" && req.url === "/searches") {
    const rows = db.prepare("SELECT * FROM searches ORDER BY last_seen_at DESC LIMIT 200").all();
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
  }
  if (req.method === "GET" && req.url === "/leads") {
    const rows = db.prepare("SELECT * FROM leads ORDER BY last_seen_at DESC LIMIT 200").all();
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
  }
  if (req.method !== "POST") return res.writeHead(405).end();
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (c) => {
    raw += c;
    if (raw.length > MAX_BODY) req.destroy();
  });
  req.on("end", () => {
    const v = verify(req.headers, raw);
    if (!v.ok) return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: v.reason }));
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return res.writeHead(400).end(JSON.stringify({ error: "invalid_json" }));
    }
    const eventId = payload.event_id ?? req.headers["x-lwe-event-id"] ?? req.headers["webhook-id"];
    if (!eventId) return res.writeHead(400).end(JSON.stringify({ error: "missing_event_id" }));
    if (seenEvent.get(eventId)) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, duplicate: true }));
    if (payload.event === "test") {
      insertEvent.run(eventId, new Date().toISOString(), "test", 0);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, test: true }));
    }
    const leads = extractLeads(payload).filter((l) => l.full_name);
    const search = extractSearch(payload);
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      if (search) upsertSearch.run({ ...search, now });
      const imp = extractImport(payload);
      for (const l of leads) {
        upsert.run({ ...l, now });
        if (imp) insertImport.run({ import_id: imp.import_id, dedupe_key: l.dedupe_key, imported_by: imp.imported_by ?? null, imported_at: imp.imported_at ?? null, import_kind: imp.import_kind ?? null, search_url: imp.search_url ?? null, search_name: imp.search_name ?? null, list_id: imp.list_id ?? null, page: imp.page ?? null, full_name: l.full_name, first_name: l.first_name, last_name: l.last_name, title: l.title, company_name: l.company_name, linkedin_url: l.linkedin_url, sales_navigator_url: l.sales_navigator_url, location: l.location, event_id: eventId, now });
      }
      insertEvent.run(eventId, now, payload.event ?? "unknown", leads.length);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      return res.writeHead(500).end(JSON.stringify({ error: String(e) }));
    }
    console.log(`[lwe] ${payload.event ?? "event"} ${eventId} -> ${leads.length} lead(s) ${leads.map((l) => l.full_name).join(", ")}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(search ? { ok: true, stored: leads.length, search: true } : { ok: true, stored: leads.length }));
  });
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  server.listen(PORT, () => console.log(`[lwe] receiver on http://localhost:${server.address().port} (${SECRET ? "signed" : "UNSIGNED"} mode, db=${process.env.LWE_DB ?? "leads.sqlite"})`));
}
export { server, verify };
