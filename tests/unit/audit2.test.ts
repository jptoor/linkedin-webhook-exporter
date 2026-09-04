import { describe, expect, it } from "vitest";
import { isSameSearchPage } from "../../src/shared/export-job";
import { append, redact, redactUrl, LOG_MAX_BYTES } from "../../src/shared/log";
import { parseProfile } from "../../src/content/parsers/profile";
import { parsePeopleSearchPage } from "../../src/content/parsers/search";
import { loadSample } from "./helpers";

describe("NF-02 export page ownership", () => {
  const base = "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&sessionId=A";
  it("accepts the same search with a different session id or page param position, rejects changed filters", () => {
    expect(isSameSearchPage(base, "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&sessionId=B")).toBe(true);
    expect(isSameSearchPage(base + "&page=1", base)).toBe(true);
    expect(isSameSearchPage("https://www.linkedin.com/sales/search/people?page=2&query=(keywords%3Acro)", base + "&page=2")).toBe(true);
    expect(isSameSearchPage(base + "&page=2", base)).toBe(false);
    expect(isSameSearchPage("https://www.linkedin.com/sales/search/people?query=(keywords%3Acto)", base)).toBe(false);
    expect(isSameSearchPage("https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&extra=1", base)).toBe(false);
    expect(isSameSearchPage("https://evil.example/sales/search/people?query=(keywords%3Acro)", base)).toBe(false);
    expect(isSameSearchPage(undefined, base)).toBe(false);
    expect(isSameSearchPage("nope", base)).toBe(false);
  });
});

describe("NF-07 activity log hygiene", () => {
  it("redacts session/tracking params and fragments from URLs anywhere in a log entry", () => {
    const u = "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&sessionId=SECRETSESSION&trkInfo=T&utm_source=x#frag";
    expect(redactUrl(u)).toBe("https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)");
    const r = redact({ pageUrl: u, urls: [u], note: "plain text with sessionId=abc is not a url" })!;
    expect(JSON.stringify(r)).not.toContain("SECRETSESSION");
    expect((r.urls as string[])[0]).not.toContain("trkInfo");
    expect(r.note).toContain("sessionId=abc"); // only URL values are parsed
    const log = append([], { t: 1, kind: "search.saved", msg: `Saved ${u}` });
    expect(log[0].msg).not.toContain("SECRETSESSION");
  });
  it("redacts recursively and survives an oversized single entry", () => {
    const r = redact({ nested: { authorization: "Bearer T", deeper: { url: "https://x/?sessionId=S&q=1", list: [{ cookie: "c" }] } } })!;
    const s = JSON.stringify(r);
    expect(s).not.toContain("Bearer T");
    expect(s).not.toContain("sessionId=S");
    expect(s).not.toContain('"c"');
    expect(s).toContain("q=1");
    const big = append([], { t: 1, kind: "error", msg: "m", data: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "z".repeat(300)])) }, 1000, 4000);
    expect(big).toHaveLength(1);
    expect(big[0].data).toEqual({ truncated: true });
  });
  it("bounds the log by bytes as well as entries", () => {
    let log: ReturnType<typeof append> = [];
    for (let i = 0; i < 400; i++) log = append(log, { t: i, kind: "error", msg: "x".repeat(300), data: { big: "y".repeat(300) } }, 1000, 20_000);
    expect(JSON.stringify(log).length).toBeLessThanOrEqual(20_000);
    expect(log.length).toBeLessThan(400);
    expect(log.length).toBeGreaterThan(10);
    expect(log[log.length - 1].t).toBe(399);
    expect(LOG_MAX_BYTES).toBeGreaterThan(100_000);
  });
});

describe("NF-06 raw name preservation", () => {
  it("keeps the rendered name when cleaning changed it", () => {
    const url = "https://www.linkedin.com/in/zoe-angstrom-%C3%A5/";
    const zoe = parseProfile(loadSample("profile-sdui.html", url), url, { now: "t" });
    expect(zoe.full_name).toBe("Zoë Ångström");
    expect(zoe.full_name_raw).toBe("Zoë Ångström 🚀, MBA, PhD (she/her)");
    const rows = parsePeopleSearchPage(loadSample("people-search-sdui.html", "https://www.linkedin.com/search/results/people/?keywords=x"), "t");
    const plain = rows.find((r) => r.full_name === "Andrew Rains")!;
    expect(plain.full_name_raw).toBeNull();
  });
});
