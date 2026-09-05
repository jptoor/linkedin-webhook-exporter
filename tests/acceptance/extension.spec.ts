import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { configure, FixtureSite, hmacB64, hmacHex, launchWithExtension, MockDeepline, MockWebhook, openPanelFor, playDestination, readStorage, sendMessage, setSettings, webhookDestination } from "./harness";

const SECRET = "acceptance-secret";
let site: FixtureSite;
let hook: MockWebhook;
let dl: MockDeepline;
let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  site = new FixtureSite();
  await site.start();
});
test.afterAll(() => site.stop());

test.beforeEach(async () => {
  hook = new MockWebhook();
  await hook.start();
  dl = new MockDeepline();
  await dl.start();
  ({ context, extensionId } = await launchWithExtension());
});
test.afterEach(async () => {
  await context.close();
  hook.stop();
  dl.stop();
});

const dock = (p: Page) => p.locator("[data-lwe-panel]");
const status = (p: Page) => p.locator("[data-lwe-status]");
const push = (p: Page) => p.locator('[data-lwe-action="send"]');
const selectPage = (p: Page) => p.locator('[data-lwe-action="select-all"]');
const pills = (p: Page) => p.locator("[data-lwe-row-check]");
/** The dock mounts as "Loading…" until it knows the destination; click only once it does. */
const clickPush = async (p: Page) => {
  await expect(push(p)).not.toHaveText("Loading…");
  await push(p).click();
};
const PAGED = (n = 1) => `${site.origin}/sales/search/people?query=paged&page=${n}&sessionId=abc`;

/* AT-01 */
test("profile page: one click pushes a signed, well-formed lead.captured payload", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, capturedBy: "tester", customFields: { campaign: "q3", persona: "vp sales" } });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await expect(dock(page)).toBeVisible();
  await expect(push(page)).toHaveText("Push to Hook");
  await clickPush(page);
  await expect(status(page)).toHaveText(/1 on the way/);

  const [req] = await hook.waitFor(1);
  expect(req.headers["content-type"]).toBe("application/json");
  expect(req.headers["x-lwe-event-id"]).toMatch(/^[0-9a-f-]{36}$/);
  const ts = Number(req.headers["x-lwe-timestamp"]);
  expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(60);
  expect(req.headers["x-lwe-signature"]).toBe("sha256=" + hmacHex(SECRET, `${ts}.${req.body}`));

  const p = req.json;
  expect(p.schema_version).toBe("1");
  expect(p.event).toBe("lead.captured");
  expect(p.event_id).toBe(req.headers["x-lwe-event-id"]);
  expect(p.source).toMatchObject({ extension: "linkedin-webhook-exporter", page_type: "profile", captured_by: "tester" });
  expect(p.source.page_url).toBe(`${site.origin}/in/jane-doe-123/`);
  expect(p.custom).toEqual({ campaign: "q3", persona: "vp sales" });
  expect(p.lead).toMatchObject({
    full_name: "Jane Doe", first_name: "Jane", last_name: "Doe", title: "VP of Sales", company_name: "Acme Corp",
    company_linkedin_url: "https://www.linkedin.com/company/12345", location: "Austin, Texas, United States",
    linkedin_url: "https://www.linkedin.com/in/jane-doe-123", linkedin_slug: "jane-doe-123", connection_degree: "2nd"
  });
  expect(p.lead.experience).toHaveLength(2);
  expect(p.lead.education).toHaveLength(1);
  expect(p.lead.about).toContain("go-to-market");
  expect(p.import).toMatchObject({ import_kind: "manual", imported_by: "tester" });
});

/* AT-02 */
test("dedupe: the same profile is not pushed twice unless the rep asks", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await clickPush(page);
  await expect(status(page)).toHaveText(/1 on the way/);
  await hook.waitFor(1);

  await clickPush(page);
  await expect(status(page)).toHaveText(/pushed before/);
  await page.waitForTimeout(500);
  expect(hook.received).toHaveLength(1);

  await page.reload();
  await expect(status(page)).toHaveText(/Pushed before/);

  await page.locator('[data-lwe-action="tertiary"]').click(); // "Push again"
  await hook.waitFor(2);
  expect(hook.received[1].json.lead.linkedin_url).toBe("https://www.linkedin.com/in/jane-doe-123");
});

