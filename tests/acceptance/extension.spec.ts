import { expect, test, type BrowserContext } from "@playwright/test";
import { cleanSampleName, configure, FixtureSite, hmacB64, hmacHex, launchWithExtension, MockWebhook, PAGED_TOTAL, readStorage, sendMessage } from "./harness";

const SECRET = "acceptance-secret";
let site: FixtureSite;
let hook: MockWebhook;
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
  ({ context, extensionId } = await launchWithExtension());
});
test.afterEach(async () => {
  await context.close();
  hook.stop();
});

/* AT-01 */
test("profile page: one click sends a signed, well-formed lead.captured payload", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, capturedBy: "tester", customFields: "campaign=q3\npersona=vp sales" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  const panel = page.locator("[data-lwe-panel]");
  await expect(panel).toBeVisible();
  await panel.locator('[data-lwe-action="send"]').click();
  await expect(panel.locator("[data-lwe-status]")).toHaveText(/Queued 1/);

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
  expect(p.lead.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

/* AT-02 */
test("dedupe: the same profile is not sent twice unless forced", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  const panel = page.locator("[data-lwe-panel]");
  await panel.locator('[data-lwe-action="send"]').click();
  await expect(panel.locator("[data-lwe-status]")).toHaveText(/Queued 1/);
  await hook.waitFor(1);

  await panel.locator('[data-lwe-action="send"]').click();
  await expect(panel.locator("[data-lwe-status]")).toHaveText(/already sent/);
  await page.waitForTimeout(500);
  expect(hook.received).toHaveLength(1);

  await page.reload();
  await expect(page.locator("[data-lwe-status]")).toHaveText(/Already sent/);

  await page.locator('[data-lwe-action="select-all"]').click(); // "Force resend" on single pages
  await hook.waitFor(2);
  expect(hook.received[1].json.lead.linkedin_url).toBe("https://www.linkedin.com/in/jane-doe-123");
});

/* AT-03 */
test("Sales Navigator search: select rows and send; single mode yields one request per lead", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, sendMode: "single" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=cro`);
  const boxes = page.locator("[data-lwe-row-check]");
  await expect(boxes).toHaveCount(3);
  await expect(page.locator('[data-lwe-action="send"]')).toBeDisabled();
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(page.locator('[data-lwe-action="send"]')).toHaveText("Send 2 selected");
  await page.locator('[data-lwe-action="send"]').click();
  await expect(page.locator("[data-lwe-status]")).toHaveText(/Queued 2/);

  const reqs = await hook.waitFor(2);
  const names = reqs.map((r) => r.json.lead.full_name).sort();
  expect(names).toEqual(["Alice Nguyen", "Bob Okafor"]);
  const bob = reqs.find((r) => r.json.lead.full_name === "Bob Okafor")!.json;
  expect(bob.source.page_type).toBe("salesnav_search");
  expect(bob.lead).toMatchObject({ title: "Chief Revenue Officer", company_name: "Umbrella Group", sales_navigator_url: "https://www.linkedin.com/sales/lead/ACwAAAdef456", linkedin_member_urn: "ACwAAAdef456", linkedin_url: null, connection_degree: "3rd" });
  expect(new Set(reqs.map((r) => r.headers["x-lwe-event-id"])).size).toBe(2);
  // both leads share one manual import with the search name derived from the URL
  expect(bob.import).toMatchObject({ import_kind: "manual", search_name: "cro", list_id: null, page: 1 });
  expect(bob.import.import_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(reqs[0].json.import.import_id).toBe(reqs[1].json.import.import_id);
  // rows are marked as sent and unchecked
  await expect(page.locator(".lwe-row-host.lwe-sent")).toHaveCount(2);
  await expect(boxes.nth(0)).not.toBeChecked();
});

/* AT-04 */
test("batch mode + flat preset: select all sends one request with rows[]", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, sendMode: "batch", mappingPreset: "flat" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/search/results/people/?keywords=sales`);
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(2); // anonymous "LinkedIn Member" row excluded
  await page.locator('[data-lwe-action="select-all"]').click();
  await page.locator('[data-lwe-action="send"]').click();
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
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, mappingPreset: "deepline" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await page.locator('[data-lwe-action="send"]').click();
  const [req] = await hook.waitFor(1);
  expect(Object.keys(req.json).slice(0, 4)).toEqual(["schema_version", "event", "event_id", "sent_at"]);
  expect(Object.keys(req.json).slice(4, 9)).toEqual(["linkedin_url", "first_name", "last_name", "title", "company_name"]);
  expect(req.json).toMatchObject({ linkedin_url: "https://www.linkedin.com/in/jane-doe-123", title: "VP of Sales", company_name: "Acme Corp", company_domain: null, email: null, source: "linkedin-webhook-exporter", full_name: "Jane Doe", page_type: "profile" });
  expect(req.json.event_id).toBe(req.headers["x-lwe-event-id"]);
  // Deepline idempotency: single sends are keyed by profile identity, not event id.
  expect(req.headers["x-deepline-dedupe-key"]).toBe("https://www.linkedin.com/in/jane-doe-123");
  expect(req.headers["idempotency-key"]).toBe("https://www.linkedin.com/in/jane-doe-123");
});

