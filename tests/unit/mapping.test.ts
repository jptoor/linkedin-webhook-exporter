import { describe, expect, it } from "vitest";
import { buildBodies, flattenLead, toDeeplineRow } from "../../src/shared/mapping";
import type { LeadRecord, SourceInfo } from "../../src/shared/types";

const lead: LeadRecord = {
  full_name: "Jane Doe", first_name: "Jane", last_name: "Doe", headline: "VP Sales at Acme", title: "VP Sales", company_name: "Acme", company_linkedin_url: "https://www.linkedin.com/company/acme", location: "Austin", linkedin_url: "https://www.linkedin.com/in/jane", linkedin_slug: "jane", linkedin_member_urn: null, sales_navigator_url: null, connection_degree: "2nd", profile_image_url: null, about: null,
  experience: [{ title: "VP Sales", company_name: "Acme", company_linkedin_url: null, date_range: "2023 - Present", location: null }], education: [], captured_at: "2026-09-03T00:00:00.000Z"
};
const lead2: LeadRecord = { ...lead, full_name: "Evan Park", first_name: "Evan", last_name: "Park", linkedin_url: "https://www.linkedin.com/in/evan", linkedin_slug: "evan" };
const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: "0.1.0", page_type: "profile", page_url: "https://www.linkedin.com/in/jane/", captured_by: "jai" };
let n = 0;
const opts = (preset: "generic" | "flat" | "deepline", mode: "single" | "batch") => ({ preset, mode, source, custom: { campaign: "q3" }, eventId: () => `evt-${++n}`, sentAt: "2026-09-03T00:00:01.000Z" });

describe("generic preset", () => {
  it("single mode wraps each lead in a versioned envelope", () => {
    const bodies = buildBodies([lead, lead2], opts("generic", "single"));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].body).toMatchObject({ schema_version: "1", event: "lead.captured", source, lead, custom: { campaign: "q3" } });
    expect(bodies[0].eventId).toBe((bodies[0].body as { event_id: string }).event_id);
    expect(bodies[0].eventId).not.toBe(bodies[1].eventId);
  });
  it("batch mode sends one envelope with leads[]", () => {
    const bodies = buildBodies([lead, lead2], opts("generic", "batch"));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].body).toMatchObject({ event: "leads.captured", leads: [lead, lead2] });
    expect(bodies[0].leads).toHaveLength(2);
  });
});

describe("flat preset", () => {
  it("flattens to one level with custom_ prefixed fields", () => {
    const flat = flattenLead(lead, source, { campaign: "q3", custom_owner: "x" }, "e1", "t");
    expect(flat).toMatchObject({ event_id: "e1", full_name: "Jane Doe", first_name: "Jane", linkedin_url: "https://www.linkedin.com/in/jane", page_type: "profile", captured_by: "jai", custom_campaign: "q3", custom_owner: "x" });
    expect(flat.experience).toBeUndefined();
    expect(JSON.parse(flat.experience_json as string)).toHaveLength(1);
    expect(flat.education_json).toBeNull();
    for (const v of Object.values(flat)) expect(typeof v === "object" && v !== null).toBe(false);
  });
  it("batch mode wraps flat rows in rows[]", () => {
    const [b] = buildBodies([lead, lead2], opts("flat", "batch"));
    expect((b.body as { rows: unknown[] }).rows).toHaveLength(2);
  });
});

describe("import info", () => {
  const imp = { import_id: "imp-1", imported_by: "jai", imported_at: "t", import_kind: "export" as const, search_url: "https://www.linkedin.com/sales/search/people?query=x", search_name: "cro · region: US", list_id: null, page: 3 };
  it("is nested in generic bodies and prefixed in flat bodies", () => {
    const [g] = buildBodies([lead], { ...opts("generic", "single"), import: imp });
    expect((g.body as { import: unknown }).import).toEqual(imp);
    const [f] = buildBodies([lead], { ...opts("flat", "single"), import: imp });
    expect(f.body).toMatchObject({ import_id: "imp-1", imported_by: "jai", import_kind: "export", import_search_name: "cro · region: US", import_page: 3 });
    const [b] = buildBodies([lead, lead2], { ...opts("deepline", "batch"), import: imp });
    expect(b.body).toMatchObject({ import_id: "imp-1" });
    expect((b.body as { rows: Array<Record<string, unknown>> }).rows[0].import_id).toBe("imp-1");
  });
});

describe("deepline preset", () => {
  it("uses Deepline field names and keeps the flat fields", () => {
    const row = toDeeplineRow(lead, source, {}, "e1", "t");
    expect(row).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/jane", first_name: "Jane", last_name: "Doe", full_name: "Jane Doe", title: "VP Sales", company_name: "Acme", company_domain: null, email: null, source: "linkedin-webhook-exporter", company_linkedin_url: "https://www.linkedin.com/company/acme", location: "Austin", page_type: "profile" });
    expect(Object.keys(row).slice(0, 5)).toEqual(["linkedin_url", "first_name", "last_name", "title", "company_name"]);
    expect(row.job_title).toBeUndefined();
  });
});