/* AT-03 */
test("Sales Navigator search: pick two people with the row pills and push; one request per person", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, sendMode: "single" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=cro`);
  await expect(pills(page)).toHaveCount(3);
  await expect(push(page)).toBeDisabled();
  await pills(page).nth(0).click();
  await pills(page).nth(1).click();
  await expect(pills(page).nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(push(page)).toHaveText("Push 2 to Hook");
  await expect(page.locator("[data-lwe-count]")).toHaveText("2/3");
  await clickPush(page);
  await expect(status(page)).toHaveText(/2 on the way/);

  const reqs = await hook.waitFor(2);
  const names = reqs.map((r) => r.json.lead.full_name).sort();
  expect(names).toEqual(["Alice Nguyen", "Bob Okafor"]);
  const bob = reqs.find((r) => r.json.lead.full_name === "Bob Okafor")!.json;
  expect(bob.source.page_type).toBe("salesnav_search");
  expect(bob.lead).toMatchObject({ title: "Chief Revenue Officer", company_name: "Umbrella Group", sales_navigator_url: "https://www.linkedin.com/sales/lead/ACwAAAdef456", linkedin_member_urn: "ACwAAAdef456", linkedin_url: null, connection_degree: "3rd" });
  expect(new Set(reqs.map((r) => r.headers["x-lwe-event-id"])).size).toBe(2);
  expect(bob.import).toMatchObject({ import_kind: "basket", search_name: "cro", list_id: null, page: 1 });
  expect(reqs[0].json.import.import_id).toBe(reqs[1].json.import.import_id);
  // rows are marked as sent, pills released, basket empty
  await expect(page.locator(".lwe-row-host.lwe-sent")).toHaveCount(2);
  await expect(pills(page).nth(0)).toHaveAttribute("aria-pressed", "false");
  await expect(push(page)).toBeDisabled();
});

/* AT-04 */
test("batch mode + flat preset: select the page and push one request with rows[]", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, sendMode: "batch", mappingPreset: "flat" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/search/results/people/?keywords=sales`);
  await expect(pills(page)).toHaveCount(2); // anonymous "LinkedIn Member" row excluded
  await selectPage(page).click();
  await expect(push(page)).toHaveText("Push 2 to Hook");
  await clickPush(page);
  const [req] = await hook.waitFor(1);
  expect(req.json.event).toBe("leads.captured");
  expect(req.json.rows).toHaveLength(2);
  const dana = req.json.rows.find((r: any) => r.full_name === "Dana White");
  expect(dana).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/dana-white-99", title: "Account Executive", company_name: "Hooli", page_type: "people_search" });
  for (const v of Object.values(dana)) expect(v === null || typeof v !== "object").toBe(true);
  await page.waitForTimeout(500);
  expect(hook.received).toHaveLength(1);
});

/* AT-05 */
test("deepline preset: flat row keyed by Deepline field names", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, mappingPreset: "deepline" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await clickPush(page);
  const [req] = await hook.waitFor(1);
  expect(Object.keys(req.json).slice(0, 4)).toEqual(["schema_version", "event", "event_id", "sent_at"]);
  expect(Object.keys(req.json).slice(4, 9)).toEqual(["linkedin_url", "first_name", "last_name", "title", "company_name"]);
  expect(req.json).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/jane-doe-123", title: "VP of Sales", company_name: "Acme Corp", company_domain: null, email: null, source: "linkedin-webhook-exporter", full_name: "Jane Doe", page_type: "profile" });
  expect(req.headers["x-deepline-dedupe-key"]).toBe("https://www.linkedin.com/in/jane-doe-123");
  expect(req.headers["idempotency-key"]).toBe("https://www.linkedin.com/in/jane-doe-123");
});

/* AT-05b */
test("standard webhooks scheme: webhook-id/timestamp/signature verify with a whsec_ secret", async () => {
  const rawKey = Buffer.from("deepline-play-secret-bytes");
  const secret = "whsec_" + rawKey.toString("base64");
  await configure(context, extensionId, { url: hook.url, signingSecret: secret, signatureScheme: "standard", mappingPreset: "deepline" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await clickPush(page);
  const [req] = await hook.waitFor(1);
  expect(req.headers["x-lwe-signature"]).toBeUndefined();
  const id = req.headers["webhook-id"];
  const ts = req.headers["webhook-timestamp"];
  expect(id).toBe(req.headers["x-lwe-event-id"]);
  expect(req.headers["webhook-signature"]).toBe("v1," + hmacB64(rawKey, `${id}.${ts}.${req.body}`));
});

/* AT-06 */
test("retry: a 503 is retried with backoff and the identical body is re-signed", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET });
  hook.failNext = [503];
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await clickPush(page);
  await hook.waitFor(1);
  let storage = await readStorage(context, extensionId);
  const item = storage.queue.find((q: any) => q.attempts === 1);
  expect(item.status).toBe("pending");
  expect(item.lastStatus).toBe(503);
  expect(item.nextAttemptAt).toBeGreaterThan(Date.now() + 30_000);

  await sendMessage(context, extensionId, { type: "RETRY_NOW" });
  const reqs = await hook.waitFor(2);
  expect(reqs[1].body).toBe(reqs[0].body);
  expect(reqs[1].headers["x-lwe-event-id"]).toBe(reqs[0].headers["x-lwe-event-id"]);
  const ts = Number(reqs[1].headers["x-lwe-timestamp"]);
  expect(reqs[1].headers["x-lwe-signature"]).toBe("sha256=" + hmacHex(SECRET, `${ts}.${reqs[1].body}`));
  storage = await readStorage(context, extensionId);
  expect(storage.queue[0].status).toBe("sent");
});

