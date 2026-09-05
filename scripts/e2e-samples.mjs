/**
 * Real-browser end-to-end run: installs the TEST build of the extension in
 * Chromium, points it at the reference receiver, drives EVERY sample page
 * (push / select page / pick across pages / import search), then verifies what the receiver
 * stored and what the extension logged. Writes docs/E2E-REPORT.md and
 * screenshots to e2e-screenshots/.
 *
 *   npm run build:test && node scripts/e2e-samples.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(".");
const EXT = resolve(ROOT, "dist-test");
const SECRET = "e2e-secret";
const ADMIN = "e2e-admin";
const SHOTS = resolve(ROOT, "e2e-screenshots");
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function start(cmd, args, env, ready) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      const m = out.match(ready);
      if (m) res({ proc: p, match: m });
    });
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (c) => rej(new Error(`${cmd} exited ${c}: ${out}`)));
  });
}

const dbPath = resolve(mkdtempSync(resolve(tmpdir(), "lwe-e2e-")), "e2e.sqlite");
const receiver = await start(process.execPath, ["receiver/server.mjs"], { PORT: "0", LWE_SECRET: SECRET, LWE_ADMIN_TOKEN: ADMIN, LWE_DB: dbPath, LWE_QUIET: "0" }, /http:\/\/127\.0\.0\.1:(\d+)/);
const RECV = `http://127.0.0.1:${receiver.match[1]}`;
const samples = await start(process.execPath, ["scripts/samples.mjs"], { PORT: "0" }, /http:\/\/127\.0\.0\.1:(\d+)/);
const SITE = `http://127.0.0.1:${samples.match[1]}`;
const admin = { authorization: `Bearer ${ADMIN}` };

const ctx = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), "lwe-e2e-profile-")), {
  channel: "chromium",
  headless: process.env.HEADED !== "1",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 900 }
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
const report = [];
const row = (page, action, result) => report.push({ page, action, result });

// ---- connect a webhook through the real settings page
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.click("#addWebhook");
await opt.fill("#url", `${RECV}/hook`);
await opt.locator("#webhookFields details summary").click();
await opt.fill("#signingSecret", SECRET);
await opt.selectOption("#signatureScheme", "lwe");
await opt.fill("#destName", "SQLite receiver");
await opt.click("#testDest");
await opt.locator("#destStatus").filter({ hasText: /answered 200/ }).waitFor({ timeout: 10_000 });
await opt.click("#saveDest");
await opt.locator("#status").filter({ hasText: /Saved/ }).waitFor();
await opt.fill("#capturedBy", "e2e@deepline");
await opt.fill("#dailyCap", "2000");
await opt.locator("main > details summary").click();
await opt.fill("#customFields", "run=e2e-samples");
await opt.click("#save");
await opt.locator("#status").filter({ hasText: "Saved." }).waitFor();
await opt.screenshot({ path: `${SHOTS}/00-settings.png`, fullPage: true });
row("settings", "connect webhook + test connection + save", "Connected; test event accepted 200");

const dock = (p) => p.locator("[data-lwe-panel]");
const status = (p) => p.locator("[data-lwe-status]");
const pills = (p) => p.locator("[data-lwe-row-check]");
async function state() {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/sidepanel.html`);
  const st = await p.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  const log = await p.evaluate(() => chrome.runtime.sendMessage({ type: "GET_LOG", limit: 1000 }));
  await p.close();
  return { st, log };
}
async function tabIdOf(page) {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/sidepanel.html`);
  const id = await p.evaluate((u) => chrome.tabs.query({ url: u }).then((t) => t[0]?.id ?? -1), page.url());
  await p.close();
  return id;
}
async function drain(expectedMin, timeout = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const { st } = await state();
    const pending = st.queue.filter((q) => q.status === "pending" || q.status === "sending").length;
    if (pending === 0 && st.queue.length >= expectedMin) return st;
    if (Date.now() - t0 > timeout) throw new Error("queue did not drain");
    await sleep(300);
  }
}

// ---- 1. profile, classic layout: dock push, push again is a no-op
let p = await ctx.newPage();
await p.goto(`${SITE}/in/jane-doe-123/`);
await dock(p).waitFor();
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /1 on the way/ }).waitFor();
await p.screenshot({ path: `${SHOTS}/01-profile-classic.png` });
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /pushed before/ }).waitFor();
row("/in/jane-doe-123/ (classic profile)", "Push, then push again", "1 on the way; second click reported pushed before");
await p.close();

// ---- 2. profile, 2026 layout: push from the side panel
p = await ctx.newPage();
await p.goto(`${SITE}/in/zoe-angstrom-%C3%A5/`);
await dock(p).waitFor();
let panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${await tabIdOf(p)}`);
await panel.locator("#cta").filter({ hasText: /Push Zo/ }).waitFor();
await panel.setViewportSize({ width: 380, height: 760 });
await panel.screenshot({ path: `${SHOTS}/02-sidepanel-profile.png` });
await panel.click("#cta");
await panel.locator("#ctaStatus").filter({ hasText: /On the way/ }).waitFor();
await panel.close();
const zoeStatus = await status(p).textContent();
await p.screenshot({ path: `${SHOTS}/03-profile-sdui.png` });
row("/in/zoe-angstrom-å/ (2026 layout)", "Push from the side panel", zoeStatus);
await p.close();

// ---- 3. people search (2026 layout): select page, push
p = await ctx.newPage();
await p.goto(`${SITE}/search/results/people/?keywords=chief%20revenue%20officer`);
await pills(p).nth(8).waitFor();
const ppl = await pills(p).count();
await p.locator('[data-lwe-action="select-all"]').click();
await p.locator('[data-lwe-action="send"]').filter({ hasText: /Push \d+/ }).waitFor();
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /on the way/ }).waitFor();
const pplStatus = await status(p).textContent();
await p.screenshot({ path: `${SHOTS}/04-people-search.png` });
row("/search/results/people/?keywords=chief revenue officer (2026 layout)", `Select page (${ppl} rows), push`, pplStatus);
await p.close();

// ---- 4. Sales Navigator paged search: pick across 3 pages, push once, then import the whole search
p = await ctx.newPage();
await p.goto(`${SITE}/sales/search/people?query=paged&page=1`);
await pills(p).nth(24).waitFor();
for (const i of [0, 1, 2]) await pills(p).nth(i).click();
await p.goto(`${SITE}/sales/search/people?query=paged&page=2`);
await pills(p).nth(24).waitFor();
for (const i of [0, 1]) await pills(p).nth(i).click();
await p.goto(`${SITE}/sales/search/people?query=paged&page=3`);
await pills(p).nth(9).waitFor();
await pills(p).nth(0).click();
await p.locator('[data-lwe-action="send"]').filter({ hasText: "Push 6" }).waitFor();
panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${await tabIdOf(p)}`);
await panel.locator("#people .person").nth(5).waitFor();
await panel.setViewportSize({ width: 380, height: 900 });
await panel.screenshot({ path: `${SHOTS}/05-sidepanel-selected.png` });
await panel.click("#cta");
await panel.locator("#ctaStatus").filter({ hasText: /6 people on the way/ }).waitFor();
const pagedStatus = await panel.locator("#ctaStatus").textContent();
await panel.fill("#searchLimit", "60");
await panel.click("#sendSearch");
await panel.locator("#searchNote").filter({ hasText: /Importing up to 60/ }).waitFor();
await panel.screenshot({ path: `${SHOTS}/06-sidepanel-import-search.png` });
await panel.close();
await p.screenshot({ path: `${SHOTS}/07-salesnav-after-push.png` });
row("/sales/search/people?query=paged (3 pages × 25)", "Pick 3 + 2 + 1 across pages, push once; Import search (60)", `${pagedStatus}; search forwarded`);
await p.close();

// ---- 5. delayed lazy rows: rows appear after a scroll; select page
p = await ctx.newPage();
await p.goto(`${SITE}/sales/search/people?query=delayed`);
await dock(p).waitFor();
await p.mouse.wheel(0, 4000);
await sleep(1500);
await p.mouse.wheel(0, 4000);
await sleep(1500);
const delayedRows = await pills(p).count();
await p.locator('[data-lwe-action="select-all"]').click();
await p.locator('[data-lwe-action="send"]').filter({ hasText: /Push \d+/ }).waitFor();
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /on the way|pushed before/ }).waitFor();
await p.screenshot({ path: `${SHOTS}/08-salesnav-delayed.png` });
row("/sales/search/people?query=delayed (rows render 250 ms after scroll)", `Scroll, select page (${delayedRows} rows), push`, await status(p).textContent());
await p.close();

// ---- 6. lead list (messy names)
p = await ctx.newPage();
await p.goto(`${SITE}/sales/lists/people/7263`);
await pills(p).nth(11).waitFor();
await p.locator('[data-lwe-action="select-all"]').click();
await p.locator('[data-lwe-action="send"]').filter({ hasText: "Push 12" }).waitFor();
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /on the way/ }).waitFor();
await p.screenshot({ path: `${SHOTS}/09-salesnav-list.png` });
row("/sales/lists/people/7263 (lead list, 12 messy rows)", "Select page, push", await status(p).textContent());
await p.close();

// ---- 7. lead page (grouped experience)
p = await ctx.newPage();
await p.goto(`${SITE}/sales/lead/ACwAAABbedIBfirQHhl0OlHRmfe81tzow0Jjgwg,NAME_SEARCH,vDF-`);
await dock(p).waitFor();
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /1 on the way/ }).waitFor();
await p.screenshot({ path: `${SHOTS}/10-salesnav-lead.png` });
row("/sales/lead/… (lead page)", "Push", await status(p).textContent());
await p.close();

// ---- 8. side panel recent + settings history
const st = await drain(1);
panel = await ctx.newPage();
await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
await panel.setViewportSize({ width: 380, height: 760 });
await sleep(800);
await panel.screenshot({ path: `${SHOTS}/11-sidepanel-recent.png` });
await opt.goto(`chrome-extension://${extId}/options.html#log`);
await sleep(800);
await opt.screenshot({ path: `${SHOTS}/12-settings-history.png`, fullPage: true });

// ---- verify receiver
const get = async (path) => (await fetch(`${RECV}${path}?limit=500`, { headers: admin })).json();
const leads = await get("/leads");
const searches = await get("/searches");
const imports = await get("/imports");
const { log } = await state();
const kinds = log.reduce((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
const logText = JSON.stringify(log);
const leaks = [SECRET, ADMIN].filter((s) => logText.includes(s));
const byName = Object.fromEntries(leads.map((l) => [l.full_name, l]));
const checks = [
  ["classic profile stored with experience", !!byName["Jane Doe"] && JSON.parse(byName["Jane Doe"].experience_json ?? "[]").length === 2],
  ["2026 profile name cleaned, company + location parsed", byName["Zoë Ångström"]?.company_name === "Ångström & Sons" && byName["Zoë Ångström"]?.location === "Stockholm, Stockholm County, Sweden"],
  ["2026 profile carries parse warnings", (byName["Zoë Ångström"]?.parse_warnings ?? "").includes("sdui_layout")],
  ["people search: mononym Cher, unicode 李 小龙, Mary Ann van der Berg", !!byName["Cher"] && !!byName["李 小龙"] && byName["Mary Ann van der Berg"]?.first_name === "Mary Ann"],
  ["people search: hostile host dropped, nested path dropped", byName["Hostile Host"]?.linkedin_url == null && byName["Nested Path"]?.linkedin_url == null],
  ["people search: anonymous 'LinkedIn Member' not stored", !byName["LinkedIn Member"]],
  ["cross-page picks: 6 people from 3 pages under one basket import", (() => { const b = imports.filter((i) => i.import_kind === "basket" && i.search_name === "paged"); return b.reduce((n, i) => n + (i.leads ?? 0), 0) === 6 && new Set(b.map((i) => i.import_id)).size === 1; })()],
  ["lead list: Cyrillic, Turkish, 'Last, First', injection text stored as text", !!byName["Владимир Петров"] && !!byName["Ayşe Öztürk"] && !!byName["O'Connor-Smith, Seán"] && !!byName["<script>alert(1)</script> Injector"]],
  ["lead list: hostile company host dropped", byName["<script>alert(1)</script> Injector"]?.company_linkedin_url == null],
  ["lead page: grouped experience (6 entries) and top-card location", JSON.parse(byName["David Lusk"]?.experience_json ?? "[]").length === 6 && byName["David Lusk"]?.location === "Atlanta Metropolitan Area"],
  ["search import forwarded once with limit 60", searches.length === 1 && searches[0].search_url.includes("query=paged")],
  ["imports: manual and basket kinds recorded with search names", imports.some((i) => i.import_kind === "manual") && imports.some((i) => i.import_kind === "basket" && i.search_name)],
  ["every request signed and accepted (no failed queue items)", st.queue.every((q) => q.status === "sent")],
  ["activity log covers captures, basket, sends, settings, destination test, search import", ["capture.queued", "basket.added", "basket.sent", "send.ok", "settings.saved", "search.saved", "destination.test", "capture.duplicate"].every((k) => kinds[k] > 0)],
  ["no secrets in the activity log", leaks.length === 0]
];

const md = [`# End-to-end run on sample pages`, ``, `Date: ${new Date().toISOString()}  `, `Extension: test build loaded unpacked in Chromium ${ctx.browser()?.version() ?? ""}  `, `Receiver: signed (LWE) webhook destination, admin-token reads, SQLite  `, ``, `## Actions`, ``, `| Page | Action | Result |`, `|---|---|---|`, ...report.map((r) => `| ${r.page} | ${r.action} | ${r.result} |`), ``, `## Receiver contents`, ``, `- leads: ${leads.length}`, `- searches: ${searches.length}`, `- imports: ${imports.length} (${imports.map((i) => `${i.import_kind}:${i.leads}`).join(", ")})`, `- queue items: ${st.queue.length}, all sent: ${st.queue.every((q) => q.status === "sent")}`, ``, `## Checks`, ``, `| Check | Result |`, `|---|---|`, ...checks.map(([c, ok]) => `| ${c} | ${ok ? "PASS" : "FAIL"} |`), ``, `## Activity log kinds`, ``, "```", JSON.stringify(kinds, null, 2), "```", ``, `Screenshots: e2e-screenshots/`].join("\n");
writeFileSync(resolve(ROOT, "docs/E2E-REPORT.md"), md);
console.log(md);
await ctx.close();
receiver.proc.kill();
samples.proc.kill();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
