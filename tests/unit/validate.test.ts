import { describe, expect, it } from "vitest";
import { isAllowedPageUrl, isPageType, validateLead, validateLeads } from "../../src/shared/validate";

describe("validateLead", () => {
  it("rejects non-objects and nameless records", () => {
    expect(validateLead(null)).toBeNull();
    expect(validateLead("x")).toBeNull();
    expect(validateLead({})).toBeNull();
    expect(validateLead({ full_name: "   " })).toBeNull();
    expect(validateLead({ full_name: { toString: () => "obj" } })).toBeNull();
  });
  it("re-canonicalizes URLs (drops hostile hosts), bounds strings and arrays, keeps unicode", () => {
    const l = validateLead({
      full_name: "Zoë Ångström 🚀" + "x".repeat(500),
      linkedin_url: "https://evil.example/in/alice",
      sales_navigator_url: "https://www.linkedin.com/sales/lead/ACwAAA12345678,NAME_SEARCH,x",
      company_linkedin_url: "javascript:alert(1)",
      linkedin_member_urn: "not valid urn!",
      profile_image_url: "https://evil.example/x.jpg",
      connection_degree: "4th",
      captured_at: "not-a-date",
      headline: 42,
      about: "a".repeat(10_000),
      experience: Array.from({ length: 50 }, (_, i) => ({ title: `T${i}`, company_linkedin_url: "https://www.linkedin.com/company/1/" })),
      education: [{ school: "KTH" }, { nope: 1 }, "string"],
      parse_warnings: ["location_missing", 5, "x"]
    })!;
    expect(l.full_name.length).toBe(200);
    expect(l.linkedin_url).toBeNull();
    expect(l.sales_navigator_url).toBe("https://www.linkedin.com/sales/lead/ACwAAA12345678");
    expect(l.company_linkedin_url).toBeNull();
    expect(l.linkedin_member_urn).toBeNull();
    expect(l.profile_image_url).toBeNull();
    expect(l.connection_degree).toBeNull();
    expect(Date.parse(l.captured_at)).toBeGreaterThan(0);
    expect(l.headline).toBeNull();
    expect(l.about!.length).toBe(4000);
    expect(l.experience).toHaveLength(20);
    expect(l.experience[0].company_linkedin_url).toBe("https://www.linkedin.com/company/1");
    expect(l.education).toEqual([{ school: "KTH", degree: null, date_range: null }]);
    expect(l.parse_warnings).toEqual(["location_missing", "x"]);
  });
  it("accepts licdn images and valid urns", () => {
    const l = validateLead({ full_name: "A B", profile_image_url: "https://media.licdn.com/dms/image/x.jpg", linkedin_member_urn: "ACwAAA12345678" })!;
    expect(l.profile_image_url).toBe("https://media.licdn.com/dms/image/x.jpg");
    expect(l.linkedin_member_urn).toBe("ACwAAA12345678");
  });
  it("validateLeads bounds the array and drops invalid items", () => {
    expect(validateLeads([{ full_name: "A" }, null, { full_name: "" }, { full_name: "B" }])).toHaveLength(2);
    expect(validateLeads(Array.from({ length: 300 }, () => ({ full_name: "x" })))).toHaveLength(100);
    expect(validateLeads("nope")).toEqual([]);
  });
});

describe("page types and urls", () => {
  it("isPageType / isAllowedPageUrl", () => {
    expect(isPageType("profile")).toBe(true);
    expect(isPageType("evil")).toBe(false);
    expect(isAllowedPageUrl("https://www.linkedin.com/in/x", false)).toBe(true);
    expect(isAllowedPageUrl("https://evil.example/in/x", false)).toBe(false);
    expect(isAllowedPageUrl("http://127.0.0.1:1234/in/x", true)).toBe(true);
    expect(isAllowedPageUrl("http://127.0.0.1:1234/in/x", false)).toBe(false);
    expect(isAllowedPageUrl("http://www.linkedin.com/in/x", false)).toBe(false);
    expect(isAllowedPageUrl(12, true)).toBe(false);
  });
});