/* AT-07 */
test("a 401 is not retried and shows as Failed in the side panel with a retry link", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET });
  hook.failNext = [401];
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await clickPush(page);
  await hook.waitFor(1);
  await page.waitForTimeout(300);
  const storage = await readStorage(context, extensionId);
  expect(storage.queue[0]).toMatchObject({ status: "failed", attempts: 1, lastStatus: 401 });
  const panel = await openPanelFor(context, extensionId, page);
  await expect(panel.locator("#recent .chip.failed")).toHaveCount(1);
  await expect(panel.locator("#retry")).toBeVisible();
});

/* AT-08 */
test("daily cap blocks pushes beyond the limit; what was refused stays selected", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, dailyCap: 2, dedupe: false });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people`);
  await expect(pills(page)).toHaveCount(3);
  await selectPage(page).click();
  await expect(push(page)).toHaveText("Push 3 to Hook");
  await clickPush(page);
  await expect(status(page)).toHaveText(/hit today’s limit/);
  await page.waitForTimeout(300);
  expect(hook.received).toHaveLength(0);
  await expect(push(page)).toHaveText("Push 3 to Hook"); // still selected
  await selectPage(page).click(); // unselect page
  await expect(push(page)).toBeDisabled();
  await pills(page).first().click();
  await clickPush(page);
  await expect(status(page)).toHaveText(/1 on the way · 1 left today/);
});

/* AT-09 */
test("nothing connected: the push is refused with guidance and nothing leaves the browser", async () => {
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await clickPush(page);
  await expect(status(page)).toHaveText(/Choose where to send first/);
  expect(hook.received).toHaveLength(0);
  expect(dl.runs).toHaveLength(0);
  const panel = await openPanelFor(context, extensionId, page);
  await expect(panel.locator("#cta")).toHaveText("Choose where to send");
});

/* AT-10 */
test("settings: connecting a webhook rejects plain http and accepts localhost", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.click("#addWebhook");
  await page.fill("#url", "http://hooks.example.com/x");
  await page.click("#saveDest");
  await expect(page.locator("#destStatus")).toHaveText(/must use https/);
  await page.fill("#url", hook.url);
  await page.fill("#destName", "My hook");
  await page.click("#saveDest");
  await expect(page.locator("#status")).toHaveText(/Ready to push to “My hook”/);
  await expect(page.locator("#dests li")).toHaveCount(1);
  await expect(page.locator("#dests li .n")).toContainText("My hook · ready · current");
});

/* AT-11 */
test("settings: test connection reaches the webhook signed, with the extra header and event=test", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.click("#addWebhook");
  await page.fill("#url", hook.url);
  await page.locator("details summary").nth(1).click();
  await page.fill("#signingSecret", SECRET);
  await page.fill("#authHeaderName", "Authorization");
  await page.fill("#authHeaderValue", "Bearer tok");
  await page.click("#testDest");
  await expect(page.locator("#destStatus")).toHaveText(/answered 200/);
  const [req] = await hook.waitFor(0);
  void req;
  const t = hook.received[0];
  expect(t.json.event).toBe("test");
  expect(t.headers["authorization"]).toBe("Bearer tok");
  const ts = Number(t.headers["x-lwe-timestamp"]);
  expect(t.headers["x-lwe-signature"]).toBe("sha256=" + hmacHex(SECRET, `${ts}.${t.body}`));
});

/* AT-12 */
test("no UI is injected on non-supported pages", async () => {
  await configure(context, extensionId, { url: hook.url });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await expect(dock(page)).toBeVisible();
  await page.goto(`${site.origin}/feed/`).catch(() => undefined);
  await expect(dock(page)).toHaveCount(0);
});

/* ---------------- Selection across pages ---------------- */

/* AT-13 */
test("picks survive moving between result pages and push as one import", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, dailyCap: 2500 });
  const page = await context.newPage();
  await page.goto(PAGED(1));
  await expect(pills(page)).toHaveCount(25);
  await pills(page).nth(0).click();
  await pills(page).nth(1).click();
  await expect(push(page)).toHaveText("Push 2 to Hook");
  await page.goto(PAGED(2));
  await expect(pills(page)).toHaveCount(25);
  await expect(push(page)).toHaveText("Push 2 to Hook"); // still counting page 1
  await pills(page).nth(3).click();
  await pills(page).nth(4).click();
  await expect(push(page)).toHaveText("Push 4 to Hook");
  await expect(page.locator("[data-lwe-count]")).toHaveText("2/25");
  await page.goto(PAGED(1));
  await expect(pills(page).nth(0)).toHaveAttribute("aria-pressed", "true"); // page 1 picks remembered
  await clickPush(page);
  await expect(status(page)).toHaveText(/4 on the way/);
  const reqs = await hook.waitFor(4);
  expect(new Set(reqs.map((r) => r.json.import.import_id)).size).toBe(1);
  expect(reqs.every((r) => r.json.import.import_kind === "basket")).toBe(true);
  expect(reqs.map((r) => r.json.import.page).sort()).toEqual([1, 1, 2, 2]);
  expect(reqs.every((r) => r.json.import.search_url.includes("query=paged") && !r.json.import.search_url.includes("sessionId"))).toBe(true);
  await expect(push(page)).toBeDisabled();
});

/* AT-14 */
test("Sales Navigator's own checkboxes select people too, and unticking removes them", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=cro`);
  await expect(pills(page)).toHaveCount(3);
  await page.locator("input.row-select").nth(0).check();
  await page.locator("input.row-select").nth(2).check();
  await expect(push(page)).toHaveText("Push 2 to Hook");
  await expect(pills(page).nth(2)).toHaveAttribute("aria-pressed", "true");
  await expect(pills(page).nth(2)).toHaveAttribute("aria-label", /Remove .* from selection/);
  await page.locator("input.row-select").nth(0).uncheck();
  await expect(push(page)).toHaveText("Push 1 to Hook");
  // and our pill keeps LinkedIn's box in sync
  await pills(page).nth(1).click();
  await expect(page.locator("input.row-select").nth(1)).toBeChecked();
});

