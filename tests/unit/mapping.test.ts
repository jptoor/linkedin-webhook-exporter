import { describe, expect, it } from "vitest";
import { buildBodies, buildSearchBody, flattenLead, isPayload, toDeeplineRow } from "../../src/shared/mapping";
import { buildSearchRecord } from "../../src/shared/search";
import type { LeadRecord, SourceInfo } from "../../src/shared/types";

const lead: LeadRecord = {
  full_name: "Jane Doe", first_name: "Jane", last_name: "Doe", headline: "VP Sales at Acme", title: "VP Sales", company_name: "Acme", company_linkedin_url: "https://www.linkedin.com/company/acme", location: "Austin", linkedin_url: "https://www.linkedin.com/in/jane", linkedin_slug: "jane", linkedin_member_urn: null, sales_navigator_url: null, connection_degree: "2nd", profile_image_url: null, about: null,
  experience: [{ title: "VP Sales", company_name: "Acme", company_linkedin_url: null, date_range: "2023 - Present", location: null }], education: [], captured_at: "2026-09-03T00:00:00.000Z", parse_warnings: ["location_guessed"]
};
const lead2: LeadRecord = { ...lead, full_name: "Evan Park", first_name: "Evan", last_name: "Park", linkedin_url: "https://www.linkedin.com/in/evan", linkedin_slug: "evan", parse_warnings: [] };
const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: "0.1.0", page_type: "profile", page_url: "https://www.linkedin.com/in/jane/", captured_by: "jai" };
let n = 0;
const opts = (preset: "generic" | "flat" | "deepline", mode: "single" | "batch") => ({ preset, mode, source, custom: { campaign: "q3" }, eventId: () => `evt-${++n}-xxxxxxxx`, sentAt: "2026-09-03T00:00:01.000Z" });
const imp = { import_id: "imp-1-xxxxxxxx", imported_by: "jai", imported_at: "t", import_kind: "export" as const, search_url: "https://www.linkedin.com/sales/search/people?query=x", search_name: "cro · region: US", list_id: null, page: 3 };

describe("every preset carries the versioned envelope", () => {
  it("single and batch, all presets", () => {
    for (const preset of ["generic", "flat", "deepline"] as const) {
      for (const mode of ["single", "batch"] as const) {
        for (const b of buildBodies([lead, lead2], opts(preset, mode))) {
          expect(isPayload(b.body)).toBe(true);
          expect(b.body).toMatchObject({ schema_version: "1", event: mode === "single" ? "lead.captured" : "leads.captured", event_id: b.eventId });
        }
      }
    }
    expect(isPayload(buildSearchBody(buildSearchRecord("https://www.linkedin.com/search/results/people/?keywords=x", "people_search", null, "t"), "flat", source, {}, "evt-search-xxx", "t"))).toBe(true);
    expect(isPayload({ schema_version: "1" })).toBe(false);
    expect(isPayload({ schema_version: "1", event: "evil", event_id: "x" })).toBe(false);
    expect(isPayload(null)).toBe(false);
  });
});

describe("generic preset", () => {
  it("single mode wraps each lead", () => {
    const bodies = buildBodies([lead, lead2], opts("generic", "single"));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].body).toMatchObject({ source, lead, import: null, custom: { campaign: "q3" } });
    expect(bodies[0].eventId).not.toBe(bodies[1].eventId);
  });
  it("batch mode sends one envelope with leads[]", () => {
    const [b] = buildBodies([lead, lead2], opts("generic", "batch"));
    expect(b.body).toMatchObject({ event: "leads.captured", leads: [lead, lead2] });
    expect(b.leads).toHaveLength(2);
  });
});

describe("flat preset", () => {
  it("flattens to one level, prefixes custom, serializes history and warnings", () => {
    const flat = flattenLead(lead, source, { campaign: "q3", custom_owner: "x" }, "e1", "t");
    expect(flat).toMatchObject({ schema_version: "1", event: "lead.captured", event_id: "e1", full_name: "Jane Doe", linkedin_url: "https://www.linkedin.com/in/jane", page_type: "profile", captured_by: "jai", extension_version: "0.1.0", custom_campaign: "q3", custom_owner: "x", parse_warnings: "location_guessed" });
    expect(flat.experience).toBeUndefined();
    expect(JSON.parse(flat.experience_json as string)).toHaveLength(1);
    expect(flat.education_json).toBeNull();
    for (const v of Object.values(flat)) expect(typeof v === "object" && v !== null).toBe(false);
    expect(flattenLead(lead2, source, {}, "e", "t").parse_warnings).toBeNull();
  });
  it("batch mode wraps flat rows and repeats source/import/custom on the envelope", () => {
    const [b] = buildBodies([lead, lead2], { ...opts("flat", "batch"), import: imp });
    expect(b.body).toMatchObject({ event: "leads.captured", page_type: "profile", import_id: imp.import_id, custom_campaign: "q3" });
    expect((b.body as { rows: unknown[] }).rows).toHaveLength(2);
  });
});

describe("import info", () => {
  it("is nested in generic bodies and prefixed in flat bodies", () => {
    const [g] = buildBodies([lead], { ...opts("generic", "single"), import: imp });
    expect((g.body as { import: unknown }).import).toEqual(imp);
    const [f] = buildBodies([lead], { ...opts("flat", "single"), import: imp });
    expect(f.body).toMatchObject({ import_id: imp.import_id, imported_by: "jai", import_kind: "export", import_search_name: "cro · region: US", import_page: 3 });
  });
});

describe("deepline preset", () => {
  it("uses Deepline field names first and keeps the envelope + flat fields", () => {
    const row = toDeeplineRow(lead, source, {}, "e1", "t");
    expect(Object.keys(row).slice(0, 4)).toEqual(["schema_version", "event", "event_id", "sent_at"]);
    expect(Object.keys(row).slice(4, 9)).toEqual(["linkedin_url", "first_name", "last_name", "title", "company_name"]);
    expect(row).toMatchObject({ company_domain: null, email: null, source: "linkedin-webhook-exporter", location: "Austin", page_type: "profile" });
    expect(row.job_title).toBeUndefined();
  });
});

describe("search bodies", () => {
  it("generic keeps the nested search; flat serializes params/filters and redacts sessions", () => {
    const rec = buildSearchRecord("https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&sessionId=S", "salesnav_search", 490000, "t");
    const g = buildSearchBody(rec, "generic", source, {}, "evt-s-xxxxxxx", "t") as Record<string, unknown>;
    expect(g).toMatchObject({ event: "search.captured", search: { keywords: "cro", total_hint: 490000 } });
    const f = buildSearchBody(rec, "deepline", source, { a: "b" }, "evt-s-xxxxxxx", "t") as Record<string, unknown>;
    expect(f).toMatchObject({ event: "search.captured", keywords: "cro", page_url: source.page_url, custom_a: "b" });
    expect(JSON.stringify(f)).not.toContain("sessionId=S");
    expect(typeof f.params_json).toBe("string");
  });
});
