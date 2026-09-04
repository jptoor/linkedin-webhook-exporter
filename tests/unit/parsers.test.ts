import { describe, expect, it } from "vitest";
import { detectPageType, parsePage } from "../../src/content/parsers";
import { parseProfile } from "../../src/content/parsers/profile";
import { parseSalesNavLead, parseSalesNavPage } from "../../src/content/parsers/salesnav";
import { parsePeopleSearchPage } from "../../src/content/parsers/search";
import { splitHeadline, looksLikeLocation } from "../../src/content/parsers/common";
import { dom, loadFixture, loadSample } from "./helpers";

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

describe("splitHeadline", () => {
  it.each([
    ["VP Sales at Acme", "VP Sales", "Acme"],
    ["Chief Revenue Officer @ Ångström & Sons — scaling B2B teams | ex-Uber", "Chief Revenue Officer", "Ångström & Sons — scaling B2B teams"],
    ["Chief Revenue Officer - Ocrolus", "Chief Revenue Officer", "Ocrolus"],
    ["Acme — VP Sales", "VP Sales", "Acme"],
    ["VP Sales | Acme", "VP Sales", "Acme"],
    ["Chief Revenue Officer (CRO) at In Tandem 🚀", "Chief Revenue Officer (CRO)", "In Tandem 🚀"],
    ["Geschäftsführer bei Müller GmbH", null, null],
    ["Chief Revenue Officer | Board Member | Growth, GTM & Customer Success Advisor", null, null],
    ["Helping founders win", null, null],
    ["", null, null]
  ])("%s", (h, title, company) => {
    expect(splitHeadline(h || null)).toEqual({ title, company });
  });
  it("looksLikeLocation is conservative", () => {
    for (const t of ["Austin, Texas, United States", "Greater Paris Metropolitan Region", "Remote", "Utrecht Area", "São Paulo, Brazil", "München, Bayern, Deutschland"]) expect(looksLikeLocation(t)).toBe(true);
    for (const t of ["VP Sales at Acme", "Chief Revenue Officer, Board Member", "Nov 2021–Present", "43 mutual connections", "", "Elavon, Inc.", "Ångström & Sons", "Acme, LLC", "Müller GmbH"]) expect(looksLikeLocation(t)).toBe(false);
  });
});

describe("parseProfile (classic)", () => {
  const url = "https://www.linkedin.com/in/jane-doe-123/";
  const doc = loadFixture("profile.html", url);
  const lead = parseProfile(doc, url, { now: NOW });
  it("extracts identity fields", () => {
    expect(lead).toMatchObject({ full_name: "Jane Doe", first_name: "Jane", last_name: "Doe", linkedin_url: "https://www.linkedin.com/in/jane-doe-123", linkedin_slug: "jane-doe-123", connection_degree: "2nd", profile_image_url: "https://media.licdn.com/dms/image/jane.jpg", captured_at: NOW, parse_warnings: [] });
  });
  it("extracts headline, location, current role and company", () => {
    expect(lead).toMatchObject({ headline: "VP of Sales at Acme Corp | Building revenue teams", location: "Austin, Texas, United States", title: "VP of Sales", company_name: "Acme Corp", company_linkedin_url: "https://www.linkedin.com/company/12345" });
  });
  it("extracts experience, education and about", () => {
    expect(lead.experience).toHaveLength(2);
    expect(lead.experience[1]).toEqual({ title: "Director of Sales", company_name: "Globex", company_linkedin_url: "https://www.linkedin.com/company/globex", date_range: "Mar 2018 - Dec 2022 · 4 yrs 10 mos", location: null });
    expect(lead.education[0]).toEqual({ school: "University of Texas at Austin", degree: "MBA, Marketing", date_range: "2014 - 2016" });
    expect(lead.about).toContain("Previously scaled sales at Globex");
  });
  it("honors include flags without traversing history, still derives the current role", () => {
    const slim = parseProfile(doc, url, { now: NOW, includeExperience: false, includeEducation: false, includeAbout: false });
    expect(slim.experience).toEqual([]);
    expect(slim.education).toEqual([]);
    expect(slim.about).toBeNull();
    expect(slim.title).toBe("VP of Sales");
    expect(slim.company_name).toBe("Acme Corp");
  });
  it("falls back to headline and title tag, and warns", () => {
    const d = dom(`<head><title>Sam Lee | LinkedIn</title></head><main><h1></h1><div class="text-body-medium break-words">Founder @ Startly</div></main>`, url);
    const l = parseProfile(d, url, { now: NOW });
    expect(l.full_name).toBe("Sam Lee");
    expect(l).toMatchObject({ title: "Founder", company_name: "Startly" });
    expect(l.parse_warnings).toContain("name_from_title");
    expect(l.parse_warnings).toContain("location_missing");
  });
});

