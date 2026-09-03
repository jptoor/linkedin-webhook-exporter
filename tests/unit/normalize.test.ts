import { describe, expect, it } from "vitest";
import { canonicalizeCompanyUrl, canonicalizeLinkedInUrl, canonicalizeSalesNavUrl, cleanName, dedupeKey, memberUrnFromSalesNavUrl, parseConnectionDegree, splitName } from "../../src/shared/normalize";

describe("cleanName", () => {
  it("strips LinkedIn artifacts and credentials", () => {
    expect(cleanName("Bob Okafor is reachable")).toBe("Bob Okafor");
    expect(cleanName("Jane Doe, MBA · 2nd")).toBe("Jane Doe");
    expect(cleanName("Sam Lee (He/Him)")).toBe("Sam Lee");
    expect(cleanName("  Ana   Silva ")).toBe("Ana Silva");
    expect(cleanName("")).toBeNull();
    expect(cleanName(null)).toBeNull();
  });
});

describe("splitName", () => {
  it("splits first and last", () => {
    expect(splitName("Jane Doe")).toEqual({ first_name: "Jane", last_name: "Doe" });
    expect(splitName("Mary Ann van der Berg")).toEqual({ first_name: "Mary", last_name: "Ann van der Berg" });
    expect(splitName("Cher")).toEqual({ first_name: "Cher", last_name: null });
    expect(splitName(null)).toEqual({ first_name: null, last_name: null });
  });
});

describe("canonicalizeLinkedInUrl", () => {
  it("normalizes public profile URLs", () => {
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/jane-doe-123/?originalSubdomain=uk")).toBe("https://www.linkedin.com/in/jane-doe-123");
    expect(canonicalizeLinkedInUrl("/in/evan-park/")).toBe("https://www.linkedin.com/in/evan-park");
    expect(canonicalizeLinkedInUrl("https://uk.linkedin.com/in/Jane-Doe")).toBe("https://www.linkedin.com/in/Jane-Doe");
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller")).toBe("https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller");
  });
  it("rejects non-profile URLs", () => {
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/search/results/people/")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/company/acme")).toBeNull();
    expect(canonicalizeLinkedInUrl("not a url")).toBeNull();
    expect(canonicalizeLinkedInUrl(null)).toBeNull();
  });
});

describe("Sales Navigator URLs", () => {
  it("extracts member URN and canonical lead URL", () => {
    const href = "/sales/lead/ACwAAAabc123,NAME_SEARCH,xyz1?_ntb=1";
    expect(memberUrnFromSalesNavUrl(href)).toBe("ACwAAAabc123");
    expect(canonicalizeSalesNavUrl(href)).toBe("https://www.linkedin.com/sales/lead/ACwAAAabc123");
    expect(canonicalizeSalesNavUrl("/in/foo")).toBeNull();
  });
  it("canonicalizes company URLs from both surfaces", () => {
    expect(canonicalizeCompanyUrl("/sales/company/998877?_ntb=1")).toBe("https://www.linkedin.com/company/998877");
    expect(canonicalizeCompanyUrl("https://www.linkedin.com/company/globex/")).toBe("https://www.linkedin.com/company/globex");
    expect(canonicalizeCompanyUrl("https://www.linkedin.com/school/ut-austin/")).toBe("https://www.linkedin.com/school/ut-austin");
  });
});

describe("misc", () => {
  it("parses connection degree", () => {
    expect(parseConnectionDegree("· 2nd")).toBe("2nd");
    expect(parseConnectionDegree("3rd+")).toBe("3rd");
    expect(parseConnectionDegree("Premium")).toBeNull();
  });
  it("dedupe key prefers public URL, then Sales Nav URL, then name+company", () => {
    expect(dedupeKey({ linkedin_url: "https://www.linkedin.com/in/Jane", sales_navigator_url: null, full_name: "Jane", company_name: null })).toBe("https://www.linkedin.com/in/jane");
    expect(dedupeKey({ linkedin_url: null, sales_navigator_url: "https://www.linkedin.com/sales/lead/ACw", full_name: "Jane", company_name: null })).toBe("https://www.linkedin.com/sales/lead/acw");
    expect(dedupeKey({ linkedin_url: null, sales_navigator_url: null, full_name: "Jane Doe", company_name: "Acme" })).toBe("name:jane doe|acme");
  });
});
