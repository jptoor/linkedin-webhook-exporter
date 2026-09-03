import { describe, expect, it } from "vitest";
import { afterPage, exportablePageType, fail, isActive, newJob, pageDelayMs, pageFromUrl, parseTotalHint, pause, remaining, resume, stop, urlForPage } from "../../src/shared/export-job";

const T = 1_000;
const SN = "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&sessionId=abc";

describe("URL helpers", () => {
  it("classifies exportable URLs", () => {
    expect(exportablePageType(SN)).toBe("salesnav_search");
    expect(exportablePageType("https://www.linkedin.com/sales/lists/people/123?x=1")).toBe("salesnav_list");
    expect(exportablePageType("https://www.linkedin.com/search/results/people/?keywords=cro")).toBe("people_search");
    expect(exportablePageType("https://www.linkedin.com/in/jane")).toBeNull();
    expect(exportablePageType("nope")).toBeNull();
  });
  it("sets and strips the page param without touching other params", () => {
    expect(urlForPage(SN, 3)).toBe(SN + "&page=3");
    expect(urlForPage(SN + "&page=7", 1)).toBe(SN);
    expect(urlForPage(SN + "&page=7", 2)).toBe(SN + "&page=2");
    expect(pageFromUrl(SN + "&page=7")).toBe(7);
    expect(pageFromUrl(SN)).toBe(1);
    expect(pageFromUrl(SN + "&page=abc")).toBe(1);
  });
  it("parses LinkedIn's result-count text", () => {
    expect(parseTotalHint("1.5K+ results")).toBe(1500);
    expect(parseTotalHint("2,431 results")).toBe(2431);
    expect(parseTotalHint("10M+ results")).toBe(10_000_000);
    expect(parseTotalHint("Showing 25 leads")).toBeNull();
    expect(parseTotalHint(null)).toBeNull();
  });
});

describe("job lifecycle", () => {
  it("starts on the URL's page, caps the limit at 2,500, and normalizes the source URL", () => {
    const j = newJob("j1", SN + "&page=4", "salesnav_search", 9000, T);
    expect(j.page).toBe(4);
    expect(j.limit).toBe(2500);
    expect(j.sourceUrl).toBe(SN);
    expect(j.status).toBe("running");
    expect(isActive(j)).toBe(true);
  });
  it("advances pages and finishes on limit", () => {
    let j = newJob("j", SN, "salesnav_search", 40, T);
    j = afterPage(j, { rows: 25, queued: 20, skipped: 5, hasNext: true, totalHint: 1500, capReached: false }, T + 1);
    expect(j).toMatchObject({ page: 2, pagesDone: 1, collected: 25, sent: 20, skipped: 5, totalHint: 1500, status: "running" });
    expect(remaining(j)).toBe(15);
    j = afterPage(j, { rows: 15, queued: 15, skipped: 0, hasNext: true, totalHint: null, capReached: false }, T + 2);
    expect(j).toMatchObject({ status: "done", stopReason: "limit", collected: 40, finishedAt: T + 2, totalHint: 1500 });
    expect(isActive(j)).toBe(false);
  });
  it("finishes when there is no next page, on an empty page, or past page 100", () => {
    const base = newJob("j", SN, "salesnav_search", 2500, T);
    expect(afterPage(base, { rows: 12, queued: 12, skipped: 0, hasNext: false, totalHint: null, capReached: false }, T).stopReason).toBe("no_more_pages");
    expect(afterPage(base, { rows: 0, queued: 0, skipped: 0, hasNext: true, totalHint: null, capReached: false }, T).stopReason).toBe("empty_page");
    expect(afterPage({ ...base, page: 100 }, { rows: 25, queued: 25, skipped: 0, hasNext: true, totalHint: null, capReached: false }, T).stopReason).toBe("no_more_pages");
  });
  it("stops (not done) at the daily cap and records partial progress", () => {
    const j = afterPage(newJob("j", SN, "salesnav_search", 2500, T), { rows: 25, queued: 10, skipped: 0, hasNext: true, totalHint: null, capReached: true }, T);
    expect(j).toMatchObject({ status: "stopped", stopReason: "daily_cap", sent: 10, collected: 25 });
  });
  it("pause / resume / stop / fail transitions", () => {
    let j = newJob("j", SN, "salesnav_search", 100, T);
    j = pause(j, T);
    expect(j.status).toBe("paused");
    expect(isActive(j)).toBe(true);
    expect(resume(pause(j, T), T).status).toBe("running");
    const s = stop(j, T + 5);
    expect(s).toMatchObject({ status: "stopped", stopReason: "user", finishedAt: T + 5 });
    expect(stop(s, T + 9)).toBe(s); // terminal states are sticky
    expect(resume(s, T)).toBe(s);
    expect(fail(j, "tab_closed", T)).toMatchObject({ status: "error", stopReason: "error", lastError: "tab_closed" });
  });
  it("page delay stays within bounds", () => {
    expect(pageDelayMs(4000, 9000, () => 0)).toBe(4000);
    expect(pageDelayMs(4000, 9000, () => 1)).toBe(9000);
    expect(pageDelayMs(9000, 4000, () => 0.5)).toBe(6500);
  });
});
