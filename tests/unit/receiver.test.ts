/** End-to-end test of the reference receiver: spawn it with a secret and a temp
 *  SQLite file, POST signed payloads in both schemes, verify rows and replay handling. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const SECRET = "whsec_" + Buffer.from("receiver-key").toString("base64");
let proc: ChildProcess;
let base = "";

async function post(body: string, headers: Record<string, string>) {
  const res = await fetch(`${base}/hook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: res.status, json: await res.json().catch(() => null) };
}
function lweHeaders(body: string, ts = Math.floor(Date.now() / 1000)) {
  return { "x-lwe-timestamp": String(ts), "x-lwe-signature": "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex") };
}
function swHeaders(body: string, id: string, ts = Math.floor(Date.now() / 1000)) {
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": "v1," + createHmac("sha256", Buffer.from("receiver-key")).update(`${id}.${ts}.${body}`).digest("base64") };
}
const lead = (over: Record<string, unknown> = {}) => ({ full_name: "Jane Doe", first_name: "Jane", last_name: "Doe", headline: null, title: "VP", company_name: "Acme", company_linkedin_url: null, location: "Austin", linkedin_url: "https://www.linkedin.com/in/jane", linkedin_slug: "jane", linkedin_member_urn: null, sales_navigator_url: null, connection_degree: null, profile_image_url: null, about: null, experience: [{ title: "VP", company_name: "Acme", company_linkedin_url: null, date_range: null, location: null }], education: [], captured_at: "2026-09-03T00:00:00.000Z", ...over });

beforeAll(async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "lwe-recv-"));
  proc = spawn(process.execPath, [resolve(__dirname, "../../receiver/server.mjs")], { env: { ...process.env, PORT: "0", LWE_SECRET: SECRET, LWE_DB: resolve(dir, "t.sqlite") }, stdio: ["ignore", "pipe", "pipe"] });
  base = await new Promise<string>((res, rej) => {
    proc.stdout!.on("data", (d) => {
      const m = String(d).match(/http:\/\/localhost:(\d+)/);
      if (m) res(`http://127.0.0.1:${m[1]}`);
    });
    proc.stderr!.on("data", (d) => {
      if (/Error/.test(String(d))) rej(new Error(String(d)));
    });
    proc.on("exit", (c) => rej(new Error(`receiver exited ${c}`)));
  });
}, 20_000);
afterAll(() => proc.kill());

describe("reference receiver", () => {
  it("rejects unsigned, tampered and stale requests", async () => {
    const body = JSON.stringify({ event: "lead.captured", event_id: "e0", lead: lead() });
    expect((await post(body, {})).json).toEqual({ error: "missing_signature" });
    expect((await post(body, { ...lweHeaders(body), "x-lwe-signature": "sha256=" + "0".repeat(64) })).json).toEqual({ error: "signature_mismatch" });
    expect((await post(body, lweHeaders(body, Math.floor(Date.now() / 1000) - 1000))).json).toEqual({ error: "timestamp_out_of_window" });
    expect((await post(body + " ", lweHeaders(body))).status).toBe(401);
  });
  it("stores a generic single payload and dedupes replays by event id", async () => {
    const body = JSON.stringify({ schema_version: "1", event: "lead.captured", event_id: "e1", sent_at: "t", source: { page_type: "profile", page_url: "u", captured_by: "jai" }, lead: lead(), custom: { campaign: "q3" } });
    expect(await post(body, lweHeaders(body))).toEqual({ status: 200, json: { ok: true, stored: 1 } });
    expect((await post(body, lweHeaders(body))).json).toEqual({ ok: true, duplicate: true });
    const rows = await (await fetch(`${base}/leads`)).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupe_key: "https://www.linkedin.com/in/jane", full_name: "Jane Doe", title: "VP", company_name: "Acme", captured_by: "jai", page_type: "profile", send_count: 1 });
    expect(JSON.parse(rows[0].custom_json)).toEqual({ campaign: "q3" });
    expect(JSON.parse(rows[0].experience_json)).toHaveLength(1);
  });
  it("upserts on the identity key and accepts Standard Webhooks signatures + Deepline-flat bodies", async () => {
    const body = JSON.stringify({ linkedin_url: "https://www.linkedin.com/in/jane", first_name: "Jane", last_name: "Doe", title: "SVP", company_name: "Acme", company_domain: null, email: null, source: "linkedin-webhook-exporter", event_id: "e2", full_name: "Jane Doe", location: null, page_type: "profile", page_url: "u2", captured_by: "jai", custom_campaign: "q4" });
    expect(await post(body, swHeaders(body, "e2"))).toEqual({ status: 200, json: { ok: true, stored: 1 } });
    const rows = await (await fetch(`${base}/leads`)).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "SVP", location: "Austin", send_count: 2, page_url: "u2" });
    expect(JSON.parse(rows[0].custom_json)).toEqual({ campaign: "q4" });
  });
  it("records import provenance in sales_nav_imports", async () => {
    const imp = { import_id: "imp-9", imported_by: "jai", imported_at: "2026-09-03T00:00:00.000Z", import_kind: "export", search_url: "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)", search_name: "cro", list_id: null, page: 2 };
    const body = JSON.stringify({ schema_version: "1", event: "lead.captured", event_id: "e5", sent_at: "t", source: { page_type: "salesnav_search", page_url: "u", captured_by: "jai" }, lead: lead({ full_name: "Imp Orted", linkedin_url: null, sales_navigator_url: "https://www.linkedin.com/sales/lead/ACw9" }), import: imp, custom: {} });
    expect((await post(body, lweHeaders(body))).json).toEqual({ ok: true, stored: 1 });
    const flat = JSON.stringify({ event: "lead.captured", event_id: "e6", full_name: "Flat Import", first_name: "Flat", last_name: "Import", linkedin_url: "https://www.linkedin.com/in/flat", import_id: "imp-9", imported_by: "jai", import_kind: "export", import_search_name: "cro", import_page: 2 });
    expect((await post(flat, lweHeaders(flat))).json).toEqual({ ok: true, stored: 1 });
    const imports = await (await fetch(`${base}/imports`)).json();
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ import_id: "imp-9", imported_by: "jai", import_kind: "export", search_name: "cro", leads: 2 });
  });
  it("stores batch payloads and test events", async () => {
    const body = JSON.stringify({ schema_version: "1", event: "leads.captured", event_id: "e3", sent_at: "t", source: { page_type: "salesnav_search", page_url: "u", captured_by: null }, leads: [lead({ full_name: "A B", linkedin_url: null, sales_navigator_url: "https://www.linkedin.com/sales/lead/ACw1" }), lead({ full_name: "C D", linkedin_url: "https://www.linkedin.com/in/cd" })], custom: {} });
    expect((await post(body, lweHeaders(body))).json).toEqual({ ok: true, stored: 2 });
    const t = JSON.stringify({ event: "test", event_id: "e4" });
    expect((await post(t, lweHeaders(t))).json).toEqual({ ok: true, test: true });
    const rows = await (await fetch(`${base}/leads`)).json();
    const keys = rows.map((r: any) => r.dedupe_key);
    for (const k of ["https://www.linkedin.com/in/cd", "https://www.linkedin.com/in/jane", "https://www.linkedin.com/sales/lead/acw1"]) expect(keys).toContain(k);
  });
});