/* AT-05b */
test("standard webhooks scheme: webhook-id/timestamp/signature verify with a whsec_ secret", async () => {
  const rawKey = Buffer.from("deepline-play-secret-bytes");
  const secret = "whsec_" + rawKey.toString("base64");
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: secret, signatureScheme: "standard", mappingPreset: "deepline" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await page.locator('[data-lwe-action="send"]').click();
  const [req] = await hook.waitFor(1);
  expect(req.headers["x-lwe-signature"]).toBeUndefined();
  const id = req.headers["webhook-id"];
  const ts = req.headers["webhook-timestamp"];
  expect(id).toBe(req.headers["x-lwe-event-id"]);
  expect(id).not.toContain(".");
  expect(ts).toMatch(/^\d+$/);
  expect(req.headers["webhook-signature"]).toBe("v1," + hmacB64(rawKey, `${id}.${ts}.${req.body}`));
});

/* AT-06 */
test("retry: a 503 is retried with backoff and the identical body is re-signed", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET });
  hook.failNext = [503];
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await page.locator('[data-lwe-action="send"]').click();
  await hook.waitFor(1);
  let storage = await readStorage(context, extensionId);
  const item = storage.queue.find((q: any) => q.attempts === 1);
  expect(item.status).toBe("pending");
  expect(item.lastStatus).toBe(503);
  expect(item.nextAttemptAt).toBeGreaterThan(Date.now() + 30_000);

  // Force the retry now rather than waiting a minute.
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
test("a 401 is not retried and is surfaced as failed", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET });
  hook.failNext = [401];
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await page.locator('[data-lwe-action="send"]').click();
  await hook.waitFor(1);
  await page.waitForTimeout(300);
  const storage = await readStorage(context, extensionId);
  expect(storage.queue[0]).toMatchObject({ status: "failed", attempts: 1, lastStatus: 401 });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("#queue .pill.failed")).toHaveCount(1);
});

/* AT-08 */
test("daily cap blocks sends beyond the limit", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2, dedupe: false });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people`);
  await page.locator('[data-lwe-action="select-all"]').click();
  await page.locator('[data-lwe-action="send"]').click();
  await expect(page.locator("[data-lwe-status]")).toHaveText(/Daily cap reached/);
  await page.waitForTimeout(300);
  expect(hook.received).toHaveLength(0);
  const first = page.locator("[data-lwe-row-check]").first();
  await page.locator('[data-lwe-action="select-all"]').click(); // clear
  await first.check();
  await page.locator('[data-lwe-action="send"]').click();
  await expect(page.locator("[data-lwe-status]")).toHaveText(/Queued 1 · 1 left today/);
});

/* AT-09 */
test("no webhook configured: capture is rejected with guidance and nothing leaves the browser", async () => {
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await page.locator('[data-lwe-action="send"]').click();
  await expect(page.locator("[data-lwe-status]")).toHaveText(/No webhook configured/);
  expect(hook.received).toHaveLength(0);
});

/* AT-10 */
test("options: rejects a plain-http webhook URL and accepts localhost", async () => {
  const page = await configure(context, extensionId, { webhookUrl: "http://hooks.example.com/x" });
  await expect(page.locator("#status")).toHaveText(/must use https/);
  await page.fill("#webhookUrl", hook.url);
  await page.click("#save");
  await expect(page.locator("#status")).toHaveText("Saved.");
});

/* AT-11 */
test("options: test event reaches the webhook signed and with event=test", async () => {
  const page = await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, authHeaderName: "Authorization", authHeaderValue: "Bearer tok" });
  await page.click("#test");
  await expect(page.locator("#status")).toHaveText(/responded 200/);
  const [req] = await hook.waitFor(1);
  expect(req.json.event).toBe("test");
  expect(req.headers["authorization"]).toBe("Bearer tok");
  const ts = Number(req.headers["x-lwe-timestamp"]);
  expect(req.headers["x-lwe-signature"]).toBe("sha256=" + hmacHex(SECRET, `${ts}.${req.body}`));
});

/* AT-12 */
test("no UI is injected on non-supported pages", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await expect(page.locator("[data-lwe-panel]")).toBeVisible();
  await page.goto(`${site.origin}/feed/`).catch(() => undefined);
  await expect(page.locator("[data-lwe-panel]")).toHaveCount(0);
});

/* ---------------- Bulk export (parity with Wiza / Prospeo / lemlist / Exportly) ---------------- */

const FAST = { exportPageDelayMinMs: 100, exportPageDelayMaxMs: 200 };
const PAGED = () => `${site.origin}/sales/search/people?query=paged&sessionId=abc`;

async function waitForJob(pred: (j: any) => boolean, timeoutMs = 60_000): Promise<any> {
  const start = Date.now();
  for (;;) {
    const st = await sendMessage(context, extensionId, { type: "EXPORT_STATUS" });
    const j = st.job ?? st.history[0] ?? null;
    if (j && pred(j)) return j;
    if (Date.now() - start > timeoutMs) throw new Error(`job did not reach state in time: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/* AT-13 */
