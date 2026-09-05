import { describe, expect, it } from "vitest";
import { buildLeadRuns, buildSearchRun, inferPlayInput, listPlays, normalizeBaseUrl, runIdFrom, summarizePlayInput, testApiKey, unfillableRequired } from "../../src/shared/deepline";
import { addToBasket, basketPages, groupByPage, removeFromBasket } from "../../src/shared/basket";
import type { ImportInfo, LeadRecord, SearchRecord, SourceInfo } from "../../src/shared/types";

const lead = (i: number, over: Partial<LeadRecord> = {}): LeadRecord => ({ full_name: `Person ${i}`, full_name_raw: null, first_name: "Person", last_name: String(i), headline: null, title: "VP Sales", company_name: "Acme", company_linkedin_url: null, location: "Austin", linkedin_url: `https://www.linkedin.com/in/person-${i}`, linkedin_slug: `person-${i}`, linkedin_member_urn: null, sales_navigator_url: null, connection_degree: "2nd", profile_image_url: null, about: null, experience: [], education: [], captured_at: "t", parse_warnings: [], ...over });
const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: "t", page_type: "salesnav_search", page_url: "https://www.linkedin.com/sales/search/people?query=x", captured_by: "jai" };
const imp: ImportInfo = { import_id: "imp-1", imported_by: "jai", imported_at: "t", import_kind: "basket", search_url: "https://www.linkedin.com/sales/search/people?query=x", search_name: "cro", list_id: null, page: 2 };
let n = 0;
const ids = () => `e${++n}`;

describe("inferPlayInput", () => {
  it("batch when the play takes leads[]", () => {
    expect(inferPlayInput({ type: "object", properties: { leads: { type: "array" }, campaign: { type: "string" } }, required: ["leads"] })).toMatchObject({ mode: "batch", acceptsLeads: true, acceptsSearch: false, required: ["leads"] });
  });
  it("lead when the play takes lead{}", () => {
    expect(inferPlayInput({ properties: { lead: { type: "object" } } }).mode).toBe("lead");
  });
  it("mapped for field-name inputs; search when a URL field is declared; anything when there is no schema", () => {
    const m = inferPlayInput({ properties: { linkedin_url: { type: "string" }, domain: { type: "string" } }, required: ["linkedin_url"] });
    expect(m).toMatchObject({ mode: "mapped", acceptsLeads: true, acceptsSearch: false });
    expect(inferPlayInput({ properties: { search_url: { type: "string" }, limit: { type: "integer" } } })).toMatchObject({ acceptsSearch: true, acceptsLeads: false });
    expect(inferPlayInput({ properties: { url: { type: "string" } } })).toMatchObject({ acceptsSearch: true, acceptsLeads: false });
    expect(inferPlayInput({ properties: { url: { type: "string" }, linkedin_url: { type: "string" } } })).toMatchObject({ acceptsSearch: true, acceptsLeads: true });
    expect(inferPlayInput(null)).toMatchObject({ mode: "mapped", fields: [], acceptsLeads: true, acceptsSearch: true });
    expect(summarizePlayInput(inferPlayInput(null))).toMatch(/any input/);
    expect(summarizePlayInput(m)).toMatch(/leads · one run per lead \(mapped fields\) · required: linkedin_url/);
  });
  it("reports required fields the extension cannot fill", () => {
    const spec = inferPlayInput({ properties: { linkedin_url: {}, domain: {}, email: {} }, required: ["linkedin_url", "domain"] });
    expect(unfillableRequired(spec, "leads")).toEqual(["domain"]);
    expect(unfillableRequired(inferPlayInput({ properties: { search_url: {}, account_id: {} }, required: ["search_url", "account_id"] }), "search")).toEqual(["account_id"]);
    expect(unfillableRequired(inferPlayInput(null), "leads")).toEqual([]);
  });
});

describe("buildLeadRuns", () => {
  it("batch: one run carrying all rows plus provenance", () => {
    const runs = buildLeadRuns(inferPlayInput({ properties: { leads: { type: "array" } } }), [lead(1), lead(2)], source, imp, { campaign: "q3" }, ids, "t");
    expect(runs).toHaveLength(1);
    expect(runs[0].leads).toHaveLength(2);
    expect(runs[0].input).toMatchObject({ import_id: "imp-1", import_search_name: "cro", custom: { campaign: "q3" }, source: "linkedin-webhook-exporter" });
    expect((runs[0].input.leads as unknown[]).length).toBe(2);
    expect((runs[0].input.leads as Array<Record<string, unknown>>)[0]).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/person-1", first_name: "Person", company_name: "Acme", email: null });
  });
  it("mapped: one run per lead with only the declared fields, Sales Navigator URL as a fallback", () => {
    const spec = inferPlayInput({ properties: { linkedin_url: {}, first_name: {}, last_name: {}, company: {}, domain: {} } });
    const runs = buildLeadRuns(spec, [lead(1), lead(2, { linkedin_url: null, sales_navigator_url: "https://www.linkedin.com/sales/lead/ACwAAAxxxxxx" })], source, imp, {}, ids, "t");
    expect(runs).toHaveLength(2);
    expect(runs[0].input).toEqual({ linkedin_url: "https://www.linkedin.com/in/person-1", first_name: "Person", last_name: "1", company: "Acme" });
    expect(runs[1].input.linkedin_url).toBe("https://www.linkedin.com/sales/lead/ACwAAAxxxxxx");
    expect(runs[1].label).toBe("Person 2");
  });
  it("no schema: the flat Deepline row per lead", () => {
    const [r] = buildLeadRuns(inferPlayInput(null), [lead(3)], source, null, {}, ids, "t");
    expect(r.input).toMatchObject({ event: "lead.captured", linkedin_url: "https://www.linkedin.com/in/person-3", title: "VP Sales", page_type: "salesnav_search" });
  });
});

