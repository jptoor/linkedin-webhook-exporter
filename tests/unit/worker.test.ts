/** Service-worker behavior with a fake chrome runtime: concurrency under the
 *  storage lock, daily cap, dedupe reservation/confirmation/release, lease
 *  recovery, message trust boundary, secret redaction, activity log, the
 *  cross-page basket, Deepline play destinations and search hand-off. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChrome, messenger } from "./fake-chrome";

const PAGE = { id: "ext-id", url: "https://www.linkedin.com/in/x/", tab: { id: 7, url: "https://www.linkedin.com/in/x/" } };
const SEARCH_URL = "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&sessionId=A";
const SEARCH_PAGE = { id: "ext-id", url: SEARCH_URL, tab: { id: 8, url: SEARCH_URL } };
const PANEL = { id: "ext-id", url: "chrome-extension://ext-id/sidepanel.html" };
const OPTIONS = { id: "ext-id", url: "chrome-extension://ext-id/options.html" };
const WEBHOOK = { id: "w1", kind: "webhook", name: "Hook", url: "https://hooks.example.com/x", signingSecret: "s", signatureScheme: "lwe", mappingPreset: "generic", sendMode: "single" };
const PLAY = { id: "p1", kind: "deepline_play", name: "Warm intro", baseUrl: "https://code.deepline.com", apiKey: "dl_secret", playKey: "acme/warm-intro", playName: "Warm intro", input: { mode: "mapped", fields: ["linkedin_url", "first_name", "search_url", "limit"], required: [], acceptsSearch: true, acceptsLeads: true } };
const lead = (i: number, over: Record<string, unknown> = {}) => ({ full_name: `Person ${i}`, full_name_raw: null, first_name: "Person", last_name: String(i), headline: null, title: "VP", company_name: "Acme", company_linkedin_url: null, location: "Austin", linkedin_url: `https://www.linkedin.com/in/person-${i}`, linkedin_slug: `person-${i}`, linkedin_member_urn: null, sales_navigator_url: null, connection_degree: null, profile_image_url: null, about: null, experience: [], education: [], captured_at: "2026-09-03T00:00:00.000Z", parse_warnings: [], ...over });

let fake: ReturnType<typeof makeFakeChrome>;
let send: ReturnType<typeof messenger>;
let fetchMock: ReturnType<typeof vi.fn>;

async function boot(settings: Record<string, unknown> = {}) {
  vi.resetModules();
  fake = makeFakeChrome();
  (globalThis as any).chrome = fake.chrome;
  (globalThis as any).__EXTENSION_VERSION__ = "test";
  (globalThis as any).__TEST_BUILD__ = false;
  fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
  (globalThis as any).fetch = fetchMock;
  fake.store.settings = { destinations: [WEBHOOK, PLAY], activeDestinationId: "w1", dailyCap: 100, dedupe: true, ...settings };
  await import("../../src/background/service-worker");
  send = messenger(fake.listeners);
  await new Promise((r) => setTimeout(r, 20));
}
const flushed = () => new Promise((r) => setTimeout(r, 200));
const queue = () => (fake.store.queue as any[]) ?? [];
const dedupe = () => (fake.store.dedupe as Record<string, any>) ?? {};
const log = () => (fake.store.activityLog as any[]) ?? [];
const basket = () => (fake.sessionStore.basket as Record<string, any>) ?? {};
const lastFetch = () => fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
/** Fetches other than the worker's own boot-time flag/session lookups. */
const apiCalls = () => fetchMock.mock.calls.filter(([u]) => !/extension\/flags|auth\/session/.test(String(u)));

beforeEach(async () => {
  await boot();
});

