/** End-to-end tests of the reference receiver: spawn it with a secret and a
 *  temp SQLite file, POST signed payloads in both schemes, verify rows,
 *  replay handling, auth on reads, body limits, and malformed input. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const SECRET = "whsec_" + Buffer.from("receiver-key").toString("base64");
const ADMIN = "admin-token-123";
let proc: ChildProcess;
let base = "";

async function post(body: string, headers: Record<string, string>) {
  const res = await fetch(`${base}/hook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const now = () => Math.floor(Date.now() / 1000);
function lweHeaders(body: string, ts = now(), eventIdHeader?: string) {
  return { "x-lwe-timestamp": String(ts), "x-lwe-signature": "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex"), ...(eventIdHeader ? { "x-lwe-event-id": eventIdHeader } : {}) };
}
function swHeaders(body: string, id: string, ts = now()) {
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": "v1," + createHmac("sha256", Buffer.from("receiver-key")).update(`${id}.${ts}.${body}`).digest("base64") };
}
const admin = { authorization: `Bearer ${ADMIN}` };
const lead = (over: Record<string, unknown> = {}) => ({ full_name: "Jane Doe", full_name_raw: null, first_name: "Jane", last_name: "Doe", headline: null, title: "VP", company_name: "Acme", company_linkedin_url: null, location: "Austin", linkedin_url: "https://www.linkedin.com/in/jane", linkedin_slug: "jane", linkedin_member_urn: null, sales_navigator_url: null, connection_degree: null, profile_image_url: null, about: null, experience: [{ title: "VP", company_name: "Acme", company_linkedin_url: null, date_range: null, location: null }], education: [], captured_at: "2026-09-03T00:00:00.000Z", parse_warnings: [], ...over });
const env = (extra: Record<string, string> = {}) => ({ ...process.env, PORT: "0", LWE_SECRET: SECRET, LWE_ADMIN_TOKEN: ADMIN, LWE_QUIET: "1", ...extra });
let n = 0;
const eid = () => `evt-${Date.now().toString(36)}-${++n}-xxxx`;

beforeAll(async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "lwe-recv-"));
  proc = spawn(process.execPath, [resolve(__dirname, "../../receiver/server.mjs")], { env: env({ LWE_DB: resolve(dir, "t.sqlite"), LWE_QUIET: "0" }), stdio: ["ignore", "pipe", "pipe"] });
  base = await new Promise<string>((res, rej) => {
    proc.stdout!.on("data", (d) => {
      const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) res(`http://127.0.0.1:${m[1]}`);
    });
    proc.stderr!.on("data", (d) => {
      if (/Error/.test(String(d))) rej(new Error(String(d)));
    });
    proc.on("exit", (c) => rej(new Error(`receiver exited ${c}`)));
  });
}, 20_000);
afterAll(() => proc.kill());

describe("startup posture", () => {
  it("refuses to start without a secret unless LWE_ALLOW_UNSIGNED=1, and binds loopback", () => {
    const r = spawnSync(process.execPath, [resolve(__dirname, "../../receiver/server.mjs")], { env: { ...process.env, LWE_SECRET: "", PORT: "0", LWE_DB: ":memory:" }, encoding: "utf8", timeout: 5000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/LWE_SECRET is required/);
    expect(base.startsWith("http://127.0.0.1:")).toBe(true);
  });
});

describe("NF-03 unsigned mode gating", () => {
  it("refuses unsigned mode in production or on a non-loopback bind", () => {
    const run = (extra: Record<string, string>) => spawnSync(process.execPath, [resolve(__dirname, "../../receiver/server.mjs")], { env: { ...process.env, LWE_SECRET: "", LWE_ALLOW_UNSIGNED: "1", PORT: "0", LWE_DB: ":memory:", LWE_QUIET: "1", ...extra }, encoding: "utf8", timeout: 5000 });
    expect(run({ NODE_ENV: "production" }).status).toBe(2);
    expect(run({ LWE_HOST: "0.0.0.0" }).status).toBe(2);
  });
});

describe("auth and replay", () => {
  it("rejects unsigned, tampered, stale, fractional-timestamp and malformed-signature requests", async () => {
    const body = JSON.stringify({ event: "lead.captured", event_id: eid(), lead: lead() });
    expect((await post(body, {})).json).toEqual({ error: "missing_signature" });
    expect((await post(body, { ...lweHeaders(body), "x-lwe-signature": "sha256=" + "0".repeat(64) })).json).toEqual({ error: "signature_mismatch" });
    expect((await post(body, { ...lweHeaders(body), "x-lwe-signature": "sha256=zz" })).json).toEqual({ error: "bad_signature_format" });
    expect((await post(body, lweHeaders(body, now() - 1000))).json).toEqual({ error: "timestamp_out_of_window" });
    expect((await post(body, { ...lweHeaders(body), "x-lwe-timestamp": String(now()) + ".5" })).json).toEqual({ error: "missing_signature" });
    expect((await post(body + " ", lweHeaders(body))).status).toBe(401);
  });
  it("requires an event id matching the signed header, dedupes replays inside the transaction", async () => {
    const id = eid();
    const body = JSON.stringify({ schema_version: "1", event: "lead.captured", event_id: id, sent_at: "t", source: { page_type: "profile", page_url: "https://www.linkedin.com/in/jane/", captured_by: "jai" }, lead: lead(), custom: { campaign: "q3" } });
    expect((await post(body, swHeaders(body, "other-id-xxxxxx"))).json).toEqual({ error: "event_id_mismatch" });
    expect(await post(body, swHeaders(body, id))).toEqual({ status: 200, json: { ok: true, stored: 1 } });
    const replays = await Promise.all([post(body, lweHeaders(body)), post(body, lweHeaders(body)), post(body, swHeaders(body, id))]);
    for (const r of replays) expect(r.json).toEqual({ ok: true, duplicate: true });
    const noId = JSON.stringify({ event: "lead.captured", lead: lead() });
    expect((await post(noId, lweHeaders(noId))).json).toEqual({ error: "missing_event_id" });
    const badId = JSON.stringify({ event: "lead.captured", event_id: "has.dot-xxxxxx", lead: lead() });
    expect((await post(badId, lweHeaders(badId))).json).toEqual({ error: "missing_event_id" });
  });
  it("read endpoints require the admin token", async () => {
    expect((await fetch(`${base}/leads`)).status).toBe(401);
    expect((await fetch(`${base}/imports`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/leads`, { headers: admin })).status).toBe(200);
    expect((await fetch(`${base}/nope`)).status).toBe(405);
  });
});

describe("robustness against malformed authenticated input (never crashes)", () => {
  const cases: Array<[string, unknown]> = [
    ["array body", [1, 2]],
    ["string body", "hi"],
    ["number body", 42],
    ["leads not array", { event: "leads.captured", leads: "x" }],
    ["lead is string", { event: "leads.captured", leads: ["x"] }],
    ["lead without name", { event: "lead.captured", lead: { full_name: "" } }],
    ["lead name object", { event: "lead.captured", lead: { full_name: { a: 1 } } }],
    ["experience_json garbage", { event: "lead.captured", full_name: "X Y", experience_json: "{not json" }],
    ["experience_json not array", { event: "lead.captured", full_name: "X Y", experience_json: '{"a":1}' }],
    ["custom not object", { event: "lead.captured", lead: lead(), custom: "str" }],
    ["search without url", { event: "search.captured", search: { keywords: "x" } }],
    ["search url not linkedin", { event: "search.captured", search: { search_url: "https://evil.example/?q=1" } }],
    ["search url garbage", { event: "search.captured", search: { search_url: 123 } }],
    ["unknown event", { event: "evil.event", lead: lead() }],
    ["too many leads", { event: "leads.captured", leads: Array.from({ length: 501 }, () => lead()) }],
    ["rows with null", { event: "leads.captured", rows: [null] }],
    ["import garbage", { event: "lead.captured", lead: lead(), import: "x" }]
  ];
  for (const [name, payload] of cases) {
    it(`${name} -> 400, server still alive`, async () => {
      const body = JSON.stringify(payload && typeof payload === "object" && !Array.isArray(payload) ? { event_id: eid(), ...(payload as object) } : payload);
      const r = await post(body, lweHeaders(body));
      expect(r.status).toBe(400);
      expect((await fetch(`${base}/health`)).status).toBe(200);
    });
  }
  it("invalid JSON with a valid signature -> 400", async () => {
    const body = "{not json";
    expect((await post(body, lweHeaders(body))).json).toEqual({ error: "invalid_json" });
  });
  it("oversized bodies get 413 (declared and streamed)", async () => {
    const big = JSON.stringify({ event_id: eid(), event: "lead.captured", lead: lead({ about: "a".repeat(1_100_000) }) });
    const r = await fetch(`${base}/hook`, { method: "POST", headers: { "content-type": "application/json", ...lweHeaders(big) }, body: big }).catch(() => null);
    expect(r === null || r.status === 413).toBe(true);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe("storage semantics", () => {
  it("stores generic payloads with unicode, bounds fields, drops hostile URLs, flags name-fallback identities", async () => {
    const id = eid();
    const body = JSON.stringify({ schema_version: "1", event: "lead.captured", event_id: id, sent_at: "t", source: { page_type: "profile", page_url: "https://www.linkedin.com/in/zoe/", captured_by: "jai" }, lead: lead({ full_name: "Zoë Ångström 🚀", linkedin_url: "https://evil.example/in/zoe", sales_navigator_url: null, company_linkedin_url: "https://www.linkedin.com/company/1035/", profile_image_url: "https://evil.example/x.jpg", about: "b".repeat(9000), connection_degree: "9th", parse_warnings: "sdui_layout" }), custom: { campaign: "q3", nested: { no: 1 } } });
    expect((await post(body, lweHeaders(body))).json).toEqual({ ok: true, stored: 1 });
    const rows = (await (await fetch(`${base}/leads?limit=500`, { headers: admin })).json()) as any[];
    const z = rows.find((r) => r.full_name === "Zoë Ångström 🚀");
    expect(z).toMatchObject({ linkedin_url: null, company_linkedin_url: "https://www.linkedin.com/company/1035", profile_image_url: null, connection_degree: null, page_type: "profile" });
    expect(z.dedupe_key.startsWith("name:")).toBe(true);
    expect(z.parse_warnings).toBe("sdui_layout,name_fallback_key");
    expect(z.about.length).toBe(4000);
    expect(JSON.parse(z.custom_json)).toEqual({ campaign: "q3" });
  });
  it("upserts on identity and accepts Standard Webhooks + Deepline-flat bodies", async () => {
    const id = eid();
    const body = JSON.stringify({ schema_version: "1", event: "lead.captured", event_id: id, linkedin_url: "https://www.linkedin.com/in/jane", first_name: "Jane", last_name: "Doe", title: "SVP", company_name: "Acme", company_domain: null, email: null, source: "linkedin-webhook-exporter", full_name: "Jane Doe", location: null, page_type: "profile", page_url: "https://www.linkedin.com/in/jane/", captured_by: "jai", custom_campaign: "q4" });
    expect(await post(body, swHeaders(body, id))).toEqual({ status: 200, json: { ok: true, stored: 1 } });
    const rows = (await (await fetch(`${base}/leads?limit=500`, { headers: admin })).json()) as any[];
    const j = rows.find((r) => r.dedupe_key === "https://www.linkedin.com/in/jane");
    expect(j).toMatchObject({ title: "SVP", location: "Austin", page_url: "https://www.linkedin.com/in/jane/" });
    expect(j.send_count).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(j.custom_json)).toEqual({ campaign: "q4" });
  });
  it("NF-04/NF-05: import provenance URLs are validated and redacted; search URLs lose tracking params and fragments", async () => {
    const id = eid();
    const body = JSON.stringify({ schema_version: "1", event: "lead.captured", event_id: id, sent_at: "t", source: { page_type: "salesnav_search", page_url: "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&sessionId=S&utm_source=x#f", captured_by: "jai" }, lead: lead({ full_name: "Prov Enance", linkedin_url: "https://www.linkedin.com/in/prov-enance" }), import: { import_id: "imp-hostile-xx", imported_by: "jai", imported_at: "t", import_kind: "manual", search_url: "https://evil.example/steal?x=1", search_name: "n", list_id: null, page: 1 }, custom: {} });
    expect((await post(body, lweHeaders(body))).json).toEqual({ ok: true, stored: 1 });
    const s = JSON.stringify({ schema_version: "1", event: "search.captured", event_id: eid(), sent_at: "t", source: { page_type: "salesnav_search", page_url: "u", captured_by: "jai" }, search: { search_url: "https://www.linkedin.com/sales/search/people?query=(keywords%3Aprov)&trkInfo=T&midToken=M&sessionId=S#frag", surface: "sales_navigator", page_type: "salesnav_search", params: {}, query_expression: null, keywords: "prov", filters: {}, total_hint: 1, page: 1, list_id: null, captured_at: "t" }, custom: {} });
    expect((await post(s, lweHeaders(s))).json).toEqual({ ok: true, stored: 0, search: true });
    const leads = (await (await fetch(`${base}/leads?limit=500`, { headers: admin })).json()) as any[];
    expect(leads.find((l) => l.full_name === "Prov Enance").page_url).toBe("https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)");
    const imports = (await (await fetch(`${base}/imports`, { headers: admin })).json()) as any[];
    expect(imports.find((i) => i.import_id === "imp-hostile-xx")).toBeDefined();
    const searches = (await (await fetch(`${base}/searches`, { headers: admin })).json()) as any[];
    const prov = searches.find((x) => x.keywords === "prov");
    expect(prov.search_url).toBe("https://www.linkedin.com/sales/search/people?query=(keywords%3Aprov)");
    expect(prov.search_key).not.toMatch(/trkinfo|midtoken|sessionid|#/);
  });
  it("records import provenance and searches; batch payloads; test events", async () => {
    const imp = { import_id: "imp-9-xxxxxxxx", imported_by: "jai", imported_at: "2026-09-03T00:00:00.000Z", import_kind: "export", search_url: "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)", search_name: "cro", list_id: null, page: 2 };
    const b1 = JSON.stringify({ schema_version: "1", event: "leads.captured", event_id: eid(), sent_at: "t", source: { page_type: "salesnav_search", page_url: "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)", captured_by: "jai" }, leads: [lead({ full_name: "A B", linkedin_url: null, sales_navigator_url: "https://www.linkedin.com/sales/lead/ACwAAA00000001" }), lead({ full_name: "C D", linkedin_url: "https://www.linkedin.com/in/cd-xx" })], import: imp, custom: {} });
    expect((await post(b1, lweHeaders(b1))).json).toEqual({ ok: true, stored: 2 });
    const s = JSON.stringify({ schema_version: "1", event: "search.captured", event_id: eid(), sent_at: "t", source: { page_type: "salesnav_search", page_url: "u", captured_by: "jai" }, search: { search_url: "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)", surface: "sales_navigator", page_type: "salesnav_search", params: {}, query_expression: "(keywords:cro)", keywords: "cro", filters: { REGION: ["US"] }, total_hint: 490000, page: 1, list_id: null, captured_at: "t" }, custom: {} });
    expect((await post(s, lweHeaders(s))).json).toEqual({ ok: true, stored: 0, search: true });
    const t = JSON.stringify({ event: "test", event_id: eid() });
    expect((await post(t, lweHeaders(t))).json).toEqual({ ok: true, test: true });
    const imports = (await (await fetch(`${base}/imports`, { headers: admin })).json()) as any[];
    expect(imports.find((i) => i.import_id === "imp-9-xxxxxxxx")).toMatchObject({ imported_by: "jai", import_kind: "export", search_name: "cro", leads: 2 });
    const searches = (await (await fetch(`${base}/searches`, { headers: admin })).json()) as any[];
    expect(searches.find((x) => x.keywords === "cro")).toMatchObject({ surface: "sales_navigator", total_hint: 490000 });
  });
});