test("export all pages from the panel: walks every page, respects the limit, keeps order", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, ...FAST });
  const page = await context.newPage();
  await page.goto(PAGED());
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25);
  await page.fill("[data-lwe-export-limit]", "40");
  await page.locator('[data-lwe-action="export-all"]').click();
  await expect(page.locator("[data-lwe-export-status]")).toContainText(/Exporting/);
  const job = await waitForJob((j) => j.status === "done");
  expect(job).toMatchObject({ status: "done", stopReason: "limit", pagesDone: 2, collected: 40, sent: 40, skipped: 0, totalHint: 60 });
  const reqs = await hook.waitFor(40);
  expect(reqs.map((r) => r.json.lead.full_name)).toEqual(Array.from({ length: 40 }, (_, i) => cleanSampleName(i + 1)));
  expect(reqs[39].json.source.page_url).toContain("page=2");
  // every lead of the export carries the job id as import id, page number, and search name
  expect(reqs[0].json.import).toMatchObject({ import_id: job.id, import_kind: "export", page: 1, search_name: "paged" });
  expect(reqs[39].json.import).toMatchObject({ import_id: job.id, page: 2 });
  expect(reqs[0].json.source.page_url).not.toContain("page=");
  // the tab ended on page 2 and the panel shows the finished state
  expect(page.url()).toContain("page=2");
  await expect(page.locator("[data-lwe-export-status]")).toContainText(/Done \(limit reached\)/);
});

/* AT-14 */
test("export from the popup by URL: opens a tab, runs to the last page, stops on no more results", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, ...FAST });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill("#exportUrl", PAGED());
  await popup.fill("#exportLimit", "2500");
  await popup.click("#exportStart");
  await expect(popup.locator("#exportText")).toContainText(/running/);
  const job = await waitForJob((j) => j.status === "done", 45_000);
  expect(job).toMatchObject({ status: "done", stopReason: "no_more_pages", pagesDone: 3, collected: PAGED_TOTAL, sent: PAGED_TOTAL });
  await hook.waitFor(PAGED_TOTAL);
  expect(new Set(hook.leads.map((r) => r.json.lead.sales_navigator_url)).size).toBe(PAGED_TOTAL);
  // the search itself was recorded once, with its filters and result count
  expect(hook.searches).toHaveLength(1);
  expect(hook.searches[0].json.search).toMatchObject({ surface: "sales_navigator", page_type: "salesnav_search", keywords: "paged", page: 1, list_id: null });
  await expect(popup.locator("#exportText")).toContainText(/done \(no more results\)/);
});

/* AT-15 */
test("stop mid-run halts navigation and archives the job", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, exportPageDelayMinMs: 3000, exportPageDelayMaxMs: 3000 });
  const page = await context.newPage();
  await page.goto(PAGED());
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25);
  await page.locator('[data-lwe-action="export-all"]').click();
  await waitForJob((j) => j.pagesDone >= 1);
  await page.locator('[data-lwe-action="export-stop"]').click();
  const job = await waitForJob((j) => j.status === "stopped");
  expect(job).toMatchObject({ status: "stopped", stopReason: "user", pagesDone: 1, sent: 25 });
  await page.waitForTimeout(3500);
  expect(hook.leads.length).toBe(25);
  expect(hook.searches.length).toBe(1); // the search itself was saved at export start
  const st = await sendMessage(context, extensionId, { type: "EXPORT_STATUS" });
  expect(st.job).toBeNull();
  expect(st.history[0].id).toBe(job.id);
});

