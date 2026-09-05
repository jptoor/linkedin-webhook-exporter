import { describe, expect, it } from "vitest";
import { ApiIndex, enrichLead, INTERCEPT_PATTERNS, isInterceptedUrl, parseInterceptedResponse } from "../../src/shared/linkedin-api";
import type { LeadRecord } from "../../src/shared/types";

const lead = (over: Partial<LeadRecord> = {}): LeadRecord => ({ full_name: "Bob Okafor", full_name_raw: null, first_name: "Bob", last_name: "Okafor", headline: null, title: null, company_name: null, company_linkedin_url: null, location: null, linkedin_url: null, linkedin_slug: null, linkedin_member_urn: "ACwAAAdef456", sales_navigator_url: "https://www.linkedin.com/sales/lead/ACwAAAdef456", connection_degree: null, profile_image_url: null, about: null, experience: [], education: [], captured_at: "t", parse_warnings: ["company_missing", "location_missing"], ...over });

/** Shape of a Sales Navigator lead-search response (fields LinkedIn returns today). */
const SALES = JSON.stringify({
  paging: { count: 25, start: 0, total: 1234 },
  elements: [
    {
      entityUrn: "urn:li:fs_salesProfile:(ACwAAAdef456,NAME_SEARCH,xyz2)",
      objectUrn: "urn:li:member:99887766",
      firstName: "Bob",
      lastName: "Okafor",
      fullName: "Bob Okafor",
      geoRegion: "Lagos, Nigeria",
      degree: 3,
      summary: "Revenue leader.",
      flagshipProfileUrl: "https://www.linkedin.com/in/bob-okafor-1a2b3c",
      currentPositions: [{ title: "Chief Revenue Officer", companyName: "Umbrella Group", companyUrn: "urn:li:fs_salesCompany:12345", current: true, companyUrnResolutionResult: { name: "Umbrella Group", entityUrn: "urn:li:fs_salesCompany:12345" } }],
      profilePictureDisplayImage: { rootUrl: "https://media.licdn.com/dms/image/x/", artifacts: [{ width: 100, fileIdentifyingUrlPathSegment: "100.jpg" }, { width: 200, fileIdentifyingUrlPathSegment: "200.jpg" }] }
    },
    { entityUrn: "urn:li:fs_salesProfile:(ACwAAAghi789,NAME_SEARCH,xyz3)", firstName: "Carla", lastName: "Mendes", geoRegion: "Lisbon", degree: 2, currentPositions: [] },
    { entityUrn: "urn:li:fs_salesCompany:555", name: "Not a person" }
  ]
});

/** Voyager people-search cluster response (2026 layout). */
const VOYAGER = JSON.stringify({
  data: { searchDashClustersByAll: { elements: [] } },
  included: [
    { $type: "com.linkedin.voyager.dash.search.EntityResultViewModel", entityUrn: "urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAAqqqqqq,SEARCH_SRP,DEFAULT)", title: { text: "Dana White" }, primarySubtitle: { text: "Account Executive at Hooli" }, secondarySubtitle: { text: "Austin, Texas, United States" }, navigationUrl: "https://www.linkedin.com/in/dana-white-99?miniProfileUrn=x", entityCustomTrackingInfo: { memberDistance: "DISTANCE_2" } },
    { $type: "com.linkedin.voyager.dash.identity.profile.Profile", entityUrn: "urn:li:fsd_profile:ACoAAAzzzzzz", firstName: "Zoë", lastName: "Ångström", publicIdentifier: "zoe-angstrom-å", headline: "CRO at Ångström & Sons", geoLocation: { defaultLocalizedName: "Stockholm, Sweden" } },
    { $type: "com.linkedin.voyager.dash.common.Ad", title: { text: "Buy now" } }
  ]
});

