/**
 * Acceptance-test harness.
 *  - Serves the HTML fixtures on http://127.0.0.1:<port> under LinkedIn-shaped
 *    paths (/in/<slug>/, /sales/search/people, /search/results/people/).
 *  - Runs a mock webhook receiver that records every request and can be told
 *    to fail with a given status N times (to exercise retries).
 *  - Runs a mock Deepline API (GET /api/v2/plays, POST /api/v2/plays/run).
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
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  json: any;
  at: number;
}

function collect(req: IncomingMessage): Promise<{ raw: string; headers: Record<string, string> }> {
  return new Promise((r) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
      r({ raw, headers });
    });
  });
}

export class MockWebhook {
  server!: Server;
  url = "";
  received: ReceivedRequest[] = [];
  failNext: number[] = []; // queue of statuses to reply with before succeeding
  delayMs = 0;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const { raw, headers } = await collect(req);
      let json: any = null;
      try {
        json = JSON.parse(raw);
      } catch {}
      this.received.push({ method: req.method ?? "", path: req.url ?? "", headers, body: raw, json, at: Date.now() });
      const status = this.failNext.shift() ?? 200;
      setTimeout(() => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ ok: status < 300 })), this.delayMs);
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hook`;
  }
  /** Lead events only (search imports emit one search.captured event). */
  get leads(): ReceivedRequest[] {
    return this.received.filter((r) => r.json?.event !== "search.captured" && r.json?.event !== "test");
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

/** A stand-in for code.deepline.com: lists plays and accepts play runs. */
export class MockDeepline {
  server!: Server;
  baseUrl = "";
  apiKey = "dl_test_key";
  runs: ReceivedRequest[] = [];
  lists = 0;
  failNext: number[] = [];
  plays: Array<Record<string, unknown>> = [
    { playKey: "acme/linkedin-capture", name: "linkedin-capture", displayName: "LinkedIn capture", description: "Store people and enrich", origin: "owned", inputSchema: { type: "object", properties: { leads: { type: "array" }, source: { type: "string" } }, required: ["leads"] } },
    { playKey: "acme/warm-intro", name: "warm-intro", displayName: "Warm intro", description: "One person at a time", origin: "owned", inputSchema: { type: "object", properties: { linkedin_url: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, company_name: { type: "string" } }, required: ["linkedin_url"] } },
    { playKey: "acme/salesnav-search-import", name: "salesnav-search-import", displayName: "Sales Navigator search import", description: "Fetch every member of a search", origin: "owned", inputSchema: { type: "object", properties: { search_url: { type: "string" }, limit: { type: "integer" }, search_name: { type: "string" }, imported_by: { type: "string" } }, required: ["search_url"] } },
    { playKey: "prebuilt/person-linkedin-to-email", name: "person-linkedin-to-email", displayName: "Email from LinkedIn", origin: "prebuilt", inputSchema: { type: "object", properties: { linkedin_url: { type: "string" } }, required: ["linkedin_url"] } }
  ];

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const { raw, headers } = await collect(req);
      const url = new URL(req.url ?? "/", "http://x");
      if (headers.authorization !== `Bearer ${this.apiKey}`) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
      if (req.method === "GET" && url.pathname === "/api/v2/plays") {
        this.lists++;
        const origin = url.searchParams.get("origin");
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ plays: this.plays.filter((p) => !origin || p.origin === origin) }));
      }
      if (req.method === "POST" && url.pathname === "/api/v2/plays/run") {
        let json: any = null;
        try {
          json = JSON.parse(raw);
        } catch {}
        this.runs.push({ method: "POST", path: url.pathname, headers, body: raw, json, at: Date.now() });
        const status = this.failNext.shift() ?? 202;
        return res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status < 300 ? { workflowId: `wf_${this.runs.length}` } : { error: "nope" }));
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async waitForRuns(count: number, timeoutMs = 20_000): Promise<ReceivedRequest[]> {
    const start = Date.now();
    while (this.runs.length < count) {
      if (Date.now() - start > timeoutMs) throw new Error(`deepline received ${this.runs.length}/${count} runs within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.runs;
  }
  stop(): void {
    this.server.close();
  }
}

import { pagedSalesNav, delayedSalesNav, appendedSalesNav, fullLastPageSalesNav, sampleName, PAGED_TOTAL as GEN_TOTAL, PAGED_PAGES as GEN_PAGES } from "../fixtures/generators.mjs";
/** Name as the parser will emit it: trailing badges/emoji stripped. */
export const cleanSampleName = (n: number) => sampleName(n).replace(/\s+is reachable$/, "");
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
      if (/^\/sales\/search\/people/.test(path) && u.searchParams.get("query") === "fulllast") {
        return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fullLastPageSalesNav(Number(u.searchParams.get("page") ?? "1")));
      }
      if (/^\/sales\/search\/people/.test(path) && u.searchParams.get("query") === "appended") {
        return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(appendedSalesNav(Number(u.searchParams.get("page") ?? "1")));
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

/** A page inside the extension origin, for storage reads and messages. */
async function extPage(context: BrowserContext, extensionId: string, file = "sidepanel.html"): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  return page;
}

export interface WebhookOpts {
  url: string;
  name?: string;
  signingSecret?: string;
  signatureScheme?: "lwe" | "standard";
  authHeaderName?: string;
  authHeaderValue?: string;
  mappingPreset?: "generic" | "flat" | "deepline";
  sendMode?: "single" | "batch";
  id?: string;
}

/** Store settings directly (the same path the options page uses), so tests
 *  can set up destinations without driving the options UI every time. */
export async function setSettings(context: BrowserContext, extensionId: string, settings: Record<string, unknown>): Promise<void> {
  const page = await extPage(context, extensionId);
  await page.evaluate((s) => new Promise<void>((r) => chrome.storage.local.get("settings", (cur) => chrome.storage.local.set({ settings: { ...(cur.settings ?? {}), ...s } }, r))), settings);
  await page.close();
}

export function webhookDestination(o: WebhookOpts): Record<string, unknown> {
  return { id: o.id ?? "hook", kind: "webhook", name: o.name ?? "Hook", favorite: false, url: o.url, signingSecret: o.signingSecret ?? "", signatureScheme: o.signatureScheme ?? "lwe", authHeaderName: o.authHeaderName ?? "", authHeaderValue: o.authHeaderValue ?? "", mappingPreset: o.mappingPreset ?? "generic", sendMode: o.sendMode ?? "single" };
}

export function playDestination(dl: MockDeepline, play: Record<string, unknown>, id = "play"): Record<string, unknown> {
  const schema = play.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const fields = Object.keys(schema.properties ?? {});
  const mode = fields.includes("leads") ? "batch" : fields.includes("lead") ? "lead" : "mapped";
  const acceptsSearch = fields.some((f) => ["search_url", "sales_navigator_url", "url"].includes(f));
  const acceptsLeads = mode !== "mapped" || fields.some((f) => ["linkedin_url", "first_name", "full_name", "name"].includes(f));
  return { id, kind: "deepline_play", name: play.displayName, favorite: false, baseUrl: dl.baseUrl, apiKey: dl.apiKey, playKey: play.playKey, playName: play.displayName, input: { mode, fields, required: schema.required ?? [], acceptsSearch, acceptsLeads } };
}

/** Configure one webhook destination as the active one, plus general settings. */
export async function configure(context: BrowserContext, extensionId: string, o: WebhookOpts & Record<string, unknown>): Promise<void> {
  const { url, name, signingSecret, signatureScheme, authHeaderName, authHeaderValue, mappingPreset, sendMode, id, ...general } = o;
  const dest = webhookDestination({ url, name, signingSecret, signatureScheme, authHeaderName, authHeaderValue, mappingPreset, sendMode, id });
  await setSettings(context, extensionId, { destinations: [dest], activeDestinationId: dest.id, ...general });
}

/** Read the extension's storage directly (for assertions on queue/dedupe). */
export async function readStorage(context: BrowserContext, extensionId: string): Promise<Record<string, any>> {
  const page = await extPage(context, extensionId);
  const data = await page.evaluate(() => new Promise<Record<string, any>>((r) => chrome.storage.local.get(null, r)));
  await page.close();
  return data;
}

export async function sendMessage(context: BrowserContext, extensionId: string, msg: unknown): Promise<any> {
  const page = await extPage(context, extensionId);
  const res = await page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await page.close();
  return res;
}

/** Chrome's tab id for a page (needed to pin the side panel to it). */
export async function tabIdOf(context: BrowserContext, extensionId: string, page: Page): Promise<number> {
  const ext = await extPage(context, extensionId);
  const id = await ext.evaluate((u) => chrome.tabs.query({ url: u }).then((t) => t[0]?.id ?? -1), page.url());
  await ext.close();
  if (id < 0) throw new Error(`no tab for ${page.url()}`);
  return id;
}

/** Open the side panel page pinned to `page`'s tab. */
export async function openPanelFor(context: BrowserContext, extensionId: string, page: Page): Promise<Page> {
  const id = await tabIdOf(context, extensionId, page);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${id}`);
  return panel;
}

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}
export function hmacB64(key: Buffer | string, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64");
}