/* AT-15 */
test("side panel: shows the picked people, lets the rep drop one, and the pinned button says exactly what will happen", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, name: "Warm intro" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=cro`);
  await expect(pills(page)).toHaveCount(3);
  const panel = await openPanelFor(context, extensionId, page);
  await expect(panel.locator("#cta")).toHaveText("Pick people to push");
  await expect(panel.locator("#destName")).toHaveText("Warm intro");
  await panel.click("#addAll");
  await expect(panel.locator("#people .person")).toHaveCount(3);
  await expect(panel.locator("#cta")).toHaveText("Push 3 people to Warm intro");
  await expect(panel.locator("#listTitle")).toHaveText("3 selected");
  await panel.locator("#people .person").filter({ hasText: "Bob Okafor" }).locator("button").click();
  await expect(panel.locator("#people .person")).toHaveCount(2);
  await expect(page.locator("[data-lwe-count]")).toHaveText("2/3");
  await panel.click("#cta");
  await expect(panel.locator("#ctaStatus")).toHaveText(/2 people on the way/);
  const reqs = await hook.waitFor(2);
  expect(reqs.map((r) => r.json.lead.full_name).sort()).toEqual(["Alice Nguyen", "Carla Mendes"]);
  await expect(panel.locator("#recent .chip.sent")).toHaveCount(2);
});

/* ---------------- Deepline plays ---------------- */

/* AT-16 */
test("play destination: pushing a profile runs the play with mapped input and the org API key", async () => {
  const play = playDestination(dl, dl.plays[1]); // warm-intro: linkedin_url, first_name, last_name, company_name
  await setSettings(context, extensionId, { destinations: [play], activeDestinationId: "play", capturedBy: "tester" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  const panel = await openPanelFor(context, extensionId, page);
  await expect(panel.locator("#cta")).toHaveText("Push Jane to Warm intro");
  await expect(panel.locator("#leadName")).toHaveText("Jane Doe");
  await panel.click("#cta");
  const [run] = await dl.waitForRuns(1);
  expect(run.headers.authorization).toBe(`Bearer ${dl.apiKey}`);
  expect(run.headers["idempotency-key"]).toBe("https://www.linkedin.com/in/jane-doe-123");
  expect(run.json).toEqual({ name: "acme/warm-intro", input: { linkedin_url: "https://www.linkedin.com/in/jane-doe-123", first_name: "Jane", last_name: "Doe", company_name: "Acme Corp" } });
  await expect(panel.locator("#recent .chip.sent")).toHaveText("Running");
  expect(hook.received).toHaveLength(0);
  const storage = await readStorage(context, extensionId);
  expect(storage.queue[0]).toMatchObject({ status: "sent", runId: "wf_1", destinationKind: "deepline_play" });
});

/* AT-17 */
test("play with leads[]: a page of people becomes one run carrying every row and the import provenance", async () => {
  const play = playDestination(dl, dl.plays[0]); // linkedin-capture: leads[]
  await setSettings(context, extensionId, { destinations: [play], activeDestinationId: "play", capturedBy: "tester" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=cro`);
  await expect(pills(page)).toHaveCount(3);
  await selectPage(page).click();
  await clickPush(page);
  await expect(status(page)).toHaveText(/3 on the way/);
  const [run] = await dl.waitForRuns(1);
  expect(run.json.name).toBe("acme/linkedin-capture");
  expect(run.json.input.leads).toHaveLength(3);
  expect(run.json.input.leads[0]).toMatchObject({ event: "lead.captured", company_name: expect.any(String), import_kind: "basket" });
  expect(run.json.input).toMatchObject({ source: "linkedin-webhook-exporter", import_search_name: "cro", imported_by: "tester", captured_by: "tester" });
  await page.waitForTimeout(400);
  expect(dl.runs).toHaveLength(1);
});

