/**
 * Acceptance-test harness.
 *  - Serves the HTML fixtures on http://127.0.0.1:<port> under LinkedIn-shaped
 *    paths (/in/<slug>/, /sales/search/people, /search/results/people/).
 *  - Runs a mock webhook receiver that records every request and can be told
 *    to fail with a given status N times (to exercise retries).
 *  - Launches Chromium with the TEST build of the extension loaded.
 */
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
import type { AddressInfo } from "node:net";

const FIXTURES = resolve(__dirname, "../fixtures");
const EXT = resolve(__dirname, "../../dist-test");

export interface ReceivedRequest {
  headers: Record<string, string>;
  body: string;
  json: any;
  at: number;
}

export class MockWebhook {
  server!: Server;
  url = "";
  received: ReceivedRequest[] = [];
  failNext: number[] = []; // queue of statuses to reply with before succeeding
  delayMs = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
        let json: any = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        this.received.push({ headers, body: raw, json, at: Date.now() });
        const status = this.failNext.shift() ?? 200;
        setTimeout(() => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ ok: status < 300 })), this.delayMs);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hook`;
  }
  /** Lead events only (bulk export also emits one search.captured event). */
  get leads(): ReceivedRequest[] {
    return this.received.filter((r) => r.json?.event !== "search.captured");
  }
  get searches(): ReceivedRequest[] {
    return this.received.filter((r) => r.json?.event === "search.captured");
  }
  /** Wait until `count` lead events have arrived. */
  async waitFor(count: number, timeoutMs = 20_000): Promise<ReceivedRequest[]> {
    const start = Date.now();
    while (this.leads.length < count) {
      if (Date.now() - start > timeoutMs) throw new Error(`webhook received ${this.leads.length}/${count} lead events within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.leads;
  }
  stop(): void {
    this.server.close();
  }
}

import { pagedSalesNav, delayedSalesNav, sampleName, PAGED_TOTAL as GEN_TOTAL, PAGED_PAGES as GEN_PAGES } from "../fixtures/generators.mjs";
/** Name as the parser will emit it: trailing badges/emoji stripped. */
export const cleanSampleName = (n: number) => sampleName(n).replace(/\s+is reachable$/, "").replace(/\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]+(?=\s|$)/gu, "").replace(/\s+/g, " ").trim();
export const PAGED_TOTAL = GEN_TOTAL;
export const PAGED_PAGES = GEN_PAGES;
const SAMPLES = resolve(__dirname, "../../samples");

export class FixtureSite {
  server!: Server;
  origin = "";
  async start(): Promise<void> {
    const routes: Array<[RegExp, string]> = [
      [/^\/in\/[^/]+\/?$/, "profile.html"],
      [/^\/sales\/search\/people/, "salesnav-search.html"],
      [/^\/sales\/lists\/people\//, "salesnav-search.html"],
      [/^\/search\/results\/people/, "people-search.html"]
    ];
    this.server = createServer((req: IncomingMessage, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const path = u.pathname;
      // Paginated Sales Navigator search: ?query=paged&page=N -> 25, 25, 10 rows.
      if (/^\/sales\/search\/people/.test(path) && u.searchParams.get("query") === "paged") {
        return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(pagedSalesNav(Number(u.searchParams.get("page") ?? "1")));
      }
      if (/^\/sales\/search\/people/.test(path) && u.searchParams.get("query") === "delayed") {
        return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(delayedSalesNav(Number(u.searchParams.get("page") ?? "1")));
      }
      // Sample pages (2026 layouts, messy data) on LinkedIn-shaped paths.
      const sample = [
        [/^\/in\/zoe-angstrom/, "profile-sdui.html"],
        [/^\/search\/results\/people\/?$/, u.searchParams.get("keywords") === "chief revenue officer" ? "people-search-sdui.html" : null],
        [/^\/sales\/lists\/people\/7263/, "salesnav-list.html"],
        [/^\/sales\/lead\//, "salesnav-lead.html"]
      ].find(([re, f]) => f && (re as RegExp).test(path));
      if (sample) return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(resolve(SAMPLES, sample[1] as string)));
      const hit = routes.find(([re]) => re.test(path));
      if (!hit) return res.writeHead(404).end("no fixture");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(resolve(FIXTURES, hit[1])));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): void {
    this.server.close();
  }
}

export async function launchWithExtension(): Promise<{ context: BrowserContext; extensionId: string }> {
  const userDataDir = mkdtempSync(resolve(tmpdir(), "lwe-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extensionId = new URL(sw.url()).host;
  return { context, extensionId };
}

/** Configure the extension through its real options page. */
export async function configure(context: BrowserContext, extensionId: string, settings: Record<string, string | boolean | number>): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  for (const [id, value] of Object.entries(settings)) {
    const el = page.locator(`#${id}`);
    const tag = await el.evaluate((e) => (e as HTMLElement).tagName.toLowerCase());
    const type = await el.evaluate((e) => (e as HTMLInputElement).type);
    if (type === "checkbox") await el.setChecked(Boolean(value));
    else if (tag === "select") await el.selectOption(String(value));
    else await el.fill(String(value));
  }
  await page.click("#save");
  await page.locator("#status").filter({ hasText: /Saved|not granted|must use/ }).waitFor();
  return page;
}

/** Read the extension's storage directly (for assertions on queue/dedupe). */
export async function readStorage(context: BrowserContext, extensionId: string): Promise<Record<string, any>> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const data = await page.evaluate(() => new Promise<Record<string, any>>((r) => chrome.storage.local.get(null, r)));
  await page.close();
  return data;
}

export async function sendMessage(context: BrowserContext, extensionId: string, msg: unknown): Promise<any> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const res = await page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await page.close();
  return res;
}

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}
export function hmacB64(key: Buffer | string, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64");
}