describe("parseProfile (2026 SDUI sample)", () => {
  const url = "https://www.linkedin.com/in/zoe-angstrom-%C3%A5/";
  const lead = parseProfile(loadSample("profile-sdui.html", url), url, { now: NOW });
  it("reads the top card: emoji/credential/pronoun name cleaning, degree, headline, company, location", () => {
    expect(lead).toMatchObject({ full_name: "Zoë Ångström", first_name: "Zoë", last_name: "Ångström", connection_degree: "2nd", headline: "Chief Revenue Officer @ Ångström & Sons — scaling B2B teams | ex-Uber", company_name: "Ångström & Sons", location: "Stockholm, Stockholm County, Sweden", linkedin_url: "https://www.linkedin.com/in/zoe-angstrom-%C3%A5", profile_image_url: "https://media.licdn.com/dms/image/zoe.jpg" });
    expect(lead.parse_warnings).toContain("sdui_layout");
    expect(lead.parse_warnings).not.toContain("location_missing");
  });
  it("groups experience by company link and by date line for unanchored entries", () => {
    expect(lead.title).toBe("Chief Revenue Officer");
    expect(lead.company_linkedin_url).toBe("https://www.linkedin.com/company/1035");
    expect(lead.experience.map((e) => [e.title, e.company_name, e.date_range, e.location])).toEqual([
      ["Chief Revenue Officer", "Ångström & Sons · Full-time", "Feb 2024 - Present · 2 yrs 8 mos", "Stockholm, Sweden · Hybrid"],
      ["VP Sales, EMEA", "Uber", "2019 – 2024", "Amsterdam Area"],
      ["Advisor", "Stealth startup", "2021 – Present · 5 yrs", null],
      ["Board Member", "Nordic SaaS Association", "2020 – 2023", "Oslo, Norway"],
      ["Member Board Of Trustees", "KTH", "2018 – Present", null]
    ]);
    expect(lead.parse_warnings).toContain("experience_grouping_uncertain");
    expect(lead.education).toEqual([
      { school: "KTH Royal Institute of Technology", degree: "PhD, Industrial Engineering", date_range: "2010 - 2014" },
      { school: "Stockholm School of Economics", degree: "MBA", date_range: "2008 - 2010" }
    ]);
    expect(lead.about).toContain("Emojis in bios");
  });
  it("ignores the Activity card's company links", () => {
    expect(lead.experience.some((e) => (e.title ?? "").includes("NVIDIA"))).toBe(false);
  });
});