/* AT-16 */
test("daily cap stops the export after sending what is allowed", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 30, ...FAST });
  const page = await context.newPage();
  await page.goto(PAGED());
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25);
  await page.locator('[data-lwe-action="export-all"]').click();
  const job = await waitForJob((j) => j.status !== "running" && j.status !== "paused");
  expect(job).toMatchObject({ status: "stopped", stopReason: "daily_cap", pagesDone: 2, sent: 30 });
  await hook.waitFor(30);
  await page.waitForTimeout(500);
  expect(hook.leads.length).toBe(30);
});

/* AT-17 */
test("already-sent people are skipped, not re-sent, and counted", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, ...FAST });
  const page = await context.newPage();
  await page.goto(PAGED());
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25);
  await page.locator('[data-lwe-action="select-all"]').click();
  await expect(page.locator('[data-lwe-action="send"]')).toHaveText("Send 25 selected");
  await page.locator('[data-lwe-action="send"]').click();
  await expect(page.locator("[data-lwe-status]")).toHaveText(/Queued 25/);
  await hook.waitFor(25);
  await page.fill("[data-lwe-export-limit]", "30");
  await page.locator('[data-lwe-action="export-all"]').click();
  const job = await waitForJob((j) => j.status === "done");
  expect(job).toMatchObject({ collected: 30, sent: 5, skipped: 25, stopReason: "limit" });
  await hook.waitFor(30);
  await page.waitForTimeout(300);
  expect(hook.leads.length).toBe(30);
  expect(hook.leads.slice(25).map((r) => r.json.lead.full_name)).toEqual([26, 27, 28, 29, 30].map(cleanSampleName));
});

/* AT-18 */
test("pause and resume from the popup", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, exportPageDelayMinMs: 1500, exportPageDelayMaxMs: 1500 });
  const page = await context.newPage();
  await page.goto(PAGED());
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25);
  await page.locator('[data-lwe-action="export-all"]').click();
  await expect(page.locator("[data-lwe-export-status]")).toContainText(/Exporting|Done|Paused/);
  await waitForJob((j) => j.pagesDone >= 1);
  let st = await sendMessage(context, extensionId, { type: "EXPORT_PAUSE" });
  expect(st.job.status).toBe("paused");
  const pagesAtPause = st.job.pagesDone;
  await page.waitForTimeout(3500);
  st = await sendMessage(context, extensionId, { type: "EXPORT_STATUS" });
  expect(st.job.pagesDone).toBe(pagesAtPause);
  await sendMessage(context, extensionId, { type: "EXPORT_RESUME" });
  const job = await waitForJob((j) => j.status === "done", 45_000);
  expect(job).toMatchObject({ pagesDone: 3, sent: PAGED_TOTAL });
});

/* AT-19 */
test("export refuses to start without a webhook or on a non-exportable URL", async () => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.fill("#exportUrl", PAGED());
  await popup.click("#exportStart");
  await expect(popup.locator("#exportError")).toHaveText(/Configure a webhook first/);
  await configure(context, extensionId, { webhookUrl: hook.url });
  await popup.bringToFront();
  await popup.fill("#exportUrl", `${site.origin}/in/jane-doe-123/`);
  await popup.click("#exportStart");
  await expect(popup.locator("#exportError")).toHaveText(/not a Sales Navigator/);
  expect(hook.received).toHaveLength(0);
});

/* ---------------- audit remediation: navigation, lazy rows, samples, log, secrets ---------------- */

/* AT-20 */
test("navigating to a different query on the same path remounts the panel with fresh rows", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500 });
  const page = await context.newPage();
  await page.goto(PAGED());
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25);
  // Same path, different query, via pushState (SPA style), then replaceState.
  await page.evaluate(() => history.pushState({}, "", "/sales/search/people?query=paged&page=3"));
  await page.waitForTimeout(800);
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25); // DOM unchanged; rows re-decorated once, never duplicated
  await page.evaluate(() => history.replaceState({}, "", "/sales/search/people?query=paged&page=1&sessionId=abc"));
  await page.waitForTimeout(800);
  await expect(page.locator("[data-lwe-panel]")).toHaveCount(1);
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25);
  // Twenty route flips must not leak panels or checkboxes.
  for (let i = 0; i < 20; i++) await page.evaluate((i) => history.pushState({}, "", `/sales/search/people?query=paged&page=${(i % 3) + 1}`), i);
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-lwe-panel]")).toHaveCount(1);
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25);
});

