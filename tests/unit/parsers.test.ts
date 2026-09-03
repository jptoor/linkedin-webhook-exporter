import { describe, expect, it } from "vitest";
import { detectPageType, parsePage } from "../../src/content/parsers";
import { parseProfile } from "../../src/content/parsers/profile";
import { parseSalesNavPage } from "../../src/content/parsers/salesnav";
import { parsePeopleSearchPage } from "../../src/content/parsers/search";
import { loadFixture } from "./helpers";

const NOW = "2026-09-03T12:00:00.000Z";

describe("detectPageType", () => {
  it("routes LinkedIn paths", () => {
    expect(detectPageType("/in/jane-doe-123/")).toBe("profile");
    expect(detectPageType("/in/jane-doe-123")).toBe("profile");
    expect(detectPageType("/in/jane-doe-123/details/experience/")).toBeNull();
    expect(detectPageType("/sales/search/people?query=x")).toBe("salesnav_search");
    expect(detectPageType("/sales/lists/people/123")).toBe("salesnav_list");
    expect(detectPageType("/sales/lead/ACwAAA,NAME_SEARCH,x")).toBe("salesnav_lead");
    expect(detectPageType("/search/results/people/")).toBe("people_search");
    expect(detectPageType("/feed/")).toBeNull();
  });
});

describe("parseProfile", () => {
  const url = "https://www.linkedin.com/in/jane-doe-123/";
  const doc = loadFixture("profile.html", url);
  const lead = parseProfile(doc, url, { now: NOW });

  it("extracts identity fields", () => {
    expect(lead.full_name).toBe("Jane Doe");
    expect(lead.first_name).toBe("Jane");
    expect(lead.last_name).toBe("Doe");
    expect(lead.linkedin_url).toBe("https://www.linkedin.com/in/jane-doe-123");
    expect(lead.linkedin_slug).toBe("jane-doe-123");
    expect(lead.connection_degree).toBe("2nd");
    expect(lead.profile_image_url).toBe("https://media.licdn.com/dms/image/jane.jpg");
    expect(lead.captured_at).toBe(NOW);
  });
  it("extracts headline, location, current role and company", () => {
    expect(lead.headline).toBe("VP of Sales at Acme Corp | Building revenue teams");
    expect(lead.location).toBe("Austin, Texas, United States");
    expect(lead.title).toBe("VP of Sales");
    expect(lead.company_name).toBe("Acme Corp");
    expect(lead.company_linkedin_url).toBe("https://www.linkedin.com/company/12345");
  });
  it("extracts experience, education and about", () => {
    expect(lead.experience).toHaveLength(2);
    expect(lead.experience[1]).toEqual({ title: "Director of Sales", company_name: "Globex", company_linkedin_url: "https://www.linkedin.com/company/globex", date_range: "Mar 2018 - Dec 2022 · 4 yrs 10 mos", location: null });
    expect(lead.education[0]).toEqual({ school: "University of Texas at Austin", degree: "MBA, Marketing", date_range: "2014 - 2016" });
    expect(lead.about).toContain("Previously scaled sales at Globex");
  });
  it("honors include flags", () => {
    const slim = parseProfile(doc, url, { now: NOW, includeExperience: false, includeEducation: false, includeAbout: false });
    expect(slim.experience).toEqual([]);
    expect(slim.education).toEqual([]);
    expect(slim.about).toBeNull();
    // current title/company still derived even when history is excluded
    expect(slim.title).toBe("VP of Sales");
    expect(slim.company_name).toBe("Acme Corp");
  });
  it("falls back to headline when there is no experience section", () => {
    const { JSDOM } = require("jsdom");
    const d = new JSDOM(`<main><h1>Sam Lee</h1><div class="text-body-medium break-words">Founder @ Startly</div></main>`, { url }).window.document;
    const l = parseProfile(d, url, { now: NOW });
    expect(l.title).toBe("Founder");
    expect(l.company_name).toBe("Startly");
  });
});

describe("parseSalesNavPage", () => {
  const url = "https://www.linkedin.com/sales/search/people?query=x";
  const leads = parseSalesNavPage(loadFixture("salesnav-search.html", url), NOW);

  it("parses every row", () => {
    expect(leads.map((l) => l.full_name)).toEqual(["Alice Nguyen", "Bob Okafor", "Carla Mendes"]);
  });
  it("captures Sales Navigator identifiers", () => {
    expect(leads[0].sales_navigator_url).toBe("https://www.linkedin.com/sales/lead/ACwAAAabc123");
    expect(leads[0].linkedin_member_urn).toBe("ACwAAAabc123");
    expect(leads[0].linkedin_url).toBeNull();
    expect(leads[0].connection_degree).toBe("2nd");
  });
  it("captures role, company and location", () => {
    expect(leads[1]).toMatchObject({ title: "Chief Revenue Officer", company_name: "Umbrella Group", company_linkedin_url: "https://www.linkedin.com/company/112233", location: "Toronto, Ontario, Canada", headline: "Chief Revenue Officer at Umbrella Group" });
    expect(leads[2].location).toBe("São Paulo, Brazil");
  });
});

describe("parsePeopleSearchPage", () => {
  const url = "https://www.linkedin.com/search/results/people/?keywords=sales";
  const leads = parsePeopleSearchPage(loadFixture("people-search.html", url), NOW);

  it("skips anonymous LinkedIn Member rows", () => {
    expect(leads.map((l) => l.full_name)).toEqual(["Dana White", "Evan Park"]);
  });
  it("canonicalizes profile URLs and splits headline", () => {
    expect(leads[0].linkedin_url).toBe("https://www.linkedin.com/in/dana-white-99");
    expect(leads[0]).toMatchObject({ title: "Account Executive", company_name: "Hooli", location: "San Francisco Bay Area", connection_degree: "2nd" });
    expect(leads[1].linkedin_url).toBe("https://www.linkedin.com/in/evan-park");
    expect(leads[1]).toMatchObject({ title: "Enterprise Sales", company_name: "Pied Piper" });
  });
});

describe("parsePage", () => {
  it("dispatches by URL", () => {
    const url = "https://www.linkedin.com/in/jane-doe-123/";
    const r = parsePage(loadFixture("profile.html", url), url, { now: NOW });
    expect(r.pageType).toBe("profile");
    expect(r.leads).toHaveLength(1);
    expect(parsePage(loadFixture("profile.html", "https://www.linkedin.com/feed/"), "https://www.linkedin.com/feed/")).toEqual({ pageType: null, leads: [] });
  });
});