/* AT-18 */
test("a play that only takes searches refuses people with a plain explanation, before any request", async () => {
  const play = playDestination(dl, dl.plays[2]); // search import
  await setSettings(context, extensionId, { destinations: [play], activeDestinationId: "play" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await clickPush(page);
  await expect(status(page)).toHaveText(/does not take people/);
  await page.waitForTimeout(300);
  expect(dl.runs).toHaveLength(0);
});

/* AT-19 */
test("settings: connecting a play lists the org's plays from the API, rejects a bad key, and stores the pick", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.click("#addDest");
  await page.locator("#playFields details summary").click();
  await page.fill("#baseUrl", dl.baseUrl);
  await page.fill("#apiKey", "wrong");
  await page.click("#loadPlays");
  await expect(page.locator("#playsStatus")).toHaveText(/rejected/);
  await page.fill("#apiKey", dl.apiKey);
  await page.click("#loadPlays");
  await expect(page.locator("#playsStatus")).toHaveText(/4 plays found/);
  await expect(page.locator("#plays button")).toHaveCount(4);
  await expect(page.locator("#plays button").first()).toContainText("LinkedIn capture"); // owned first, alphabetical
  await page.locator('#plays button[data-lwe-play="acme/salesnav-search-import"]').click();
  await expect(page.locator("#playPicked")).toContainText("searches · one run per lead");
  await expect(page.locator("#destName")).toHaveValue("Sales Navigator search import");
  await page.click("#saveDest");
  await expect(page.locator("#dests li .n")).toContainText("Sales Navigator search import · ready · current");
  const storage = await readStorage(context, extensionId);
  expect(storage.settings.destinations[0]).toMatchObject({ kind: "deepline_play", playKey: "acme/salesnav-search-import", apiKey: dl.apiKey, input: { mode: "mapped", acceptsSearch: true, acceptsLeads: false, required: ["search_url"] } });
  expect(dl.lists).toBeGreaterThanOrEqual(2);
});

/* ---------------- Whole-search import (backend fetches the members) ---------------- */

/* AT-20 */
test("import search: the side panel hands the search URL and a limit to the play; nothing is paged in the browser", async () => {
  const play = playDestination(dl, dl.plays[2]);
  await setSettings(context, extensionId, { destinations: [play], activeDestinationId: "play", capturedBy: "tester", searchDefaultLimit: 100 });
  const page = await context.newPage();
  await page.goto(PAGED(1));
  await expect(pills(page)).toHaveCount(25);
  const panel = await openPanelFor(context, extensionId, page);
  await expect(panel.locator("#searchSection")).toBeVisible();
  await expect(panel.locator("#searchLimit")).toHaveValue("100");
  await panel.fill("#searchLimit", "40");
  await panel.click("#sendSearch");
  await expect(panel.locator("#searchNote")).toHaveText(/Search import started: up to 40 people/);
  await expect(panel.locator("#cta")).toHaveText(/Search import started/);
  const [run] = await dl.waitForRuns(1);
  expect(run.json.name).toBe("acme/salesnav-search-import");
  expect(run.json.input).toEqual({ search_url: `${site.origin}/sales/search/people?query=paged`, limit: 40, search_name: "paged", imported_by: "tester" });
  await page.waitForTimeout(500);
  expect(dl.runs).toHaveLength(1);
  expect(page.url()).toBe(PAGED(1)); // the tab was never navigated
  await panel.click("#sendSearch");
  await expect(panel.locator("#searchNote")).toHaveText(/already imported/);
});

/* AT-21 */
test("import search to a webhook: one signed search.captured event with filters, limit and provenance", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, capturedBy: "tester" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=(keywords%3Acro%2Cfilters%3AList((type%3AREGION%2Cvalues%3AList((text%3AUnited%20States%2CselectionType%3AINCLUDED)))))&sessionId=zzz`);
  await page.locator('[data-lwe-action="tertiary"]').click(); // "Import search" on the dock
  await expect(status(page)).toHaveText(/Search import started \(up to 100 people\)/);
  await expect.poll(() => hook.searches.length).toBe(1);
  const s = hook.searches[0].json;
  expect(s.event).toBe("search.captured");
  expect(s.search).toMatchObject({ surface: "sales_navigator", keywords: "cro", filters: { REGION: ["United States"] }, limit: 100, saved_search_id: null });
  expect(s.search.search_url).not.toContain("sessionId");
  expect(s.import).toMatchObject({ import_kind: "search", imported_by: "tester" });
  expect(s.import.search_name).toContain("cro");
});

/* AT-22 */
test("saved search: import waits for Sales Navigator's share link, then sends the full query instead of the deep link", async () => {
  const play = playDestination(dl, dl.plays[2]);
  await setSettings(context, extensionId, { destinations: [play], activeDestinationId: "play" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?savedSearchId=1898568618&sessionId=Q`);
  await expect(pills(page)).toHaveCount(3);
  const panel = await openPanelFor(context, extensionId, page);
  await expect(panel.locator("#savedNote")).toContainText("This saved search is private");
  await expect(panel.locator("#sendSearch")).toBeDisabled();
  // Sales Navigator's "Share search" copies the shareable link; the MAIN-world hook catches it.
  await page.evaluate(() => navigator.clipboard.writeText("https://www.linkedin.com/sales/search/people?query=(keywords%3Ainvestor)&sessionId=R").catch(() => undefined));
  await expect(panel.locator("#shareOk")).toBeVisible();
  await expect(panel.locator("#sendSearch")).toBeEnabled();
  await panel.click("#sendSearch");
  const [run] = await dl.waitForRuns(1);
  expect(run.json.input.search_url).toBe("https://www.linkedin.com/sales/search/people?query=(keywords%3Ainvestor)");
  const storage = await readStorage(context, extensionId);
  expect(JSON.stringify(storage)).not.toContain("sessionId=R");
});