/* AT-21 */
test("delayed lazy rows are rendered by auto-scroll before an export page is parsed", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, ...FAST });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=delayed`);
  await page.fill("[data-lwe-export-limit]", "25");
  await page.locator('[data-lwe-action="export-all"]').click();
  const job = await waitForJob((j) => j.status === "done", 60_000);
  expect(job).toMatchObject({ pagesDone: 1, collected: 25, sent: 25 });
  await hook.waitFor(25, 20_000);
});

/* AT-22 */
test("a lead list without a Next control stops after one page and parses messy names", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, ...FAST });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/lists/people/7263`);
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(12);
  await page.locator('[data-lwe-action="export-all"]').click();
  const job = await waitForJob((j) => j.status === "done");
  expect(job).toMatchObject({ stopReason: "no_more_pages", pagesDone: 1, collected: 12, sent: 12 });
  const reqs = await hook.waitFor(12);
  const names = reqs.map((r) => r.json.lead.full_name);
  expect(names).toContain("Bob Okafor");
  expect(names).toContain("Владимир Петров");
  expect(names).toContain("O'Connor-Smith, Seán");
  const inj = reqs.find((r) => r.json.lead.full_name.includes("Injector"))!.json.lead;
  expect(inj.company_linkedin_url).toBeNull(); // hostile host dropped twice (parser + worker)
  expect(reqs.every((r) => r.json.import.list_id === "7263" && r.json.import.import_kind === "export")).toBe(true);
  expect(hook.searches[0].json.search.list_id).toBe("7263");
});

/* AT-23 */
test("2026-layout profile and people search send well-formed records with warnings", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500 });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/zoe-angstrom-%C3%A5/`);
  await page.locator('[data-lwe-action="send"]').click();
  const [zoe] = await hook.waitFor(1);
  expect(zoe.json.lead).toMatchObject({ full_name: "Zoë Ångström", title: "Chief Revenue Officer", company_name: "Ångström & Sons", location: "Stockholm, Stockholm County, Sweden", connection_degree: "2nd" });
  expect(zoe.json.lead.parse_warnings).toContain("sdui_layout");
  expect(zoe.json.lead.experience).toHaveLength(5);
  await page.goto(`${site.origin}/search/results/people/?keywords=chief%20revenue%20officer`);
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(9); // anonymous member excluded
  await page.locator('[data-lwe-action="select-all"]').click();
  await page.locator('[data-lwe-action="send"]').click();
  const reqs = await hook.waitFor(10);
  const cher = reqs.find((r) => r.json.lead.full_name === "Cher")!.json.lead;
  expect(cher).toMatchObject({ first_name: "Cher", last_name: null, location: "Mount Pleasant, South Carolina, United States", title: "Chief Revenue Officer (CRO)" });
  expect(reqs.find((r) => r.json.lead.full_name === "Hostile Host")!.json.lead.linkedin_url).toBeNull();
  expect(reqs.find((r) => r.json.lead.full_name === "李 小龙")!.json.lead.linkedin_url).toBe("https://www.linkedin.com/in/%E6%9D%8E%E5%B0%8F%E9%BE%99-abc");
});

/* AT-24 */
test("every action is logged automatically and secrets never appear in the log or in page-visible settings", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: "super-secret-value", authHeaderName: "Authorization", authHeaderValue: "Bearer token-value" });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await page.locator('[data-lwe-action="send"]').click();
  await hook.waitFor(1);
  await page.locator('[data-lwe-action="send"]').click(); // duplicate -> logged as skipped
  await expect(page.locator("[data-lwe-status]")).toHaveText(/already sent/);
  const entries = (await sendMessage(context, extensionId, { type: "GET_LOG", limit: 100 })) as Array<{ kind: string; msg: string }>;
  const kinds = entries.map((e) => e.kind);
  for (const k of ["settings.saved", "capture.requested", "capture.queued", "send.attempt", "send.ok", "capture.duplicate"]) expect(kinds).toContain(k);
  const text = JSON.stringify(entries);
  expect(text).not.toContain("super-secret-value");
  expect(text).not.toContain("token-value");
  // (What a content script may see is covered by tests/unit/worker.test.ts: GET_SETTINGS from a page is redacted.)
  // The popup shows the activity feed.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("#log li").first()).toContainText(/capture|send|settings/i);
});

/* AT-25 */
test("shadow-root panel: LinkedIn-style page CSS cannot restyle the controls", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url });
  const page = await context.newPage();
  await page.goto(`${site.origin}/in/jane-doe-123/`);
  await page.addStyleTag({ content: "button { display: none !important; background: red !important; }" });
  const btn = page.locator('[data-lwe-action="send"]');
  await expect(btn).toBeVisible();
  const bg = await btn.evaluate((b) => getComputedStyle(b).backgroundColor);
  expect(bg).not.toBe("rgb(255, 0, 0)");
  expect(await page.locator("[data-lwe-panel]").evaluate((h) => !!h.shadowRoot)).toBe(true);
});

/* AT-26 */
test("two simultaneous sends from two tabs never exceed the daily cap", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 30, dedupe: false });
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto(PAGED());
  await b.goto(`${site.origin}/sales/search/people?query=paged&page=2`);
  await expect(a.locator("[data-lwe-row-check]")).toHaveCount(25);
  await expect(b.locator("[data-lwe-row-check]")).toHaveCount(25);
  await a.locator('[data-lwe-action="select-all"]').click();
  await b.locator('[data-lwe-action="select-all"]').click();
  await Promise.all([a.locator('[data-lwe-action="send"]').click(), b.locator('[data-lwe-action="send"]').click()]);
  await a.waitForTimeout(1500);
  const st = await sendMessage(context, extensionId, { type: "GET_STATE" });
  expect(st.sentToday).toBeLessThanOrEqual(30);
  expect(st.sentToday).toBe(25); // one page fits (25), the other is rejected whole (all-or-nothing for manual sends)
  await hook.waitFor(25);
  await a.waitForTimeout(500);
  expect(hook.leads.length).toBe(25);
});

/* AT-27 */
test("rows appended after scrolling (Next enabled only then) are captured across all pages", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, ...FAST });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=appended`);
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(13); // first half only, before any scroll
  await page.fill("[data-lwe-export-limit]", "2500");
  await page.locator('[data-lwe-action="export-all"]').click();
  const job = await waitForJob((j) => j.status === "done", 90_000);
  expect(job).toMatchObject({ stopReason: "no_more_pages", pagesDone: 3, collected: PAGED_TOTAL, sent: PAGED_TOTAL });
  await hook.waitFor(PAGED_TOTAL, 30_000);
});

