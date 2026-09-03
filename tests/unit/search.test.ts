import { describe, expect, it } from "vitest";
import { buildSearchRecord, decodeParams, parseSalesNavQuery, searchKey, searchName } from "../../src/shared/search";

const SN = "https://www.linkedin.com/sales/search/people?query=(spellCorrectionEnabled%3Atrue%2CrecentSearchParam%3A(id%3A123%2CdoLogHistory%3Atrue)%2Cfilters%3AList((type%3ACURRENT_TITLE%2Cvalues%3AList((id%3A1%2Ctext%3ACRO%2CselectionType%3AINCLUDED)%2C(id%3A2%2Ctext%3AVP%2520Sales%2CselectionType%3AINCLUDED)))%2C(type%3AREGION%2Cvalues%3AList((id%3A103644278%2Ctext%3AUnited%2520States%2CselectionType%3AINCLUDED)))%2C(type%3ACOMPANY_HEADCOUNT%2Cvalues%3AList((id%3AD%2Ctext%3A51-200%2CselectionType%3AEXCLUDED))))%2Ckeywords%3Arevenue%2520ops)&sessionId=abc&page=3";

describe("search capture", () => {
  it("decodes params without re-encoding the URL", () => {
    const p = decodeParams(SN);
    expect(p.sessionId).toBe("abc");
    expect(p.page).toBe("3");
    expect(p.query.startsWith("(spellCorrectionEnabled:true")).toBe(true);
  });
  it("parses Sales Navigator filters and keywords", () => {
    const { filters, keywords } = parseSalesNavQuery(decodeParams(SN).query);
    expect(filters).toEqual({ CURRENT_TITLE: ["CRO", "VP Sales"], REGION: ["United States"], COMPANY_HEADCOUNT_EXCLUDED: ["51-200"] });
    expect(keywords).toBe("revenue ops");
    expect(parseSalesNavQuery(null)).toEqual({ filters: {}, keywords: null });
  });
  it("builds a full search record", () => {
    const r = buildSearchRecord(SN, "salesnav_search", 1500, "t");
    expect(r).toMatchObject({ surface: "sales_navigator", page: 3, total_hint: 1500, list_id: null, keywords: "revenue ops", captured_at: "t" });
    expect(r.filters.REGION).toEqual(["United States"]);
    const list = buildSearchRecord("https://www.linkedin.com/sales/lists/people/7263?x=1", "salesnav_list", null, "t");
    expect(list.list_id).toBe("7263");
    const li = buildSearchRecord("https://www.linkedin.com/search/results/people/?keywords=cro&origin=GLOBAL", "people_search", null, "t");
    expect(li).toMatchObject({ surface: "linkedin", keywords: "cro", filters: {} });
  });
  it("derives a human search name", () => {
    expect(searchName(SN, "salesnav_search")).toBe("revenue ops · current title: CRO, VP Sales · region: United States · company headcount excluded: 51-200");
    expect(searchName("https://www.linkedin.com/sales/lists/people/7263", "salesnav_list", "Q3 targets | Sales Navigator")).toBe("Sales Navigator list 7263");
    expect(searchName("https://www.linkedin.com/sales/lists/people/7263", "salesnav_list", "Q3 targets")).toBe("Q3 targets (list 7263)");
    expect(searchName("https://www.linkedin.com/search/results/people/?keywords=cro", "people_search")).toBe("cro");
    expect(searchName("https://www.linkedin.com/search/results/people/", "people_search", "Search | LinkedIn")).toBe("Search | LinkedIn");
  });
  it("search key ignores the page param", () => {
    expect(searchKey(SN)).toBe(SN.replace("&page=3", ""));
    expect(searchKey("https://x/y")).toBe("https://x/y");
  });
});