/* ---------------- Robustness ---------------- */

/* AT-23 */
test("navigating to a different query on the same path remounts the dock with fresh rows", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, dailyCap: 2500 });
  const page = await context.newPage();
  await page.goto(PAGED());
  await expect(pills(page)).toHaveCount(25);
  await page.evaluate(() => history.pushState({}, "", "/sales/search/people?query=paged&page=3"));
  await page.waitForTimeout(800);
  await expect(pills(page)).toHaveCount(25);
  await page.evaluate(() => history.replaceState({}, "", "/sales/search/people?query=paged&page=1&sessionId=abc"));
  await page.waitForTimeout(800);
  await expect(dock(page)).toHaveCount(1);
  await expect(pills(page)).toHaveCount(25);
  for (let i = 0; i < 20; i++) await page.evaluate((i) => history.pushState({}, "", `/sales/search/people?query=paged&page=${(i % 3) + 1}`), i);
  await page.waitForTimeout(1500);
  await expect(dock(page)).toHaveCount(1);
  await expect(pills(page)).toHaveCount(25);
});

/* AT-24 */
test("a lead list: select the page, push, messy names and hostile hosts handled, list id in the import", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, dailyCap: 2500 });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/lists/people/7263`);
  await expect(pills(page)).toHaveCount(12);
  await selectPage(page).click();
  await clickPush(page);
  const reqs = await hook.waitFor(12);
  const names = reqs.map((r) => r.json.lead.full_name);
  expect(names).toContain("Bob Okafor");
  expect(names).toContain("Владимир Петров");
  expect(names).toContain("O'Connor-Smith, Seán");
  const inj = reqs.find((r) => r.json.lead.full_name.includes("Injector"))!.json.lead;
  expect(inj.company_linkedin_url).toBeNull();
  expect(reqs.every((r) => r.json.import.list_id === "7263" && r.json.import.import_kind === "basket")).toBe(true);
});

/* AT-25 */
test("2026-layout profile and people search push well-formed records with warnings", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, dailyCap: 2500 });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/zoe-angstrom-%C3%A5/`);
  await clickPush(page);
  const [zoe] = await hook.waitFor(1);
  expect(zoe.json.lead).toMatchObject({ full_name: "Zoë Ångström", title: "Chief Revenue Officer", company_name: "Ångström & Sons", location: "Stockholm, Stockholm County, Sweden", connection_degree: "2nd" });
  expect(zoe.json.lead.parse_warnings).toContain("sdui_layout");
  expect(zoe.json.lead.experience).toHaveLength(5);
  await page.goto(`${site.origin}/search/results/people/?keywords=chief%20revenue%20officer`);
  await expect(pills(page)).toHaveCount(9);
  await selectPage(page).click();
  await clickPush(page);
  const reqs = await hook.waitFor(10);
  const cher = reqs.find((r) => r.json.lead.full_name === "Cher")!.json.lead;
  expect(cher).toMatchObject({ first_name: "Cher", last_name: null, location: "Mount Pleasant, South Carolina, United States", title: "Chief Revenue Officer (CRO)" });
  expect(reqs.find((r) => r.json.lead.full_name === "Hostile Host")!.json.lead.linkedin_url).toBeNull();
  expect(reqs.find((r) => r.json.lead.full_name === "李 小龙")!.json.lead.linkedin_url).toBe("https://www.linkedin.com/in/%E6%9D%8E%E5%B0%8F%E9%BE%99-abc");
});

