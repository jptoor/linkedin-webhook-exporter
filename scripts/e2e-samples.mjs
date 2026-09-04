/**
 * Real-browser end-to-end run: installs the TEST build of the extension in
 * Chromium, points it at the reference receiver, drives EVERY sample page
 * (send / select-all / export / save search), then verifies what the receiver
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

// ---- configure through the real options page
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.fill("#webhookUrl", `${RECV}/hook`);
await opt.fill("#signingSecret", SECRET);
await opt.selectOption("#signatureScheme", "lwe");
await opt.fill("#capturedBy", "e2e@deepline");
await opt.fill("#customFields", "run=e2e-samples");
await opt.fill("#dailyCap", "2000");
await opt.fill("#exportPageDelayMinMs", "1000");
await opt.fill("#exportPageDelayMaxMs", "1200");
await opt.click("#save");
await opt.locator("#status").filter({ hasText: "Saved." }).waitFor();
await opt.click("#test");
await opt.locator("#status").filter({ hasText: /responded 200/ }).waitFor({ timeout: 10_000 });
await opt.screenshot({ path: `${SHOTS}/00-options.png`, fullPage: true });
row("options", "save + test event", "Saved; test event accepted 200");

const panel = (p) => p.locator("[data-lwe-panel]");
const status = (p) => p.locator("[data-lwe-status]");
async function state() {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html`);
  const st = await p.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  const log = await p.evaluate(() => chrome.runtime.sendMessage({ type: "GET_LOG", limit: 1000 }));
  const job = await p.evaluate(() => chrome.runtime.sendMessage({ type: "EXPORT_STATUS" }));
  await p.close();
  return { st, log, job };
}
async function waitJobDone(timeout = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const { job } = await state();
    const j = job.job ?? job.history[0];
    if (j && j.status !== "running" && j.status !== "paused") return j;
    if (Date.now() - t0 > timeout) throw new Error("export did not finish: " + JSON.stringify(j));
    await sleep(500);
  }
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

// ---- 1. profile, classic layout
let p = await ctx.newPage();
await p.goto(`${SITE}/in/jane-doe-123/`);
await panel(p).waitFor();
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /Queued 1/ }).waitFor();
await p.screenshot({ path: `${SHOTS}/01-profile-classic.png` });
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /already sent/ }).waitFor();
row("/in/jane-doe-123/ (classic profile)", "Send, then send again", "Queued 1; second click reported already sent");
await p.close();

// ---- 2. profile, 2026 layout
p = await ctx.newPage();
await p.goto(`${SITE}/in/zoe-angstrom-%C3%A5/`);
await panel(p).waitFor();
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /Queued 1/ }).waitFor();
const zoeStatus = await status(p).textContent();
await p.screenshot({ path: `${SHOTS}/02-profile-sdui.png` });
row("/in/zoe-angstrom-å/ (2026 layout)", "Send", zoeStatus);
await p.close();

// ---- 3. people search (2026 layout)
p = await ctx.newPage();
await p.goto(`${SITE}/search/results/people/?keywords=chief%20revenue%20officer`);
await p.locator("[data-lwe-row-check]").nth(8).waitFor();
const ppl = await p.locator("[data-lwe-row-check]").count();
await p.locator('[data-lwe-action="select-all"]').click();
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /Queued/ }).waitFor();
const pplStatus = await status(p).textContent();
await p.locator('[data-lwe-action="save-search"]').click();
await status(p).filter({ hasText: /Search saved/ }).waitFor();
await p.screenshot({ path: `${SHOTS}/03-people-search.png` });
row("/search/results/people/?keywords=chief revenue officer (2026 layout)", `Select all (${ppl} rows), send, save search`, `${pplStatus}; search saved`);
await p.close();

// ---- 4. Sales Navigator paged search: export all 60 (3 pages)
p = await ctx.newPage();
await p.goto(`${SITE}/sales/search/people?query=paged`);
await p.locator("[data-lwe-row-check]").nth(24).waitFor();
await p.fill("[data-lwe-export-limit]", "60");
await p.locator('[data-lwe-action="export-all"]').click();
await p.locator("[data-lwe-export-status]").filter({ hasText: /Exporting/ }).waitFor();
await p.screenshot({ path: `${SHOTS}/04-salesnav-export-running.png` });
let job = await waitJobDone();
await p.screenshot({ path: `${SHOTS}/05-salesnav-export-done.png` });
row("/sales/search/people?query=paged (3 pages × 25)", "Export all, limit 60", `${job.status} (${job.stopReason}); pages ${job.pagesDone}, collected ${job.collected}, sent ${job.sent}, skipped ${job.skipped}`);
await p.close();

// ---- 5. delayed lazy rows
p = await ctx.newPage();
await p.goto(`${SITE}/sales/search/people?query=delayed`);
await panel(p).waitFor();
await p.fill("[data-lwe-export-limit]", "25");
await p.locator('[data-lwe-action="export-all"]').click();
job = await waitJobDone();
await p.screenshot({ path: `${SHOTS}/06-salesnav-delayed.png` });
row("/sales/search/people?query=delayed (rows render 250 ms after scroll)", "Export all, limit 25", `${job.status} (${job.stopReason}); collected ${job.collected}, sent ${job.sent}, skipped ${job.skipped} (already sent from the paged export)`);
await p.close();

// ---- 6. lead list (no Next button, messy names)
p = await ctx.newPage();
await p.goto(`${SITE}/sales/lists/people/7263`);
await p.locator("[data-lwe-row-check]").nth(11).waitFor();
await p.locator('[data-lwe-action="export-all"]').click();
job = await waitJobDone();
await p.screenshot({ path: `${SHOTS}/07-salesnav-list.png` });
row("/sales/lists/people/7263 (lead list, 12 messy rows, no Next)", "Export all", `${job.status} (${job.stopReason}); collected ${job.collected}, sent ${job.sent}`);
await p.close();

// ---- 7. lead page (grouped experience)
p = await ctx.newPage();
await p.goto(`${SITE}/sales/lead/ACwAAABbedIBfirQHhl0OlHRmfe81tzow0Jjgwg,NAME_SEARCH,vDF-`);
await panel(p).waitFor();
await p.locator('[data-lwe-action="send"]').click();
await status(p).filter({ hasText: /Queued 1/ }).waitFor();
await p.screenshot({ path: `${SHOTS}/08-salesnav-lead.png` });
row("/sales/lead/… (lead page)", "Send", await status(p).textContent());
await p.close();

// ---- 8. popup
const st = await drain(1);
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${extId}/popup.html`);
await sleep(800);
await pop.screenshot({ path: `${SHOTS}/09-popup.png`, fullPage: true });
await opt.goto(`chrome-extension://${extId}/options.html#log`);
await sleep(800);
await opt.screenshot({ path: `${SHOTS}/10-options-log.png`, fullPage: true });

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
  ["paged export: 60 distinct Sales Nav URLs", leads.filter((l) => l.sales_navigator_url && /ACwAAA\d{4}abcdef$/.test(l.sales_navigator_url)).length === 60],
  ["lead list: Cyrillic, Turkish, 'Last, First', injection text stored as text", !!byName["Владимир Петров"] && !!byName["Ayşe Öztürk"] && !!byName["O'Connor-Smith, Seán"] && !!byName["<script>alert(1)</script> Injector"]],
  ["lead list: hostile company host dropped", byName["<script>alert(1)</script> Injector"]?.company_linkedin_url == null],
  ["lead page: grouped experience (6 entries) and top-card location", JSON.parse(byName["David Lusk"]?.experience_json ?? "[]").length === 6 && byName["David Lusk"]?.location === "Atlanta Metropolitan Area"],
  ["searches: people search + paged + delayed + list saved", searches.length >= 4 && searches.some((s) => s.list_id === "7263")],
  ["imports: manual and export kinds recorded with search names", imports.some((i) => i.import_kind === "manual") && imports.some((i) => i.import_kind === "export" && i.search_name)],
  ["every request signed and accepted (no failed queue items)", st.queue.every((q) => q.status === "sent")],
  ["activity log covers captures, sends, exports, settings, search saves", ["capture.queued", "send.ok", "export.started", "export.page", "export.finished", "settings.saved", "search.saved", "webhook.test", "capture.duplicate"].every((k) => kinds[k] > 0)],
  ["no secrets in the activity log", leaks.length === 0]
];

const md = [`# End-to-end run on sample pages`, ``, `Date: ${new Date().toISOString()}  `, `Extension: test build loaded unpacked in Chromium ${ctx.browser()?.version() ?? ""}  `, `Receiver: signed (LWE), admin-token reads, SQLite  `, ``, `## Actions`, ``, `| Page | Action | Result |`, `|---|---|---|`, ...report.map((r) => `| ${r.page} | ${r.action} | ${r.result} |`), ``, `## Receiver contents`, ``, `- leads: ${leads.length}`, `- searches: ${searches.length}`, `- imports: ${imports.length} (${imports.map((i) => `${i.import_kind}:${i.leads}`).join(", ")})`, `- queue items: ${st.queue.length}, all sent: ${st.queue.every((q) => q.status === "sent")}`, ``, `## Checks`, ``, `| Check | Result |`, `|---|---|`, ...checks.map(([c, ok]) => `| ${c} | ${ok ? "PASS" : "FAIL"} |`), ``, `## Activity log kinds`, ``, "```", JSON.stringify(kinds, null, 2), "```", ``, `Screenshots: e2e-screenshots/`].join("\n");
writeFileSync(resolve(ROOT, "docs/E2E-REPORT.md"), md);
console.log(md);
await ctx.close();
receiver.proc.kill();
samples.proc.kill();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
