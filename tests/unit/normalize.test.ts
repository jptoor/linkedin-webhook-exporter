import { describe, expect, it } from "vitest";
import { canonicalizeCompanyUrl, canonicalizeLinkedInUrl, canonicalizeSalesNavUrl, cleanName, cleanText, dedupeKey, isLinkedInHost, memberUrnFromSalesNavUrl, parseConnectionDegree, splitName, truncate } from "../../src/shared/normalize";

describe("cleanText", () => {
  it("collapses whitespace and strips zero-width and bidi controls", () => {
    expect(cleanText("  Ana   Silva\t\n")).toBe("Ana Silva");
    expect(cleanText("Zero​Width‍ Joiner﻿")).toBe("ZeroWidth Joiner");
    expect(cleanText("‮RTL override‬")).toBe("RTL override");
    expect(cleanText("")).toBeNull();
    expect(cleanText("   ")).toBeNull();
    expect(cleanText(null)).toBeNull();
  });
});

describe("cleanName: badges, credentials, unicode", () => {
  it.each([
    ["Bob Okafor is reachable", "Bob Okafor"],
    ["Jane Doe, MBA · 2nd", "Jane Doe"],
    ["Sam Lee (He/Him)", "Sam Lee"],
    ["Zoë Ångström 🚀, MBA, PhD (she/her)", "Zoë Ångström"],
    ["李 小龙", "李 小龙"],
    ["Владимир Петров", "Владимир Петров"],
    ["Ẹ̀mí Adébáyọ̀, Jr.", "Ẹ̀mí Adébáyọ̀ Jr."],
    ["Ayşe Öztürk 🇹🇷", "Ayşe Öztürk"],
    ["Carla Mendes 🇧🇷", "Carla Mendes"],
    ["O'Connor-Smith, Seán", "O'Connor-Smith, Seán"],
    ["Dr. Priya Raman, PhD", "Dr. Priya Raman"],
    ["Priya Raman, PhD, MBA, CPA", "Priya Raman"],
    ["Sam Lee is hiring", "Sam Lee"],
    ["Alex Kim has a premium account", "Alex Kim"],
    ["Alex Kim • 3rd+", "Alex Kim"],
    ["Alex Kim · 1st degree connection", "Alex Kim"],
    ["Nguyễn Văn An", "Nguyễn Văn An"],
    ["  Extra   Spaces  ", "Extra Spaces"],
    ["Cher", "Cher"]
  ])("%s -> %s", (input, expected) => {
    expect(cleanName(input)).toBe(expected);
  });
  it("keeps real names that merely contain badge-like words", () => {
    expect(cleanName("Hiring Manager Hillary")).toBe("Hiring Manager Hillary");
    expect(cleanName("Verified Vince Verified Brands")).toBe("Verified Vince Verified Brands");
    expect(cleanName("Anna Maria, Countess of Loch")).toBe("Anna Maria, Countess of Loch");
  });
  it("rejects empty and absurdly long names", () => {
    expect(cleanName("")).toBeNull();
    expect(cleanName("🚀")).toBeNull();
    expect(cleanName("x".repeat(201))!.length).toBe(200);
    expect(cleanName("<script>alert(1)</script> Injector")).toBe("<script>alert(1)</script> Injector"); // text only; never rendered as HTML
  });
});

describe("splitName", () => {
  it.each([
    ["Jane Doe", "Jane", "Doe"],
    ["Mary Ann van der Berg", "Mary Ann", "van der Berg"],
    ["José María de la Cruz", "José María", "de la Cruz"],
    ["Ludwig von Beethoven", "Ludwig", "von Beethoven"],
    ["Cher", "Cher", null],
    ["李 小龙", "李", "小龙"],
    ["Ẹ̀mí Adébáyọ̀ Jr.", "Ẹ̀mí", "Adébáyọ̀ Jr."],
    ["O'Connor-Smith, Seán", "Seán", "O'Connor-Smith"],
    ["Martin Luther King III", "Martin", "Luther King III"],
    ["Osama bin Laden", "Osama", "bin Laden"],
    ["Todd R.", "Todd", "R."]
  ])("%s -> %s / %s", (input, first, last) => {
    expect(splitName(input)).toEqual({ first_name: first, last_name: last });
  });
  it("handles null and whitespace", () => {
    expect(splitName(null)).toEqual({ first_name: null, last_name: null });
    expect(splitName("   ")).toEqual({ first_name: null, last_name: null });
  });
});

describe("isLinkedInHost", () => {
  it.each([
    ["www.linkedin.com", true],
    ["linkedin.com", true],
    ["uk.linkedin.com", true],
    ["LinkedIn.com", true],
    ["evil.example", false],
    ["linkedin.com.evil.example", false],
    ["notlinkedin.com", false],
    ["www.linkedin.com.", false],
    ["abc.linkedin.com", false],
    ["media.licdn.com", false]
  ])("%s -> %s", (host, ok) => expect(isLinkedInHost(host)).toBe(ok));
});