/* AT-26 */
test("every action is logged automatically and secrets never appear in the log, the panel, or page-visible settings", async () => {
  const play = playDestination(dl, dl.plays[1]);
  await setSettings(context, extensionId, { destinations: [webhookDestination({ url: hook.url, signingSecret: "super-secret-value", authHeaderName: "Authorization", authHeaderValue: "Bearer token-value" }), play], activeDestinationId: "hook" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await clickPush(page);
  await hook.waitFor(1);
  await clickPush(page); // duplicate -> logged as skipped
  await expect(status(page)).toHaveText(/pushed before/);
  await pills(page).count();
  const entries = (await sendMessage(context, extensionId, { type: "GET_LOG", limit: 100 })) as Array<{ kind: string; msg: string }>;
  const kinds = entries.map((e) => e.kind);
  for (const k of ["capture.requested", "capture.queued", "send.attempt", "send.ok", "capture.duplicate"]) expect(kinds).toContain(k);
  const text = JSON.stringify(entries);
  expect(text).not.toContain("super-secret-value");
  expect(text).not.toContain("token-value");
  expect(text).not.toContain(dl.apiKey);
  const panel = await openPanelFor(context, extensionId, page);
  const st = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  expect(JSON.stringify(st.settings)).not.toMatch(/super-secret-value|token-value|dl_test_key/);
  await expect(panel.locator("#recent li").first()).toContainText("Jane Doe");
});

/* AT-27 */
test("shadow-root dock: LinkedIn-style page CSS cannot restyle the controls", async () => {
  await configure(context, extensionId, { url: hook.url });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await page.addStyleTag({ content: "button { display: none !important; background: red !important; }" });
  await expect(push(page)).toBeVisible();
  const bg = await push(page).evaluate((b) => getComputedStyle(b).backgroundColor);
  expect(bg).not.toBe("rgb(255, 0, 0)");
  expect(await dock(page).evaluate((h) => !!h.shadowRoot)).toBe(true);
});

/* AT-28 */
test("the daily cap holds across tabs: the second page's push is refused whole and stays selected", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET, dailyCap: 30, dedupe: false });
  const a = await context.newPage();
  await a.goto(PAGED(1));
  await expect(pills(a)).toHaveCount(25);
  await selectPage(a).click();
  await clickPush(a);
  await expect(status(a)).toHaveText(/25 on the way/);
  await hook.waitFor(25);
  const b = await context.newPage();
  await b.goto(PAGED(2));
  await expect(pills(b)).toHaveCount(25);
  await selectPage(b).click();
  await clickPush(b);
  await expect(status(b)).toHaveText(/hit today’s limit \(5 left\)/);
  await expect(push(b)).toHaveText("Push 25 to Hook");
  const st = await sendMessage(context, extensionId, { type: "GET_STATE" });
  expect(st).toMatchObject({ sentToday: 25, basketCount: 25 });
  expect(hook.leads.length).toBe(25);
});