describe("intercept patterns", () => {
  it("match the same LinkedIn endpoints Frontier reads and nothing else", () => {
    expect(INTERCEPT_PATTERNS.length).toBeGreaterThanOrEqual(8);
    expect(isInterceptedUrl("https://www.linkedin.com/sales-api/salesApiLeadSearch?q=searchQuery&query=(x)")).toBe(true);
    expect(isInterceptedUrl("https://www.linkedin.com/voyager/api/graphql?queryId=voyagerSearchDashClusters")).toBe(true);
    expect(isInterceptedUrl("https://www.linkedin.com/voyager/api/messaging/conversations")).toBe(false);
    expect(isInterceptedUrl("https://www.linkedin.com/feed/")).toBe(false);
  });
});

describe("parseInterceptedResponse", () => {
  it("reads Sales Navigator people with names, role, company, region, degree, photo and the flagship URL", () => {
    const r = parseInterceptedResponse("https://www.linkedin.com/sales-api/salesApiLeadSearch?x", SALES);
    expect(r.kind).toBe("sales");
    expect(r.meta).toEqual({ total: 1234, start: 0, count: 25 });
    expect(r.people).toHaveLength(2);
    const bob = r.people.find((p) => p.sales_id === "ACwAAAdef456")!;
    expect(bob).toMatchObject({ full_name: "Bob Okafor", first_name: "Bob", last_name: "Okafor", title: "Chief Revenue Officer", company_name: "Umbrella Group", company_linkedin_url: "https://www.linkedin.com/company/12345", location: "Lagos, Nigeria", connection_degree: "3rd", linkedin_url: "https://www.linkedin.com/in/bob-okafor-1a2b3c", public_identifier: "bob-okafor-1a2b3c", profile_image_url: "https://media.licdn.com/dms/image/x/200.jpg", about: "Revenue leader." });
    const carla = r.people.find((p) => p.sales_id === "ACwAAAghi789")!;
    expect(carla).toMatchObject({ full_name: "Carla Mendes", title: null, linkedin_url: null, connection_degree: "2nd" });
  });
  it("reads Voyager entity results and dash profiles, skipping non-people", () => {
    const r = parseInterceptedResponse("https://www.linkedin.com/voyager/api/graphql?x", VOYAGER);
    expect(r.kind).toBe("voyager");
    expect(r.people).toHaveLength(2);
    const dana = r.people.find((p) => p.public_identifier === "dana-white-99")!;
    expect(dana).toMatchObject({ full_name: "Dana White", first_name: "Dana", last_name: "White", headline: "Account Executive at Hooli", location: "Austin, Texas, United States", linkedin_url: "https://www.linkedin.com/in/dana-white-99", connection_degree: "2nd", profile_id: "ACoAAAqqqqqq" });
    const zoe = r.people.find((p) => p.profile_id === "ACoAAAzzzzzz")!;
    expect(zoe).toMatchObject({ full_name: "Zoë Ångström", headline: "CRO at Ångström & Sons", location: "Stockholm, Sweden", linkedin_url: "https://www.linkedin.com/in/zoe-angstrom-%C3%A5" });
  });
  it("survives junk, hostile and huge payloads", () => {
    expect(parseInterceptedResponse("https://www.linkedin.com/sales-api/salesApiLeadSearch", "not json").people).toEqual([]);
    expect(parseInterceptedResponse("https://www.linkedin.com/sales-api/salesApiLeadSearch", JSON.stringify({ elements: [{ entityUrn: "urn:li:fs_salesProfile:(ACwAAAevil1234,x)", fullName: "Evil", flagshipProfileUrl: "https://evil.example/in/x", profilePictureDisplayImage: { rootUrl: "https://evil.example/", artifacts: [{ fileIdentifyingUrlPathSegment: "a.jpg" }] } }] })).people[0]).toMatchObject({ linkedin_url: null, profile_image_url: null });
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: { n: 1 } } } } } } } } } } } } } };
    expect(parseInterceptedResponse("https://www.linkedin.com/sales-api/salesApiLeadSearch", JSON.stringify(deep)).people).toEqual([]);
    const big = { elements: Array.from({ length: 30_000 }, (_, i) => ({ entityUrn: `urn:li:fs_salesProfile:(ACwAAA${String(i).padStart(6, "0")},x)`, fullName: `P ${i}` })) };
    const r = parseInterceptedResponse("https://www.linkedin.com/sales-api/salesApiLeadSearch", JSON.stringify(big));
    expect(r.people.length).toBeLessThan(30_000); // bounded walk
    expect(r.people.length).toBeGreaterThan(1000);
  });
});