describe("parseSalesNavPage", () => {
  it("parses the classic fixture", () => {
    const url = "https://www.linkedin.com/sales/search/people?query=x";
    const leads = parseSalesNavPage(loadFixture("salesnav-search.html", url), NOW);
    expect(leads.map((l) => l.full_name)).toEqual(["Alice Nguyen", "Bob Okafor", "Carla Mendes"]);
    expect(leads[0]).toMatchObject({ sales_navigator_url: "https://www.linkedin.com/sales/lead/ACwAAAabc123", linkedin_member_urn: "ACwAAAabc123", linkedin_url: null, connection_degree: "2nd" });
    expect(leads[1]).toMatchObject({ title: "Chief Revenue Officer", company_name: "Umbrella Group", company_linkedin_url: "https://www.linkedin.com/company/112233", location: "Toronto, Ontario, Canada", headline: "Chief Revenue Officer at Umbrella Group" });
    expect(leads[2].parse_warnings).toContain("degree_missing");
  });
  it("parses the messy lead-list sample: unicode, badges, whitespace, ZWJ, injection text, bad URNs, hostile company hosts, skeleton rows", () => {
    const url = "https://www.linkedin.com/sales/lists/people/7263";
    const leads = parseSalesNavPage(loadSample("salesnav-list.html", url), NOW);
    const by = Object.fromEntries(leads.map((l) => [l.full_name, l]));
    expect(leads).toHaveLength(12);
    expect(by["Alice Nguyen"].linkedin_url).toBe("https://www.linkedin.com/in/alice-nguyen-1");
    expect(by["Bob Okafor"]).toBeDefined(); // "is reachable" stripped
    expect(by["Carla Mendes"]).toBeDefined(); // flag emoji stripped
    expect(by["Dr. Priya Raman"]).toMatchObject({ title: "SVP Sales & Marketing", company_name: "Stealth", company_linkedin_url: null });
    expect(by["O'Connor-Smith, Seán"]).toMatchObject({ first_name: "Seán", last_name: "O'Connor-Smith", company_name: "Ó Súilleabháin & Co." });
    expect(by["Владимир Петров"]).toMatchObject({ title: "Директор по продажам", company_name: "Яндекс" });
    expect(by["Ayşe Öztürk"]).toMatchObject({ location: "İstanbul, Türkiye" });
    expect(by["Extra Spaces"]).toMatchObject({ title: "VP", company_name: "Spacey Inc", location: "Denver, Colorado, United States" });
    expect(by["ZeroWidth Joiner"]).toBeDefined();
    expect(by["<script>alert(1)</script> Injector"]).toMatchObject({ title: '"Quoted" Title', company_linkedin_url: null }); // hostile host dropped
    expect(by["Bad Urn"]).toMatchObject({ sales_navigator_url: null, linkedin_member_urn: null });
    expect(by["Bad Urn"].parse_warnings).toContain("company_missing");
    expect(Object.keys(by).find((n) => n.startsWith("Very Long"))!.length).toBeLessThanOrEqual(200);
  });
});

describe("parseSalesNavLead (sample)", () => {
  const url = "https://www.linkedin.com/sales/lead/ACwAAABbedIBfirQHhl0OlHRmfe81tzow0Jjgwg,NAME_SEARCH,vDF-?_ntb=x";
  const lead = parseSalesNavLead(loadSample("salesnav-lead.html", url), url, NOW);
  it("reads name, headline, degree, top-card location, current role", () => {
    expect(lead).toMatchObject({ full_name: "David Lusk", connection_degree: "2nd", location: "Atlanta Metropolitan Area", title: "Managing Partner", company_name: "Evergreen Sales Group", company_linkedin_url: "https://www.linkedin.com/company/81895534", sales_navigator_url: "https://www.linkedin.com/sales/lead/ACwAAABbedIBfirQHhl0OlHRmfe81tzow0Jjgwg", linkedin_member_urn: "ACwAAABbedIBfirQHhl0OlHRmfe81tzow0Jjgwg", linkedin_url: null });
    expect(lead.headline).toContain("Helping Technical Experts");
    expect(lead.parse_warnings).not.toContain("location_guessed");
  });
  it("parses flat and grouped experience entries with nested heading spans, ignoring the tab button", () => {
    expect(lead.experience.map((e) => [e.title, e.company_name, e.date_range, e.location])).toEqual([
      ["Managing Partner", "Evergreen Sales Group", "Nov 2021–Present", "Atlanta, Georgia, United States"],
      ["Chief Revenue Officer (CRO)", "Juno Health LLC", "Apr 2025–Present · 1 yr 6 mos", "New York City Metropolitan Area"],
      ["VP Sales Development", "U.S. Bank", "Oct 2018–Jul 2021", "Atlanta Metropolitan Area"],
      ["Vice President of Sales Learning (Elavon-a Division of U.S. Bank)", "U.S. Bank", "Dec 2018–Mar 2021", null],
      ["Sales and Professional Development Learning Consultant", "Teradata", "Sep 2016–Dec 2018", "Atlanta Metropolitan Area"],
      ["SME Sales Enablement Principle", "Elavon, Inc.", "Nov 2013–Sep 2016", null]
    ]);
    expect(lead.experience[2].company_linkedin_url).toBe("https://www.linkedin.com/company/2532");
  });
});