describe("canonicalizeLinkedInUrl", () => {
  it("normalizes public profile URLs", () => {
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/jane-doe-123/?originalSubdomain=uk")).toBe("https://www.linkedin.com/in/jane-doe-123");
    expect(canonicalizeLinkedInUrl("/in/evan-park/")).toBe("https://www.linkedin.com/in/evan-park");
    expect(canonicalizeLinkedInUrl("https://uk.linkedin.com/in/Jane-Doe")).toBe("https://www.linkedin.com/in/Jane-Doe");
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller")).toBe("https://www.linkedin.com/in/j%C3%B6rg-m%C3%BCller");
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/李小龙-abc")).toBe("https://www.linkedin.com/in/%E6%9D%8E%E5%B0%8F%E9%BE%99-abc");
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/zoe-angstrom-%C3%A5/")).toBe("https://www.linkedin.com/in/zoe-angstrom-%C3%A5");
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/arains?miniProfileUrn=urn%3Ali%3Afs_miniProfile%3AACo&trk=x")).toBe("https://www.linkedin.com/in/arains");
  });
  it("rejects hostile hosts, credentials, ports, nested paths and bad slugs", () => {
    expect(canonicalizeLinkedInUrl("https://evil.example/in/alice")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com.evil.example/in/alice")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://user:pass@www.linkedin.com/in/alice")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com:8443/in/alice")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/alice/details/experience/")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/alice/overlay/contact-info/")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/a%2Fb")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/ab")).toBeNull(); // too short
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/in/" + "a".repeat(121))).toBeNull();
    expect(canonicalizeLinkedInUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/search/results/people/")).toBeNull();
    expect(canonicalizeLinkedInUrl("https://www.linkedin.com/company/acme")).toBeNull();
    expect(canonicalizeLinkedInUrl("not a url")).toBeNull();
    expect(canonicalizeLinkedInUrl(null)).toBeNull();
    expect(canonicalizeLinkedInUrl("x".repeat(3000))).toBeNull();
  });
});

describe("Sales Navigator and company URLs", () => {
  it("extracts member URN and canonical lead URL only on LinkedIn hosts", () => {
    const href = "/sales/lead/ACwAAAabc123def,NAME_SEARCH,xyz1?_ntb=1";
    expect(memberUrnFromSalesNavUrl(href)).toBe("ACwAAAabc123def");
    expect(canonicalizeSalesNavUrl(href)).toBe("https://www.linkedin.com/sales/lead/ACwAAAabc123def");
    expect(canonicalizeSalesNavUrl("https://evil.example/sales/lead/ACwAAAabc123def,NAME_SEARCH,x")).toBeNull();
    expect(canonicalizeSalesNavUrl("/sales/lead/short,NAME_SEARCH,b2")).toBeNull();
    expect(memberUrnFromSalesNavUrl("/sales/lead/short,NAME_SEARCH,b2")).toBeNull();
    expect(canonicalizeSalesNavUrl("/in/foo-bar")).toBeNull();
  });
  it("canonicalizes company URLs from both surfaces and rejects others", () => {
    expect(canonicalizeCompanyUrl("/sales/company/998877?_ntb=1")).toBe("https://www.linkedin.com/company/998877");
    expect(canonicalizeCompanyUrl("https://www.linkedin.com/company/globex/")).toBe("https://www.linkedin.com/company/globex");
    expect(canonicalizeCompanyUrl("https://www.linkedin.com/company/1035/?trk=public_profile")).toBe("https://www.linkedin.com/company/1035");
    expect(canonicalizeCompanyUrl("https://www.linkedin.com/school/ut-austin/")).toBe("https://www.linkedin.com/school/ut-austin");
    expect(canonicalizeCompanyUrl("https://www.linkedin.com/company/acme/people/")).toBe("https://www.linkedin.com/company/acme");
    expect(canonicalizeCompanyUrl("https://evil.example/sales/company/1")).toBeNull();
    expect(canonicalizeCompanyUrl("https://www.linkedin.com/company/")).toBeNull();
  });
});

describe("misc", () => {
  it("parses connection degree in several renderings", () => {
    expect(parseConnectionDegree("· 2nd")).toBe("2nd");
    expect(parseConnectionDegree("• 3rd+")).toBe("3rd");
    expect(parseConnectionDegree("1st degree connection")).toBe("1st");
    expect(parseConnectionDegree("Premium")).toBeNull();
    expect(parseConnectionDegree("21st century")).toBeNull();
  });
  it("truncate never splits a surrogate pair", () => {
    const s = "a".repeat(1999) + "🚀🚀"; // 2001 characters, 2003 code units
    const t = truncate(s, 2000)!;
    expect(t.endsWith("…")).toBe(true);
    expect([...t].length).toBe(2000);
    expect(t.includes("\uFFFD")).toBe(false);
    expect(truncate("a".repeat(1998) + "🚀🚀", 2000)).toBe("a".repeat(1998) + "🚀🚀"); // exactly 2000 chars, untouched
    expect(truncate("short")).toBe("short");
  });
  it("dedupe key prefers public URL, then Sales Nav URL, then NFKC-normalized name+company", () => {
    expect(dedupeKey({ linkedin_url: "https://www.linkedin.com/in/Jane", sales_navigator_url: null, full_name: "Jane", company_name: null })).toBe("https://www.linkedin.com/in/jane");
    expect(dedupeKey({ linkedin_url: null, sales_navigator_url: "https://www.linkedin.com/sales/lead/ACw12345678", full_name: "Jane", company_name: null })).toBe("https://www.linkedin.com/sales/lead/acw12345678");
    expect(dedupeKey({ linkedin_url: null, sales_navigator_url: null, full_name: "Jane Doe", company_name: "Acme" })).toBe("name:jane doe|acme");
    expect(dedupeKey({ linkedin_url: null, sales_navigator_url: null, full_name: "ﬁona", company_name: null })).toBe("name:fiona|");
  });
});