describe("ApiIndex + enrichLead", () => {
  it("fills what the DOM could not read and adds the public URL; DOM values win when clean", () => {
    const idx = new ApiIndex();
    idx.ingest("https://www.linkedin.com/sales-api/salesApiLeadSearch", SALES);
    expect(idx.total).toBe(1234);
    const api = idx.lookup(lead());
    expect(api?.sales_id).toBe("ACwAAAdef456");
    const out = enrichLead(lead({ title: "CRO" }), api);
    expect(out).toMatchObject({ title: "CRO", company_name: "Umbrella Group", company_linkedin_url: "https://www.linkedin.com/company/12345", location: "Lagos, Nigeria", connection_degree: "3rd", linkedin_url: "https://www.linkedin.com/in/bob-okafor-1a2b3c", linkedin_slug: "bob-okafor-1a2b3c", about: "Revenue leader." });
    expect(out.parse_warnings).toEqual(["api_merged"]);
    expect(enrichLead(lead(), null)).toEqual(lead());
  });
  it("matches Voyager rows by public slug and unknown people by name + company", () => {
    const idx = new ApiIndex();
    idx.ingest("https://www.linkedin.com/voyager/api/graphql", VOYAGER);
    const dana = enrichLead(lead({ full_name: "Dana White", first_name: "Dana", last_name: "White", linkedin_url: "https://www.linkedin.com/in/dana-white-99", linkedin_slug: "dana-white-99", linkedin_member_urn: null, sales_navigator_url: null, parse_warnings: ["location_missing"] }), idx.lookup(lead({ full_name: "Dana White", linkedin_slug: "dana-white-99", linkedin_member_urn: null, sales_navigator_url: null })));
    expect(dana.location).toBe("Austin, Texas, United States");
    expect(dana.connection_degree).toBe("2nd");
    expect(idx.lookup(lead({ full_name: "Nobody Here", linkedin_member_urn: null, sales_navigator_url: null }))).toBeNull();
  });
});

describe("enrichLead honours the About setting", () => {
  it("never fills `about` from the API when includeAbout is false", async () => {
    const { enrichLead } = await import("../../src/shared/linkedin-api");
    const lead = { full_name: "Ada Lovelace", full_name_raw: null, first_name: "Ada", last_name: "Lovelace", headline: null, title: null, company_name: null, company_linkedin_url: null, location: null, linkedin_url: "https://www.linkedin.com/in/ada", linkedin_slug: "ada", linkedin_member_urn: null, sales_navigator_url: null, connection_degree: null, profile_image_url: null, about: null, experience: [], education: [], captured_at: "t", parse_warnings: [] } as LeadRecord;
    const api = { full_name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace", headline: "Analyst", title: null, company_name: null, company_linkedin_url: null, location: "London", linkedin_url: "https://www.linkedin.com/in/ada", linkedin_slug: "ada", linkedin_member_urn: null, sales_navigator_url: null, connection_degree: null, profile_image_url: null, about: "Long bio", source: "voyager" as const };
    expect(enrichLead({ ...lead }, api as never, { includeAbout: false }).about).toBeNull();
    expect(enrichLead({ ...lead }, api as never, { includeAbout: true }).about).toBe("Long bio");
    expect(enrichLead({ ...lead }, api as never).headline).toBe("Analyst");
  });
});