describe("trust boundary", () => {
  it("rejects messages from other extensions and unknown senders", async () => {
    expect(await send({ type: "GET_STATE" }, { id: "other", url: "chrome-extension://other/sidepanel.html" })).toEqual({ error: "invalid_sender" });
    expect(await send({ type: "GET_STATE" }, { id: "ext-id", tab: { id: 1, url: "https://evil.example/" } })).toEqual({ error: "invalid_sender" });
  });
  it("content scripts get redacted settings and cannot run privileged commands", async () => {
    const s = await send({ type: "GET_SETTINGS" }, PAGE);
    expect(JSON.stringify(s)).not.toMatch(/dl_secret|hooks\.example/);
    expect(s).toMatchObject({ hasDestination: true, destinationName: "Hook", destinationKind: "webhook" });
    expect((await send({ type: "GET_SETTINGS" }, OPTIONS)).destinations[1].apiKey).toBe("dl_secret");
    for (const type of ["RETRY_NOW", "CLEAR_QUEUE", "TEST_DESTINATION", "GET_STATE", "GET_LOG", "LIST_PLAYS", "SET_ACTIVE_DESTINATION", "TOGGLE_FAVORITE", "GET_PAGE_CONTEXT"]) expect(await send({ type }, PAGE)).toEqual({ error: "forbidden" });
  });
  it("the side panel sees destinations with secrets blanked; the options page sees them in full", async () => {
    const st = await send({ type: "GET_STATE" }, PANEL);
    expect(JSON.stringify(st.settings)).not.toMatch(/dl_secret/);
    expect(st.settings.destinations[1].apiKey).toBe("•••");
    expect((await send({ type: "GET_STATE" }, OPTIONS)).settings.destinations[1].apiKey).toBe("dl_secret");
  });
  it("page-originated captures must match the sender tab origin and be a supported page", async () => {
    const r = await send({ type: "CAPTURE", leads: [lead(1)], pageType: "profile", pageUrl: "https://evil.example/in/x" }, PAGE);
    expect(r.rejectedReason).toBe("invalid_message");
    const r2 = await send({ type: "CAPTURE", leads: [lead(1)], pageType: "evil", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r2.rejectedReason).toBe("invalid_message");
    const r3 = await send({ type: "CAPTURE", leads: "nope", pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r3.rejectedReason).toBe("nothing_to_send");
  });
  it("a page cannot pick a destination other than the active one", async () => {
    await send({ type: "CAPTURE", leads: [lead(1)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/", destinationId: "p1" }, PAGE);
    expect(queue()[0].destinationId).toBe("w1");
  });
});

describe("capture, cap and dedupe", () => {
  it("queues valid leads, re-validates hostile URLs, dedupes within a message, logs", async () => {
    const r = await send({ type: "CAPTURE", leads: [lead(1), lead(1), lead(2, { linkedin_url: "https://evil.example/in/p2", sales_navigator_url: null }), { full_name: "" }], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r).toMatchObject({ ok: true, queued: 2, remainingToday: 98 });
    await flushed();
    expect(queue().every((q) => q.status === "sent")).toBe(true);
    expect(queue()[0]).toMatchObject({ destinationId: "w1", destinationKind: "webhook", label: "Person 1" });
    expect(Object.keys(dedupe()).sort()).toEqual(["https://www.linkedin.com/in/person-1", "name:person 2|acme"]);
    expect(log().map((e) => e.kind)).toEqual(expect.arrayContaining(["capture.requested", "capture.queued", "send.attempt", "send.ok"]));
    expect(JSON.stringify(log())).not.toMatch(/"s"|dl_secret/);
  });
  it("no destination: capture is rejected with guidance and nothing is fetched", async () => {
    await boot({ destinations: [], activeDestinationId: null });
    const r = await send({ type: "CAPTURE", leads: [lead(1)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r.rejectedReason).toBe("no_destination");
    await flushed();
    expect(apiCalls()).toHaveLength(0);
  });
  it("concurrent captures cannot exceed the daily cap or lose queue items", async () => {
    await boot({ dailyCap: 30 });
    const batches = Array.from({ length: 5 }, (_, b) => Array.from({ length: 10 }, (_, i) => lead(b * 10 + i)));
    const results = await Promise.all(batches.map((leads) => send({ type: "CAPTURE", leads, pageType: "salesnav_search", pageUrl: "https://www.linkedin.com/sales/search/people?q=1" }, { ...PAGE, tab: { id: 7, url: "https://www.linkedin.com/sales/search/people?q=1" } })));
    const queued = results.reduce((n, r) => n + r.queued, 0);
    expect(queued).toBe(30);
    expect(results.filter((r) => r.rejectedReason === "daily_cap")).toHaveLength(2);
    expect(queue().reduce((n, q) => n + q.leadCount, 0)).toBe(30);
    expect((fake.store.daily as any).queued).toBe(30);
  });
  it("skips already-sent leads unless forced; force uses the event id as idempotency key", async () => {
    await send({ type: "CAPTURE", leads: [lead(1)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    await flushed();
    const again = await send({ type: "CAPTURE", leads: [lead(1)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(again).toMatchObject({ ok: true, queued: 0, skippedDuplicates: ["https://www.linkedin.com/in/person-1"] });
    const forced = await send({ type: "CAPTURE", leads: [lead(1)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/", force: true }, PAGE);
    expect(forced.queued).toBe(1);
    expect(queue().at(-1)!.dedupeKey).toBe(queue().at(-1)!.id);
  });
  it("releases the identity when delivery fails permanently, keeps it after success", async () => {
    fetchMock.mockImplementation(async () => new Response("no", { status: 401 }));
    await send({ type: "CAPTURE", leads: [lead(5)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    await flushed();
    expect(queue()[0].status).toBe("failed");
    expect(dedupe()["https://www.linkedin.com/in/person-5"]).toBeUndefined();
    expect((await send({ type: "CHECK_DEDUPE", keys: ["https://www.linkedin.com/in/person-5"] }, PAGE))["https://www.linkedin.com/in/person-5"]).toBe(false);
    fetchMock.mockImplementation(async () => new Response("ok", { status: 200 }));
    const r = await send({ type: "CAPTURE", leads: [lead(5)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r.queued).toBe(1);
    await flushed();
    expect(dedupe()["https://www.linkedin.com/in/person-5"]).toMatchObject({ confirmed: true });
    expect(fake.store.daily as any).toMatchObject({ delivered: 1, failed: 1 });
  });
  it("retryable failures keep the reservation and schedule a retry", async () => {
    fetchMock.mockImplementation(async () => new Response("later", { status: 503 }));
    await send({ type: "CAPTURE", leads: [lead(6)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    await flushed();
    expect(queue()[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(dedupe()["https://www.linkedin.com/in/person-6"]).toMatchObject({ confirmed: false });
    expect(fake.alarms.has("lwe-flush")).toBe(true);
  });
});

describe("Deepline play destination", () => {
  beforeEach(async () => {
    await boot({ activeDestinationId: "p1" });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ workflowId: "wf_1" }), { status: 202 }));
  });
  it("runs the play once per lead with mapped input, API key auth, and records the run id", async () => {
    const r = await send({ type: "CAPTURE", leads: [lead(1), lead(2)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r.queued).toBe(2);
    await flushed();
    expect(apiCalls()).toHaveLength(2);
    const [url, init] = lastFetch();
    expect(url).toBe("https://code.deepline.com/api/v2/plays/run");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer dl_secret");
    const body = JSON.parse(init.body as string);
    expect(body.name).toBe("acme/warm-intro");
    expect(body.input).toEqual({ linkedin_url: "https://www.linkedin.com/in/person-2", first_name: "Person" });
    expect(queue().every((q) => q.status === "sent" && q.runId === "wf_1" && q.destinationKind === "deepline_play")).toBe(true);
    expect(log().find((e) => e.kind === "send.ok").msg).toMatch(/Play run started .* run wf_1/);
  });
  it("refuses to send people to a play that only takes searches, before anything leaves the browser", async () => {
    await boot({ destinations: [{ ...PLAY, input: { mode: "mapped", fields: ["search_url"], required: ["search_url"], acceptsSearch: true, acceptsLeads: false } }], activeDestinationId: "p1" });
    const r = await send({ type: "CAPTURE", leads: [lead(1)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r.rejectedReason).toBe("unsupported_by_play");
    expect(r.detail).toMatch(/does not take people/);
    expect(apiCalls()).toHaveLength(0);
  });
  it("the side panel can send to a non-active destination explicitly; deleting a destination fails its pending items", async () => {
    await send({ type: "CAPTURE", leads: [lead(3)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/", destinationId: "w1" }, PANEL);
    expect(queue()[0].destinationId).toBe("w1");
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    await flushed();
    expect(queue()[0].status).toBe("pending");
    fake.store.settings = { ...(fake.store.settings as any), destinations: [PLAY] };
    await send({ type: "RETRY_NOW" }, PANEL);
    await flushed();
    expect(queue()[0]).toMatchObject({ status: "failed", lastError: "destination_removed" });
  });
  it("lists plays through the worker and tests an API key without starting a run", async () => {
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify({ plays: url.includes("owned") ? [{ playKey: "acme/x", name: "x", inputSchema: null }] : [] }), { status: 200 }));
    const r = await send({ type: "LIST_PLAYS", baseUrl: "https://code.deepline.com", apiKey: "k" }, OPTIONS);
    expect(r.ok).toBe(true);
    expect(r.plays.map((p: any) => p.playKey)).toEqual(["acme/x"]);
    const t = await send({ type: "TEST_DESTINATION", destination: PLAY }, OPTIONS);
    expect(t.ok).toBe(true);
    expect(fetchMock.mock.calls.every(([u]) => !String(u).endsWith("/plays/run"))).toBe(true);
    expect(log().some((e) => e.kind === "destination.test" && e.msg.includes("test ok"))).toBe(true);
  });
  it("switching the active destination and pinning favorites are logged and reflected in state", async () => {
    const st = await send({ type: "SET_ACTIVE_DESTINATION", destinationId: "w1" }, PANEL);
    expect(st.settings.activeDestinationId).toBe("w1");
    const st2 = await send({ type: "TOGGLE_FAVORITE", destinationId: "w1" }, PANEL);
    expect(st2.settings.destinations.find((d: any) => d.id === "w1").favorite).toBe(true);
    expect(log().some((e) => e.kind === "destination.changed")).toBe(true);
  });
});

describe("basket across pages", () => {
  const P1 = "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&page=1&sessionId=A";
  const P2 = "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)&page=2&sessionId=B";
  const tab = (url: string) => ({ id: "ext-id", url, tab: { id: 9, url } });
  it("accumulates picks from several pages in session storage, drops duplicates, and tells tabs", async () => {
    const a = await send({ type: "BASKET_ADD", leads: [lead(1), lead(2)], pageType: "salesnav_search", pageUrl: P1, pageTitle: "Search" }, tab(P1));
    expect(a).toMatchObject({ count: 2, pages: 1, added: 2, full: false });
    const b = await send({ type: "BASKET_ADD", leads: [lead(2), lead(3)], pageType: "salesnav_search", pageUrl: P2 }, tab(P2));
    expect(b).toMatchObject({ count: 3, pages: 1, added: 1 });
    expect(Object.keys(basket())).toHaveLength(3);
    expect(fake.store.basket).toBeUndefined(); // never persisted to local storage
    const rm = await send({ type: "BASKET_REMOVE", keys: ["https://www.linkedin.com/in/person-1"] }, PANEL);
    expect(rm.count).toBe(2);
    expect(fake.broadcasts.filter((m: any) => m.type === "BASKET_CHANGED").length).toBeGreaterThanOrEqual(3);
    expect(await send({ type: "BASKET_GET" }, PANEL)).toMatchObject({ count: 2 });
    expect((await send({ type: "BASKET_CLEAR" }, PANEL)).count).toBe(0);
    expect(log().map((e) => e.kind)).toEqual(expect.arrayContaining(["basket.added", "basket.removed", "basket.cleared"]));
  });
  it("a page cannot add leads on behalf of another origin", async () => {
    expect(await send({ type: "BASKET_ADD", leads: [lead(1)], pageType: "salesnav_search", pageUrl: "https://evil.example/x" }, tab(P1))).toEqual({ error: "invalid_message" });
  });
  it("sending the basket uses one import id, one capture per source page, and empties what was queued", async () => {
    await send({ type: "BASKET_ADD", leads: [lead(1), lead(2)], pageType: "salesnav_search", pageUrl: P1, pageTitle: "Search" }, tab(P1));
    const other = "https://www.linkedin.com/sales/lists/people/555?sessionId=Z";
    await send({ type: "BASKET_ADD", leads: [lead(3)], pageType: "salesnav_list", pageUrl: other, pageTitle: "My list" }, tab(other));
    const r = await send({ type: "BASKET_SEND" }, PANEL);
    expect(r).toMatchObject({ ok: true, queued: 3, sentFromPages: 2 });
    expect(Object.keys(basket())).toHaveLength(0);
    const bodies = queue().map((q) => JSON.parse(q.body));
    expect(new Set(bodies.map((b) => b.import.import_id)).size).toBe(1);
    expect(bodies.every((b) => b.import.import_kind === "basket")).toBe(true);
    expect(bodies.find((b) => b.lead.full_name === "Person 3").import).toMatchObject({ list_id: "555", search_name: expect.stringContaining("My list") });
    expect(bodies.find((b) => b.lead.full_name === "Person 1").import.search_url).toContain("keywords%3Acro");
    expect(log().some((e) => e.kind === "basket.sent")).toBe(true);
  });
  it("what the daily cap refuses stays in the basket", async () => {
    await boot({ dailyCap: 2 });
    await send({ type: "BASKET_ADD", leads: [lead(1), lead(2), lead(3)], pageType: "salesnav_search", pageUrl: P1 }, tab(P1));
    const r = await send({ type: "BASKET_SEND" }, PANEL);
    expect(r.rejectedReason).toBe("daily_cap");
    expect(Object.keys(basket())).toHaveLength(3);
  });
});

describe("search hand-off", () => {
  it("sends a Sales Navigator search to a webhook as search.captured with the requested limit", async () => {
    const r = await send({ type: "SEARCH_CAPTURE", url: SEARCH_URL, pageType: "salesnav_search", totalHint: 320, limit: 150, searchName: "CROs" }, SEARCH_PAGE);
    expect(r).toMatchObject({ ok: true, queued: true, duplicate: false });
    await flushed();
    const body = JSON.parse(lastFetch()[1].body as string);
    expect(body).toMatchObject({ event: "search.captured", search: { search_url: "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)", limit: 150, total_hint: 320, keywords: "cro" }, import: { import_kind: "search", search_name: "CROs" } });
    expect(JSON.stringify(body)).not.toContain("sessionId");
    const dup = await send({ type: "SEARCH_CAPTURE", url: SEARCH_URL, pageType: "salesnav_search", totalHint: null }, SEARCH_PAGE);
    expect(dup.duplicate).toBe(true);
  });
  it("runs a play with the search URL on the play's declared field", async () => {
    await boot({ activeDestinationId: "p1" });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ workflowId: "wf_s" }), { status: 202 }));
    await send({ type: "SEARCH_CAPTURE", url: SEARCH_URL, pageType: "salesnav_search", totalHint: null, limit: 80 }, SEARCH_PAGE);
    await flushed();
    const body = JSON.parse(lastFetch()[1].body as string);
    expect(body.name).toBe("acme/warm-intro");
    expect(body.input).toEqual({ search_url: "https://www.linkedin.com/sales/search/people?query=(keywords%3Acro)", limit: 80 });
    expect(queue()[0].label).toMatch(/^search: /);
  });
  it("a saved search needs the share link first; once captured it is sent instead of the deep link", async () => {
    const saved = "https://www.linkedin.com/sales/search/people?savedSearchId=1898568618&sessionId=Q";
    const sender = { id: "ext-id", url: saved, tab: { id: 11, url: saved } };
    const ctx = { pageType: "salesnav_search", url: saved, title: "Search", lead: null, rowsOnPage: 4, selectedOnPage: 0, savedSearchId: "1898568618", shareUrl: null, searchName: "Lead Search 1", totalHint: 4 };
    expect(await send({ type: "PAGE_CONTEXT", context: ctx }, sender)).toEqual({ ok: true });
    const r = await send({ type: "SEARCH_CAPTURE", url: saved, pageType: "salesnav_search", totalHint: 4 }, sender);
    expect(r.rejectedReason).toBe("saved_search_needs_share_link");
    // A share link from the wrong place is ignored; the real one is remembered for the session.
    expect((await send({ type: "SHARE_LINK", url: "https://www.linkedin.com/in/someone" }, sender)).ok).toBe(false);
    const share = "https://www.linkedin.com/sales/search/people?query=(keywords%3Ainvestor)&sessionId=R";
    expect((await send({ type: "SHARE_LINK", url: share }, sender)).ok).toBe(true);
    expect((await send({ type: "GET_PAGE_CONTEXT", tabId: 11 }, PANEL)).shareUrl).toBe("https://www.linkedin.com/sales/search/people?query=(keywords%3Ainvestor)");
    const r2 = await send({ type: "SEARCH_CAPTURE", url: saved, pageType: "salesnav_search", totalHint: 4, searchName: "Lead Search 1" }, sender);
    expect(r2.ok).toBe(true);
    await flushed();
    const body = JSON.parse(lastFetch()[1].body as string);
    expect(body.search.search_url).toBe("https://www.linkedin.com/sales/search/people?query=(keywords%3Ainvestor)");
    expect(body.search.saved_search_id).toBe("1898568618");
    expect(log().some((e) => e.kind === "share_link.captured")).toBe(true);
  });
  it("page context from a page is validated and re-served to the panel; other origins are refused", async () => {
    const bad = await send({ type: "PAGE_CONTEXT", context: { pageType: "profile", url: "https://evil.example/in/x", title: "", lead: null, rowsOnPage: 0, selectedOnPage: 0, savedSearchId: null, shareUrl: null, searchName: null, totalHint: null } }, PAGE);
    expect(bad).toEqual({ error: "invalid_message" });
    await send({ type: "PAGE_CONTEXT", context: { pageType: "profile", url: "https://www.linkedin.com/in/x/", title: "X", lead: lead(1, { linkedin_url: "https://evil.example/in/p" }), rowsOnPage: -3, selectedOnPage: 0, savedSearchId: "abc", shareUrl: "https://x", searchName: null, totalHint: null } }, PAGE);
    const ctx = await send({ type: "GET_PAGE_CONTEXT", tabId: 7 }, PANEL);
    expect(ctx).toMatchObject({ pageType: "profile", rowsOnPage: 0, savedSearchId: null, shareUrl: null });
    expect(ctx.lead.linkedin_url).toBeNull();
    expect(fake.broadcasts.some((m: any) => m.type === "CONTEXT_CHANGED" && m.tabId === 7)).toBe(true);
  });
});

describe("lease recovery and queue commands", () => {
  it("a stale sending item (worker died mid-request) is retried on the next flush", async () => {
    fake.store.queue = [{ id: "stuck-xxxxxxxx", createdAt: Date.now(), nextAttemptAt: 1, attempts: 1, status: "sending", sendingAt: Date.now() - 10 * 60_000, body: "{}", leadUrls: ["k"], leadCount: 1, dedupeKey: "k", lastError: null, lastStatus: null, destinationId: "w1", destinationKind: "webhook" }];
    await send({ type: "RETRY_NOW" }, PANEL);
    await flushed();
    expect(queue()[0].status).toBe("sent");
    expect(log().some((e) => e.kind === "lease.recovered")).toBe(true);
  });
  it("clear history keeps only in-flight items; retry re-queues failed", async () => {
    fake.store.queue = [
      { id: "sent-xxxxxxxx", createdAt: 1, nextAttemptAt: 1, attempts: 1, status: "sent", sendingAt: null, body: "{}", leadUrls: [], leadCount: 1, dedupeKey: "a", lastError: null, lastStatus: 200, destinationId: "w1", destinationKind: "webhook" },
      { id: "fail-xxxxxxxx", createdAt: 1, nextAttemptAt: 1, attempts: 1, status: "failed", sendingAt: null, body: "{}", leadUrls: [], leadCount: 1, dedupeKey: "b", lastError: "x", lastStatus: 401, destinationId: "w1", destinationKind: "webhook" },
      { id: "live-xxxxxxxx", createdAt: 1, nextAttemptAt: 1, attempts: 1, status: "sending", sendingAt: Date.now(), body: "{}", leadUrls: [], leadCount: 1, dedupeKey: "c", lastError: null, lastStatus: null, destinationId: "w1", destinationKind: "webhook" }
    ];
    const st = await send({ type: "CLEAR_QUEUE", status: "all" }, PANEL);
    expect(st.queue.map((q: any) => q.id)).toEqual(["live-xxxxxxxx"]);
  });
});

describe("state and log", () => {
  it("GET_STATE reports local day, counters, basket size and confirmed dedupe count; GET_LOG returns newest first", async () => {
    await send({ type: "CAPTURE", leads: [lead(9)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    await flushed();
    const st = await send({ type: "GET_STATE" }, PANEL);
    expect(st.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(st).toMatchObject({ sentToday: 1, remainingToday: 99, dedupeCount: 1, basketCount: 0 });
    const entries = await send({ type: "GET_LOG", limit: 3 }, PANEL);
    expect(entries.length).toBe(3);
    expect(entries[0].t).toBeGreaterThanOrEqual(entries[2].t);
    expect(await send({ type: "CLEAR_LOG" }, PANEL)).toEqual([]);
    expect(log()).toEqual([]);
  });
});

describe("Deepline sign-in (session) and the web app channel", () => {
  const SESSION = { session: { user: { id: "u1", email: "rep@acme.com", name: "Rep" }, activeOrgId: "org_1" } };
  beforeEach(async () => {
    await boot({ destinations: [], activeDestinationId: null });
    (fake.chrome as any).cookies.get = async () => ({ name: "better-auth.session_token" });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/api/v2/auth/session")) return new Response(JSON.stringify(SESSION), { status: 200 });
      if (String(url).includes("/api/v2/plays?")) return new Response(JSON.stringify({ plays: String(url).includes("owned") ? [{ playKey: "acme/warm-intro", name: "warm-intro", displayName: "Warm intro", inputSchema: { properties: { linkedin_url: {}, first_name: {} } } }] : [] }), { status: 200 });
      if (String(url).endsWith("/api/v2/plays/run")) return new Response(JSON.stringify({ workflowId: "wf_s" }), { status: 202 });
      return new Response("{}", { status: 200 });
    });
  });
  it("reports the signed-in user from the cookie session and lists plays without an API key", async () => {
    const a = await send({ type: "GET_AUTH", refresh: true }, PANEL);
    expect(a).toMatchObject({ signedIn: true, email: "rep@acme.com", orgId: "org_1", baseUrl: "https://code.deepline.com" });
    const sessionCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/auth/session"))!;
    expect((sessionCall[1] as RequestInit).credentials).toBe("include");
    const r = await send({ type: "LIST_PLAYS" }, PANEL);
    expect(r.ok).toBe(true);
    const listCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/v2/plays?origin=owned"))!;
    expect((listCall[1] as RequestInit).credentials).toBe("include");
    expect(((listCall[1] as RequestInit).headers as Record<string, string>).Authorization).toBeUndefined();
    expect(log().some((e) => e.kind === "auth.changed" && /Signed in/.test(e.msg))).toBe(true);
  });
  it("adds a play with the sign-in and runs it with the session cookie, never a bearer header", async () => {
    await send({ type: "GET_AUTH", refresh: true }, PANEL);
    const st = await send({ type: "ADD_PLAY_DESTINATION", playKey: "acme/warm-intro", playName: "Warm intro", inputSchema: { properties: { linkedin_url: {}, first_name: {} } }, activate: true }, PANEL);
    expect(st.settings.destinations[0]).toMatchObject({ kind: "deepline_play", playKey: "acme/warm-intro", apiKey: "", input: { mode: "mapped", acceptsLeads: true } });
    expect(st.settings.activeDestinationId).toBe(st.settings.destinations[0].id);
    const r = await send({ type: "CAPTURE", leads: [lead(1)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r.queued).toBe(1);
    await flushed();
    const run = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/plays/run"))!;
    expect((run[1] as RequestInit).credentials).toBe("include");
    expect(((run[1] as RequestInit).headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse((run[1] as RequestInit).body as string)).toEqual({ name: "acme/warm-intro", input: { linkedin_url: "https://www.linkedin.com/in/person-1", first_name: "Person" } });
    expect(queue()[0]).toMatchObject({ status: "sent", runId: "wf_s" });
  });
  it("a signed-out rep gets a plain reason instead of a run", async () => {
    (fake.chrome as any).cookies.get = async () => null;
    fetchMock.mockImplementation(async (url: string) => new Response(String(url).includes("/api/v2/plays") ? '{"error":"Unauthorized"}' : "{}", { status: String(url).includes("/api/v2/plays") ? 401 : 200 }));
    const a = await send({ type: "GET_AUTH", refresh: true }, PANEL);
    expect(a.signedIn).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/auth/session"))).toBe(false); // no cookie, no call
    const r = await send({ type: "LIST_PLAYS" }, PANEL);
    expect(r).toMatchObject({ ok: false, error: "Not signed in to Deepline" });
  });
  it("cookie changes on the Deepline host refresh the session; others are ignored", async () => {
    await send({ type: "GET_AUTH", refresh: true }, PANEL);
    const before = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/session")).length;
    for (const fn of fake.listeners.cookieChanged) await fn({ cookie: { name: "li_at", domain: "www.linkedin.com" }, removed: false });
    await flushed();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/session")).length).toBe(before);
    for (const fn of fake.listeners.cookieChanged) await fn({ cookie: { name: "better-auth.session_token", domain: "code.deepline.com" }, removed: true });
    await flushed();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/session")).length).toBe(before + 1);
  });
  it("the web app channel answers ping / auth state only from Deepline origins", async () => {
    const external = (msg: unknown, sender: Record<string, unknown>) => new Promise<any>((resolve) => fake.listeners.messageExternal[0](msg, sender, resolve));
    await send({ type: "GET_AUTH", refresh: true }, PANEL);
    expect(await external({ type: "ping" }, { url: "https://evil.example/app", origin: "https://evil.example" })).toEqual({ error: "forbidden" });
    expect(await external({ type: "ping" }, { url: "http://deepline.com/app", origin: "http://deepline.com" })).toEqual({ error: "forbidden" });
    const ok = await external({ type: "ping" }, { url: "https://code.deepline.com/app", origin: "https://code.deepline.com" });
    expect(ok).toMatchObject({ ok: true, version: "test", signedIn: true });
    expect(await external({ type: "get_auth_state" }, { url: "https://deepline.com/", origin: "https://deepline.com" })).toMatchObject({ signedIn: true, email: "rep@acme.com" });
    expect(await external({ type: "steal" }, { url: "https://deepline.com/", origin: "https://deepline.com" })).toEqual({ error: "unknown message" });
    expect(log().filter((e) => e.kind === "external.message")).toHaveLength(3);
  });
  it("telemetry events are logged locally (no write key compiled in) and never fetch", async () => {
    await send({ type: "GET_AUTH", refresh: true }, PANEL);
    const before = fetchMock.mock.calls.length;
    await send({ type: "CAPTURE", leads: [lead(2)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, { ...PAGE });
    await flushed();
    expect(fetchMock.mock.calls.slice(before).some(([u]) => String(u).includes("segment"))).toBe(false);
    expect(log().some((e) => e.kind === "telemetry.event" && e.msg === "Event: push_queued")).toBe(false); // no destination: nothing queued
    expect(log().some((e) => e.kind === "telemetry.event")).toBe(true); // signed_in was recorded
  });
});