/* AT-28 */
test("two simultaneous export starts yield exactly one job", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, exportPageDelayMinMs: 3000, exportPageDelayMaxMs: 3000 });
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto(PAGED());
  await b.goto(`${site.origin}/sales/search/people?query=paged&page=2`);
  await expect(a.locator("[data-lwe-row-check]")).toHaveCount(25);
  await expect(b.locator("[data-lwe-row-check]")).toHaveCount(25);
  await Promise.all([a.locator('[data-lwe-action="export-all"]').click(), b.locator('[data-lwe-action="export-all"]').click()]);
  await a.waitForTimeout(1500);
  const st = await sendMessage(context, extensionId, { type: "EXPORT_STATUS" });
  expect(st.job).not.toBeNull();
  expect(st.history).toHaveLength(0);
  const statuses = await Promise.all([a.locator("[data-lwe-status]").textContent(), b.locator("[data-lwe-status]").textContent()]);
  expect(statuses.some((s) => /already running/.test(s ?? ""))).toBe(true);
  await sendMessage(context, extensionId, { type: "EXPORT_STOP" });
});

/* AT-29 */
test("a full last page inside a nested scroller stops on the disabled Next control, not the row count", async () => {
  await configure(context, extensionId, { webhookUrl: hook.url, signingSecret: SECRET, dailyCap: 2500, ...FAST });
  const page = await context.newPage();
  await page.goto(`${site.origin}/sales/search/people?query=fulllast`);
  await expect(page.locator("[data-lwe-row-check]")).toHaveCount(25);
  await page.fill("[data-lwe-export-limit]", "2500");
  await page.locator('[data-lwe-action="export-all"]').click();
  const job = await waitForJob((j) => j.status === "done", 60_000);
  expect(job).toMatchObject({ stopReason: "no_more_pages", pagesDone: 2, collected: 50, sent: 50 });
  await hook.waitFor(50, 30_000);
  expect(hook.leads.filter((r) => r.json.source.page_url.includes("page=3"))).toHaveLength(0);
});