/* AT-29 */
test("switching the destination in the panel changes where the next push goes; pins float to the top", async () => {
  const play = playDestination(dl, dl.plays[1]);
  await setSettings(context, extensionId, { destinations: [webhookDestination({ url: hook.url, name: "Zed hook" }), play], activeDestinationId: "hook" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  const panel = await openPanelFor(context, extensionId, page);
  await expect(panel.locator("#cta")).toHaveText("Push Jane to Zed hook");
  await panel.click("#destBtn");
  await expect(panel.locator("#sheetList li")).toHaveCount(2);
  await expect(panel.locator("#sheetList li").first()).toContainText("Warm intro"); // alphabetical
  await panel.locator('#sheetList li:has-text("Zed hook") .star').click();
  await expect(panel.locator("#sheetList li").first()).toContainText("Zed hook"); // pinned first
  await panel.fill("#sheetSearch", "warm");
  await expect(panel.locator("#sheetList li")).toHaveCount(1);
  await panel.locator('[data-lwe-dest="play"]').click();
  await expect(panel.locator("#sheet")).toBeHidden();
  await expect(panel.locator("#cta")).toHaveText("Push Jane to Warm intro");
  await expect(push(page)).toHaveText("Push to Warm intro");
  await panel.click("#cta");
  await dl.waitForRuns(1);
  expect(hook.leads).toHaveLength(0);
});

/* ---------------- Frontier-pattern layer: page bridge, session sign-in ---------------- */

/* AT-30 */
test("page bridge: the sales-api response the page loads fills public URLs, roles and regions the DOM never renders", async () => {
  await configure(context, extensionId, { url: hook.url, signingSecret: SECRET });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=api`);
  await expect(pills(page)).toHaveCount(3);
  await page.waitForTimeout(800); // the page's own XHR lands after load
  await selectPage(page).click();
  await expect(push(page)).toHaveText("Push 3 to Hook");
  await clickPush(page);
  const reqs = await hook.waitFor(3);
  const bob = reqs.find((r) => r.json.lead.full_name === "Bob Okafor")!.json.lead;
  // The API adds what the DOM never renders (public URL); clean DOM values (company URL, location) still win.
  expect(bob).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/bob-okafor-cro", linkedin_slug: "bob-okafor-cro", sales_navigator_url: "https://www.linkedin.com/sales/lead/ACwAAAdef456", location: "Toronto, Ontario, Canada", title: "Chief Revenue Officer", company_name: "Umbrella Group", company_linkedin_url: "https://www.linkedin.com/company/112233" });
  expect(bob.parse_warnings).toContain("api_merged");
  const carla = reqs.find((r) => r.json.lead.full_name === "Carla Mendes")!.json.lead;
  expect(carla.linkedin_url).toBeNull(); // no flagship URL in the payload: nothing invented
  expect(carla.parse_warnings).toContain("api_merged");
  const entries = (await sendMessage(context, extensionId, { type: "GET_LOG", limit: 100 })) as Array<{ kind: string; data?: any }>;
  const hit = entries.find((e) => e.kind === "intercept.captured");
  expect(hit?.data).toMatchObject({ people: 3, total: 4321 });
  // The bridge never issued a request of its own: the fixture server saw exactly one lead-search call (the page's).
});

/* AT-31 */
test("sign-in flow: a Deepline session cookie signs the panel in, plays load without a key, and runs carry the cookie", async () => {
  dl.sessionCookie = "tok_123";
  await setSettings(context, extensionId, { deeplineBaseUrl: dl.baseUrl, destinations: [], activeDestinationId: null });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  let panel = await openPanelFor(context, extensionId, page);
  await expect(panel.locator("#signIn")).toBeVisible();
  await expect(panel.locator("#cta")).toHaveText("Choose where to send");
  await panel.close();
  // The rep signs in to Deepline in a normal tab (here: the cookie appears).
  await context.addCookies([{ name: "better-auth.session_token", value: "tok_123", url: dl.baseUrl }]);
  panel = await openPanelFor(context, extensionId, page);
  await expect(panel.locator("#account")).toContainText("rep@acme.com");
  await expect(panel.locator("#signIn")).toBeHidden();
  await expect(panel.locator("#firstRun")).toBeVisible();
  await panel.click("#firstRunPick");
  await panel.locator('[data-lwe-play="acme/warm-intro"]').click();
  await expect(panel.locator("#ctaStatus")).toHaveText(/Connected Warm intro/);
  await expect(panel.locator("#cta")).toHaveText("Push Jane to Warm intro");
  const lists = dl.sessionCalls.length;
  expect(lists).toBeGreaterThan(0);
  expect(dl.sessionCalls.every((c) => c.cookie.includes("tok_123") && c.authorization === null)).toBe(true);
  await panel.click("#cta");
  const [run] = await dl.waitForRuns(1);
  expect(run.headers.cookie).toContain("better-auth.session_token=tok_123");
  expect(run.headers.authorization).toBeUndefined();
  expect(run.json).toEqual({ name: "acme/warm-intro", input: { linkedin_url: "https://www.linkedin.com/in/jane-doe-123", first_name: "Jane", last_name: "Doe", company_name: "Acme Corp" } });
  const storage = await readStorage(context, extensionId);
  expect(storage.settings.destinations[0]).toMatchObject({ kind: "deepline_play", apiKey: "", playKey: "acme/warm-intro" });
  expect(JSON.stringify(storage)).not.toContain("tok_123"); // the cookie value never enters extension storage
});
