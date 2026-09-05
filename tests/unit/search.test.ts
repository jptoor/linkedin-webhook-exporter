import { describe, expect, it } from "vitest";
import { buildSearchRecord, decodeParams, isSensitiveParam, parseSalesNavQuery, searchKey, searchName } from "../../src/shared/search";

const SN = "https://www.linkedin.com/sales/search/people?query=(spellCorrectionEnabled%3Atrue%2CrecentSearchParam%3A(id%3A123%2CdoLogHistory%3Atrue)%2Cfilters%3AList((type%3ACURRENT_TITLE%2Cvalues%3AList((id%3A1%2Ctext%3ACRO%2CselectionType%3AINCLUDED)%2C(id%3A2%2Ctext%3AVP%2520Sales%2CselectionType%3AINCLUDED)))%2C(type%3AREGION%2Cvalues%3AList((id%3A103644278%2Ctext%3AUnited%2520States%2CselectionType%3AINCLUDED)))%2C(type%3ACOMPANY_HEADCOUNT%2Cvalues%3AList((id%3AD%2Ctext%3A51-200%2CselectionType%3AEXCLUDED))))%2Ckeywords%3Arevenue%2520ops)&sessionId=abc&page=3";

describe("decodeParams", () => {
  it("decodes without re-encoding, drops session/tracking params, keeps repeated keys", () => {
    const p = decodeParams(SN);
    expect(p.sessionId).toBeUndefined();
    expect(p.page).toBe("3");
    expect(p.query.startsWith("(spellCorrectionEnabled:true")).toBe(true);
    const r = decodeParams("https://x/?a=1&a=2&trk=xyz&_ntb=q&b=%E2%9C%93&c");
    expect(r).toEqual({ a: "2", "a[]": JSON.stringify(["1", "2"]), b: "✓", c: "" });
    expect(decodeParams("https://x/nothing")).toEqual({});
    expect(decodeParams("https://x/?bad=%E0%A4%A", { redact: false }).bad).toBe("%E0%A4%A"); // invalid escape kept raw
  });
  it("classifies sensitive params case-insensitively", () => {
    for (const k of ["sessionId", "SESSIONID", "_ntb", "trk", "trkInfo", "utm_source", "midToken"]) expect(isSensitiveParam(k)).toBe(true);
    expect(isSensitiveParam("query")).toBe(false);
  });
});

describe("parseSalesNavQuery", () => {
  it("parses filters, exclusions and keywords with a real grammar", () => {
    const { filters, keywords } = parseSalesNavQuery(decodeParams(SN).query);
    expect(filters).toEqual({ CURRENT_TITLE: ["CRO", "VP Sales"], REGION: ["United States"], COMPANY_HEADCOUNT_EXCLUDED: ["51-200"] });
    expect(keywords).toBe("revenue ops");
  });
  it("handles nested parentheses, commas inside values, ids without text, and junk", () => {
    const expr = "(filters:List((type:CURRENT_COMPANY,values:List((id:urn%3Ali%3Aorganization%3A1035,text:Microsoft%2C%20Inc.,selectionType:INCLUDED),(id:5,selectionType:INCLUDED))),(type:lowercase_bad,values:List((text:x)))),keywords:a%20%28b%29%2C%20c)";
    const { filters, keywords } = parseSalesNavQuery(expr);
    expect(filters).toEqual({ CURRENT_COMPANY: ["Microsoft, Inc.", "5"] });
    expect(keywords).toBe("a (b), c");
    expect(parseSalesNavQuery(null)).toEqual({ filters: {}, keywords: null });
    expect(parseSalesNavQuery("cro")).toEqual({ filters: {}, keywords: "cro" });
    expect(parseSalesNavQuery("(((((")).toEqual({ filters: {}, keywords: null });
    expect(parseSalesNavQuery("(".repeat(30_000))).toEqual({ filters: {}, keywords: null });
    expect(parseSalesNavQuery("(filters:List((type:X,values:List((text:" + "y".repeat(500) + ")))))").filters.X[0].length).toBe(200);
  });
});

describe("buildSearchRecord / searchName / searchKey", () => {
  it("builds a redacted, normalized record", () => {
    const r = buildSearchRecord(SN, "salesnav_search", 1500, "t");
    expect(r).toMatchObject({ surface: "sales_navigator", page: 3, total_hint: 1500, list_id: null, keywords: "revenue ops", captured_at: "t" });
    expect(r.search_url).not.toContain("sessionId");
    expect(r.search_url).not.toContain("page=");
    expect(r.params.sessionId).toBeUndefined();
    expect(r.filters.REGION).toEqual(["United States"]);
    const list = buildSearchRecord("https://www.linkedin.com/sales/lists/people/7263?x=1", "salesnav_list", null, "t");
    expect(list.list_id).toBe("7263");
    const li = buildSearchRecord("https://www.linkedin.com/search/results/people/?keywords=cro&origin=GLOBAL&page=abc", "people_search", null, "t");
    expect(li).toMatchObject({ surface: "linkedin", keywords: "cro", filters: {}, page: 1 });
    expect(li.params.origin).toBeUndefined();
  });
  it("derives a human search name", () => {
    expect(searchName(SN, "salesnav_search")).toBe("revenue ops · current title: CRO, VP Sales · region: United States · company headcount excluded: 51-200");
    expect(searchName("https://www.linkedin.com/sales/lists/people/7263", "salesnav_list", "Q3 targets | Sales Navigator")).toBe("Sales Navigator list 7263");
    expect(searchName("https://www.linkedin.com/sales/lists/people/7263", "salesnav_list", "Q3 targets")).toBe("Q3 targets (list 7263)");
    expect(searchName("https://www.linkedin.com/search/results/people/?keywords=cro", "people_search")).toBe("cro");
    expect(searchName("https://www.linkedin.com/sales/search/people?query=cro", "salesnav_search")).toBe("cro");
    expect(searchName("https://www.linkedin.com/search/results/people/", "people_search", "Search | LinkedIn")).toBe("Search | LinkedIn");
    expect(searchName("https://www.linkedin.com/search/results/people/", "people_search", "x".repeat(400))!.length).toBe(200);
  });
  it("search key ignores page (any case) and session/tracking params, keeps LinkedIn encoding", () => {
    expect(searchKey(SN)).toBe(SN.replace("&sessionId=abc", "").replace("&page=3", ""));
    expect(searchKey("https://x/y?Page=2&PAGE=3&q=1#frag")).toBe("https://x/y?q=1");
    expect(searchKey("https://x/y")).toBe("https://x/y");
    expect(searchKey("https://x/y?")).toBe("https://x/y");
  });
});

describe("cleanPageUrl", () => {
  it("drops session and tracking params but keeps the page number", async () => {
    const { cleanPageUrl } = await import("../../src/shared/search");
    expect(cleanPageUrl("https://www.linkedin.com/sales/search/people?page=3&query=(keywords:cro)&sessionId=S1&trk=x#frag")).toBe("https://www.linkedin.com/sales/search/people?page=3&query=(keywords:cro)");
    expect(cleanPageUrl("https://www.linkedin.com/in/ada/?sessionId=S1")).toBe("https://www.linkedin.com/in/ada/");
    expect(cleanPageUrl("https://www.linkedin.com/in/ada/")).toBe("https://www.linkedin.com/in/ada/");
  });
});
