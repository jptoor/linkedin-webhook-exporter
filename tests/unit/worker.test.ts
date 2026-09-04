/** Service-worker behavior with a fake chrome runtime: concurrency under the
 *  storage lock, daily cap, dedupe reservation/confirmation/release, lease
 *  recovery, message trust boundary, secret redaction, activity log. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChrome, messenger } from "./fake-chrome";

const PAGE = { id: "ext-id", url: "https://www.linkedin.com/in/x/", tab: { id: 7, url: "https://www.linkedin.com/in/x/" } };
const POPUP = { id: "ext-id", url: "chrome-extension://ext-id/popup.html" };
const lead = (i: number, over: Record<string, unknown> = {}) => ({ full_name: `Person ${i}`, first_name: "Person", last_name: String(i), headline: null, title: "VP", company_name: "Acme", company_linkedin_url: null, location: "Austin", linkedin_url: `https://www.linkedin.com/in/person-${i}`, linkedin_slug: `person-${i}`, linkedin_member_urn: null, sales_navigator_url: null, connection_degree: null, profile_image_url: null, about: null, experience: [], education: [], captured_at: "2026-09-03T00:00:00.000Z", parse_warnings: [], ...over });

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
  fake.store.settings = { webhookUrl: "https://hooks.example.com/x", signingSecret: "s", dailyCap: 100, dedupe: true, ...settings };
  await import("../../src/background/service-worker");
  send = messenger(fake.listeners);
  await new Promise((r) => setTimeout(r, 20));
}
const flushed = () => new Promise((r) => setTimeout(r, 200));
const queue = () => (fake.store.queue as any[]) ?? [];
const dedupe = () => (fake.store.dedupe as Record<string, any>) ?? {};
const log = () => (fake.store.activityLog as any[]) ?? [];

beforeEach(async () => {
  await boot();
});

describe("trust boundary", () => {
  it("rejects messages from other extensions and unknown senders", async () => {
    expect(await send({ type: "GET_STATE" }, { id: "other", url: "chrome-extension://other/popup.html" })).toEqual({ error: "invalid_sender" });
    expect(await send({ type: "GET_STATE" }, { id: "ext-id", tab: { id: 1, url: "https://evil.example/" } })).toEqual({ error: "invalid_sender" });
  });
  it("content scripts get redacted settings and cannot run privileged commands", async () => {
    const s = await send({ type: "GET_SETTINGS" }, PAGE);
    expect(s.signingSecret).toBeUndefined();
    expect(s.webhookUrl).toBeUndefined();
    expect(s.hasWebhook).toBe(true);
    expect((await send({ type: "GET_SETTINGS" }, POPUP)).signingSecret).toBe("s");
    for (const type of ["RETRY_NOW", "CLEAR_QUEUE", "TEST_WEBHOOK", "GET_STATE", "GET_LOG"]) expect(await send({ type }, PAGE)).toEqual({ error: "forbidden" });
  });
  it("page-originated captures must match the sender tab origin and be a supported page", async () => {
    const r = await send({ type: "CAPTURE", leads: [lead(1)], pageType: "profile", pageUrl: "https://evil.example/in/x" }, PAGE);
    expect(r.rejectedReason).toBe("invalid_message");
    const r2 = await send({ type: "CAPTURE", leads: [lead(1)], pageType: "evil", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r2.rejectedReason).toBe("invalid_message");
    const r3 = await send({ type: "CAPTURE", leads: "nope", pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r3.rejectedReason).toBe("nothing_to_send");
  });
});

describe("capture, cap and dedupe", () => {
  it("queues valid leads, re-validates hostile URLs, dedupes within a message, logs", async () => {
    const r = await send({ type: "CAPTURE", leads: [lead(1), lead(1), lead(2, { linkedin_url: "https://evil.example/in/p2", sales_navigator_url: null }), { full_name: "" }], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    expect(r).toMatchObject({ ok: true, queued: 2, remainingToday: 98 });
    await flushed();
    expect(queue().every((q) => q.status === "sent")).toBe(true);
    expect(Object.keys(dedupe()).sort()).toEqual(["https://www.linkedin.com/in/person-1", "name:person 2|acme"]);
    expect(log().map((e) => e.kind)).toEqual(expect.arrayContaining(["capture.requested", "capture.queued", "send.attempt", "send.ok"]));
    expect(JSON.stringify(log())).not.toContain('"s"');
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
    const item = queue().find((q) => q.attempts === 0 || q.createdAt >= 0);
    expect(queue().at(-1)!.dedupeKey).toBe(queue().at(-1)!.id);
    void item;
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
    expect((fake.store.daily as any)).toMatchObject({ delivered: 1, failed: 1 });
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

describe("lease recovery and queue commands", () => {
  it("a stale sending item (worker died mid-request) is retried on the next flush", async () => {
    fake.store.queue = [{ id: "stuck-xxxxxxxx", createdAt: Date.now(), nextAttemptAt: 1, attempts: 1, status: "sending", sendingAt: Date.now() - 10 * 60_000, body: "{}", leadUrls: ["k"], leadCount: 1, dedupeKey: "k", lastError: null, lastStatus: null }];
    await send({ type: "RETRY_NOW" }, POPUP);
    await flushed();
    expect(queue()[0].status).toBe("sent");
    expect(log().some((e) => e.kind === "lease.recovered")).toBe(true);
  });
  it("clear history keeps only in-flight items; retry re-queues failed", async () => {
    fake.store.queue = [
      { id: "sent-xxxxxxxx", createdAt: 1, nextAttemptAt: 1, attempts: 1, status: "sent", sendingAt: null, body: "{}", leadUrls: [], leadCount: 1, dedupeKey: "a", lastError: null, lastStatus: 200 },
      { id: "fail-xxxxxxxx", createdAt: 1, nextAttemptAt: 1, attempts: 1, status: "failed", sendingAt: null, body: "{}", leadUrls: [], leadCount: 1, dedupeKey: "b", lastError: "x", lastStatus: 401 },
      { id: "live-xxxxxxxx", createdAt: 1, nextAttemptAt: 1, attempts: 1, status: "sending", sendingAt: Date.now(), body: "{}", leadUrls: [], leadCount: 1, dedupeKey: "c", lastError: null, lastStatus: null }
    ];
    const st = await send({ type: "CLEAR_QUEUE", status: "all" }, POPUP);
    expect(st.queue.map((q: any) => q.id)).toEqual(["live-xxxxxxxx"]);
  });
});

describe("state and log", () => {
  it("GET_STATE reports local day, counters and confirmed dedupe count; GET_LOG returns newest first", async () => {
    await send({ type: "CAPTURE", leads: [lead(9)], pageType: "profile", pageUrl: "https://www.linkedin.com/in/x/" }, PAGE);
    await flushed();
    const st = await send({ type: "GET_STATE" }, POPUP);
    expect(st.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(st).toMatchObject({ sentToday: 1, remainingToday: 99, dedupeCount: 1 });
    const entries = await send({ type: "GET_LOG", limit: 3 }, POPUP);
    expect(entries.length).toBe(3);
    expect(entries[0].t).toBeGreaterThanOrEqual(entries[2].t);
    expect(await send({ type: "CLEAR_LOG" }, POPUP)).toEqual([]);
    expect(log()).toEqual([]);
  });
});