describe("buildSearchRun", () => {
  const search: SearchRecord = { search_url: "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)", page_type: "salesnav_search", surface: "sales_navigator", params: { query: "(keywords:cro)" }, query_expression: "(keywords:cro)", keywords: "cro", filters: {}, total_hint: 320, limit: 100, page: 1, list_id: null, saved_search_id: "123", captured_at: "t" };
  it("fills whichever URL field the play declares and only declared fields", () => {
    expect(buildSearchRun(inferPlayInput({ properties: { sales_navigator_url: {}, max_results: {}, name: {} } }), search, source, imp, {}, "CROs")).toEqual({ sales_navigator_url: search.search_url, max_results: 100, name: "CROs" });
    const full = buildSearchRun(inferPlayInput(null), search, source, imp, { campaign: "q3" }, "CROs");
    expect(full).toMatchObject({ search_url: search.search_url, search_name: "CROs", limit: 100, saved_search_id: "123", imported_by: "jai", import_id: "imp-1", custom: { campaign: "q3" } });
  });
});

describe("API helpers", () => {
  it("normalizes base URLs and rejects insecure or credentialed ones", () => {
    expect(normalizeBaseUrl("https://code.deepline.com/")).toBe("https://code.deepline.com");
    expect(normalizeBaseUrl("")).toBe("https://code.deepline.com");
    expect(normalizeBaseUrl("http://localhost:3000/x")).toBe("http://localhost:3000");
    expect(() => normalizeBaseUrl("http://deepline.example")).toThrow();
    expect(() => normalizeBaseUrl("https://u:p@code.deepline.com")).toThrow();
  });
  it("lists owned then prebuilt plays with inferred input specs; rejects a bad key", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
      const owned = url.includes("origin=owned");
      return new Response(JSON.stringify({ plays: owned ? [{ playKey: "acme/linkedin-capture", name: "linkedin-capture", displayName: "", inputSchema: { properties: { leads: { type: "array" } } } }] : [{ playKey: "prebuilt/person-linkedin-to-email", name: "person-linkedin-to-email", displayName: "Email from LinkedIn", inputSchema: { properties: { linkedin_url: { type: "string" } }, required: ["linkedin_url"] } }, { playKey: "acme/linkedin-capture" }] }), { status: 200 });
    };
    const plays = await listPlays("https://code.deepline.com", "k", fetchImpl);
    expect(calls).toHaveLength(2);
    expect(plays.map((p) => p.playKey)).toEqual(["acme/linkedin-capture", "prebuilt/person-linkedin-to-email"]);
    expect(plays[0]).toMatchObject({ displayName: "linkedin-capture", origin: "owned", input: { mode: "batch" } });
    expect(plays[1].input).toMatchObject({ mode: "mapped", required: ["linkedin_url"] });
    await expect(listPlays("https://code.deepline.com", "bad", async () => new Response("", { status: 401 }))).rejects.toThrow(/rejected the API key/);
    expect(await testApiKey("https://code.deepline.com", "k", async () => new Response("{}", { status: 200 }))).toEqual({ ok: true, status: 200, error: null });
    expect(await testApiKey("https://code.deepline.com", "k", async () => new Response("", { status: 403 }))).toMatchObject({ ok: false, error: "API key rejected" });
  });
  it("finds the run id under the usual names", () => {
    expect(runIdFrom({ workflowId: "wf1" })).toBe("wf1");
    expect(runIdFrom({ run: { id: "r1" } })).toBe("r1");
    expect(runIdFrom({ ok: true })).toBeNull();
    expect(runIdFrom("x")).toBeNull();
  });
});

describe("basket", () => {
  it("adds without duplicates, caps size, groups by source page", () => {
    const p1 = "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&page=1&sessionId=A";
    const p2 = "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&page=2&sessionId=B";
    const p3 = "https://www.linkedin.com/sales/search/people?query=(keywords%3Acto)&sessionId=C";
    let b = addToBasket({}, [lead(1), lead(1), lead(2)], "salesnav_search", p1, "Search", 1).basket;
    b = addToBasket(b, [lead(3)], "salesnav_search", p2, "Search", 2).basket;
    b = addToBasket(b, [lead(4)], "salesnav_search", p3, "Search", 3).basket;
    expect(Object.keys(b)).toHaveLength(4);
    // Pages 1 and 2 of the same search count as one source; a different query is another.
    expect(basketPages(b)).toBe(2);
    const groups = groupByPage(Object.values(b));
    expect(groups.map((g) => g.leads.length)).toEqual([2, 1, 1]); // page 1, page 2, other search
    const full = addToBasket(b, [lead(5), lead(6)], "salesnav_search", p1, null, 4, 5);
    expect(full.full).toBe(true);
    expect(full.added).toEqual(["https://www.linkedin.com/in/person-5"]);
    expect(Object.keys(removeFromBasket(b, ["https://www.linkedin.com/in/person-1", "nope"]))).toHaveLength(3);
  });
});