describe("parsePeopleSearchPage", () => {
  it("parses the classic fixture", () => {
    const url = "https://www.linkedin.com/search/results/people/?keywords=sales";
    const leads = parsePeopleSearchPage(loadFixture("people-search.html", url), NOW);
    expect(leads.map((l) => l.full_name)).toEqual(["Dana White", "Evan Park"]);
    expect(leads[0]).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/dana-white-99", title: "Account Executive", company_name: "Hooli", location: "San Francisco Bay Area", connection_degree: "2nd" });
    expect(leads[1]).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/evan-park", title: "Enterprise Sales", company_name: "Pied Piper" });
  });
  it("parses the 2026 SDUI sample: chatter lines, pronouns, mononyms, unicode slugs, hostile hosts, nested paths, duplicated names, dash headlines", () => {
    const url = "https://www.linkedin.com/search/results/people/?keywords=chief%20revenue%20officer";
    const leads = parsePeopleSearchPage(loadSample("people-search-sdui.html", url), NOW);
    const by = Object.fromEntries(leads.map((l) => [l.full_name, l]));
    expect(leads.map((l) => l.full_name)).toEqual(["Andrew Rains", "Cher", "李 小龙", "Ẹ̀mí Adébáyọ̀ Jr.", "Todd R.", "Hostile Host", "Nested Path", "Martin Müller", "Mary Ann van der Berg"]);
    expect(by["Andrew Rains"]).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/arains", connection_degree: "1st", headline: "Chief Revenue Officer - Ocrolus", title: "Chief Revenue Officer", company_name: "Ocrolus", location: "Woodstock, Georgia, United States" });
    expect(by["Cher"]).toMatchObject({ first_name: "Cher", last_name: null, connection_degree: "2nd", headline: "Chief Revenue Officer (CRO) at In Tandem 🚀", location: "Mount Pleasant, South Carolina, United States", title: "Chief Revenue Officer (CRO)" });
    expect(by["李 小龙"]).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/%E6%9D%8E%E5%B0%8F%E9%BE%99-abc", connection_degree: "3rd", location: "Shanghai, China", title: null });
    expect(by["李 小龙"].parse_warnings).toContain("headline_unsplit");
    expect(by["Ẹ̀mí Adébáyọ̀ Jr."]).toMatchObject({ headline: "VP Sales | Acme", title: "VP Sales", company_name: "Acme", location: "Remote" });
    expect(by["Todd R."]).toMatchObject({ headline: null, location: "Irvine, California, United States" });
    expect(by["Hostile Host"].linkedin_url).toBeNull();
    expect(by["Nested Path"].linkedin_url).toBeNull();
    expect(by["Martin Müller"]).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/martin-m%C3%BCller-8a1", location: "München, Bayern, Deutschland", title: null });
    expect(by["Mary Ann van der Berg"]).toMatchObject({ first_name: "Mary Ann", last_name: "van der Berg", title: "VP Sales", company_name: "Acme", location: "Utrecht Area" });
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
  it("never throws on an empty or hostile document", { timeout: 30_000 }, () => {
    for (const html of ["", "<html></html>", "<main><h1>&lt;img onerror=alert(1)&gt;</h1></main>", "<main>" + "<div>".repeat(1500) + "</main>"]) {
      expect(() => parsePage(dom(html), "https://www.linkedin.com/in/x-y-z/")).not.toThrow();
      expect(() => parsePage(dom(html, "https://www.linkedin.com/search/results/people/"), "https://www.linkedin.com/search/results/people/")).not.toThrow();
      expect(() => parsePage(dom(html, "https://www.linkedin.com/sales/search/people"), "https://www.linkedin.com/sales/search/people")).not.toThrow();
    }
  });
});
