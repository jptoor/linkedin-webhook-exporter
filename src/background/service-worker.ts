declare const __EXTENSION_VERSION__: string;
declare const __TEST_BUILD__: boolean;

import { addToBasket, basketItems, basketPages, groupByPage, removeFromBasket, type Basket } from "../shared/basket";
import { buildLeadRuns, buildSearchRun, listPlays, testApiKey, unfillableRequired } from "../shared/deepline";
import { buildBodies, buildSearchBody } from "../shared/mapping";
import type { BasketResponse, CaptureResponse, ContentToBackground, ListPlaysResponse, PageContext, SearchCaptureResponse, StateResponse } from "../shared/messages";
import { dedupeKey } from "../shared/normalize";
import { buildSearchRecord, savedSearchIdFrom, searchKey, searchName } from "../shared/search";
import { activeDestination, describeDestination, getSettings, redactDestination, sanitizeDestination, saveSettings, toContentSettings, validateWebhookUrl } from "../shared/settings";
import type { Destination, ImportInfo, LeadRecord, PageType, QueueItem, Settings, SourceInfo } from "../shared/types";
import { isAllowedPageUrl, isPageType, validateLead, validateLeads } from "../shared/validate";
import { withLock } from "./lock";
import { clearLog, logEvent, readLog } from "../shared/log";
import { afterAttempt, claim, clearQueue, due, newItem, nextWake, prune, recoverStaleLeases } from "./queue";
import { playRunBody, sendBody } from "./sender";

const VERSION = typeof __EXTENSION_VERSION__ === "string" ? __EXTENSION_VERSION__ : "dev";
const TEST_BUILD = typeof __TEST_BUILD__ === "boolean" ? __TEST_BUILD__ : false;
const ALARM = "lwe-flush";
const KEYS = { queue: "queue", dedupe: "dedupe", daily: "daily" } as const;
const SESSION_KEYS = { basket: "basket", shareLinks: "shareLinks" } as const;

/* ------------------------------------------------------------ storage */

/** Dedupe entries: reserved when queued, confirmed on a 2xx, removed on a
 *  permanent failure so a lead that never reached the receiver can be resent. */
interface DedupeEntry {
  t: number;
  confirmed: boolean;
  item: string | null;
}
type DedupeMap = Record<string, DedupeEntry>;
/** Daily counters. `queued` is what the cap limits (admissions into the queue
 *  = LinkedIn captures); delivered/failed are informational. */
interface Daily {
  day: string;
  queued: number;
  delivered: number;
  failed: number;
}

/** Local calendar day (the operator's timezone), YYYY-MM-DD. */
export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** chrome.storage.session holds the basket and captured share links: they
 *  should not outlive the browser session. Older Chromes without it fall
 *  back to local storage under the same keys. */
const session = (): chrome.storage.StorageArea => (chrome.storage.session ?? chrome.storage.local) as chrome.storage.StorageArea;

async function loadQueue(): Promise<QueueItem[]> {
  const q = (await chrome.storage.local.get(KEYS.queue))[KEYS.queue];
  return Array.isArray(q) ? (q as QueueItem[]).filter((i) => i && typeof i.destinationId === "string").map((i) => Object.assign({ sendingAt: null, dedupeKey: i.id, runId: null, label: "" }, i)) : [];
}
async function saveQueue(items: QueueItem[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.queue]: items });
  await scheduleAlarm(items);
}
async function loadDedupe(): Promise<DedupeMap> {
  const raw = ((await chrome.storage.local.get(KEYS.dedupe))[KEYS.dedupe] ?? {}) as Record<string, unknown>;
  const out: DedupeMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number") out[k] = { t: v, confirmed: true, item: null }; // legacy shape
    else if (v && typeof v === "object" && typeof (v as DedupeEntry).t === "number") out[k] = v as DedupeEntry;
  }
  return out;
}
async function saveDedupe(map: DedupeMap): Promise<void> {
  await chrome.storage.local.set({ [KEYS.dedupe]: map });
}
async function loadDaily(): Promise<Daily> {
  const d = (await chrome.storage.local.get(KEYS.daily))[KEYS.daily] as Partial<Daily> | undefined;
  const day = localDay();
  if (d && d.day === day) return { day, queued: d.queued ?? 0, delivered: d.delivered ?? 0, failed: d.failed ?? 0 };
  return { day, queued: 0, delivered: 0, failed: 0 };
}
async function saveDaily(d: Daily): Promise<void> {
  await chrome.storage.local.set({ [KEYS.daily]: d });
}
async function loadBasket(): Promise<Basket> {
  const b = (await session().get(SESSION_KEYS.basket))[SESSION_KEYS.basket];
  return b && typeof b === "object" ? (b as Basket) : {};
}
async function saveBasket(b: Basket): Promise<void> {
  await session().set({ [SESSION_KEYS.basket]: b });
}
/** Share links captured from Sales Navigator's "Share search", keyed by the
 *  saved search id they were captured for. */
async function loadShareLinks(): Promise<Record<string, string>> {
  const s = (await session().get(SESSION_KEYS.shareLinks))[SESSION_KEYS.shareLinks];
  return s && typeof s === "object" ? (s as Record<string, string>) : {};
}

async function scheduleAlarm(items: QueueItem[]): Promise<void> {
  const when = nextWake(items);
  await chrome.alarms.clear(ALARM);
  if (when != null) await chrome.alarms.create(ALARM, { when: Math.max(when, Date.now() + 1000) });
}

function activeDedupe(map: DedupeMap, ttlDays: number, now: number): DedupeMap {
  const ttl = ttlDays * 86_400_000;
  const out: DedupeMap = {};
  for (const [k, e] of Object.entries(map)) if (now - e.t < ttl) out[k] = e;
  return out;
}

/** Notify extension pages (side panel) that something they render changed.
 *  Nobody may be listening; that is not an error. */
function broadcast(msg: unknown): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    /* no listeners */
  }
}

function resolveDestination(settings: Settings, destinationId?: string): Destination | null {
  if (destinationId) return settings.destinations.find((d) => d.id === destinationId) ?? null;
  return activeDestination(settings);
}

function destinationProblem(dest: Destination | null): CaptureResponse["rejectedReason"] {
  if (!dest) return "no_destination";
  if (dest.kind === "webhook" && !validateWebhookUrl(dest.url).ok) return "invalid_url";
  if (dest.kind === "deepline_play" && !dest.apiKey) return "invalid_url";
  return null;
}

/* ------------------------------------------------------------ capture */

type CaptureMsg = Extract<ContentToBackground, { type: "CAPTURE" }>;

interface Enqueued {
  queued: number;
  eventIds: string[];
}

/** Turn validated leads into queue items for a destination. Caller holds the lock. */
function enqueueLeads(dest: Destination, settings: Settings, leads: LeadRecord[], source: SourceInfo, imp: ImportInfo, force: boolean, now: number, queue: QueueItem[], dedupe: DedupeMap): Enqueued {
  const eventIds: string[] = [];
  const sentAt = new Date(now).toISOString();
  const push = (eventId: string, body: string, group: LeadRecord[], label: string) => {
    const keys = group.map(dedupeKey);
    const idem = !force && group.length === 1 ? keys[0] : eventId;
    queue.push(newItem(eventId, body, keys, group.length, now, idem, dest, label));
    for (const k of keys) dedupe[k] = { t: now, confirmed: false, item: eventId };
    eventIds.push(eventId);
  };
  if (dest.kind === "webhook") {
    const bodies = buildBodies(leads, { preset: dest.mappingPreset, mode: dest.sendMode, source, custom: settings.customFields, eventId: () => crypto.randomUUID(), sentAt, import: imp });
    for (const b of bodies) push(b.eventId, JSON.stringify(b.body), b.leads, b.leads.length === 1 ? b.leads[0].full_name : `${b.leads.length} leads`);
  } else {
    const runs = buildLeadRuns(dest.input, leads, source, imp, settings.customFields, () => crypto.randomUUID(), sentAt);
    for (const r of runs) push(crypto.randomUUID(), playRunBody(dest, r.input), r.leads, r.label);
  }
  return { queued: leads.length, eventIds };
}

async function handleCapture(msg: CaptureMsg): Promise<CaptureResponse> {
  return withLock(async () => {
    const settings = await getSettings();
    const now = Date.now();
    const daily = await loadDaily();
    const remaining = Math.max(0, settings.dailyCap - daily.queued);
    const base: CaptureResponse = { ok: false, queued: 0, skippedDuplicates: [], rejectedReason: null, remainingToday: remaining };

    const reject = async (reason: NonNullable<CaptureResponse["rejectedReason"]>, extra: Record<string, unknown> = {}, detail: string | null = null) => {
      await logEvent("capture.rejected", `Capture rejected: ${reason}${detail ? ` (${detail})` : ""}`, { reason, pageType: msg.pageType, pageUrl: msg.pageUrl, ...extra });
      return { ...base, rejectedReason: reason, detail };
    };
    if (!isPageType(msg.pageType) || !isAllowedPageUrl(msg.pageUrl, TEST_BUILD)) return reject("invalid_message");
    const dest = resolveDestination(settings, msg.destinationId);
    const problem = destinationProblem(dest);
    if (problem || !dest) return reject(problem ?? "no_destination");
    if (dest.kind === "deepline_play") {
      if (!dest.input.acceptsLeads) return reject("unsupported_by_play", { play: dest.playKey }, `${dest.playName} does not take people as input`);
      const missing = unfillableRequired(dest.input, "leads");
      if (missing.length) return reject("unsupported_by_play", { play: dest.playKey, missing }, `${dest.playName} requires ${missing.join(", ")}, which LinkedIn pages cannot provide`);
    }

    const requested = Array.isArray(msg.leads) ? msg.leads.length : 0;
    let leads = validateLeads(msg.leads);
    await logEvent("capture.requested", `${requested} lead(s) captured on ${msg.pageType} for ${describeDestination(dest)}`, { pageType: msg.pageType, pageUrl: msg.pageUrl, requested, valid: leads.length, force: !!msg.force, importKind: msg.importKind ?? "manual", destination: dest.id });
    const skipped: string[] = [];
    const dedupe = activeDedupe(await loadDedupe(), settings.dedupeTtlDays, now);
    if (settings.dedupe && !msg.force) {
      leads = leads.filter((l) => {
        const k = dedupeKey(l);
        if (dedupe[k]) {
          skipped.push(k);
          return false;
        }
        return true;
      });
    }
    // The same lead twice in one message counts once.
    const seen = new Set<string>();
    leads = leads.filter((l) => {
      const k = dedupeKey(l);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (skipped.length) await logEvent("capture.duplicate", `${skipped.length} already-sent lead(s) skipped`, { keys: skipped });
    if (!leads.length) {
      if (!skipped.length) return reject("nothing_to_send", { requested });
      return { ...base, skippedDuplicates: skipped, rejectedReason: null, ok: true };
    }
    if (leads.length > remaining) return reject("daily_cap", { requested: leads.length, remaining });

    const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: VERSION, page_type: msg.pageType, page_url: msg.pageUrl, captured_by: settings.capturedBy || null };
    const isList = msg.pageType === "salesnav_search" || msg.pageType === "salesnav_list" || msg.pageType === "people_search";
    const rec = isList ? buildSearchRecord(msg.pageUrl, msg.pageType, null, "") : null;
    const importId = typeof msg.importId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(msg.importId) ? msg.importId : crypto.randomUUID();
    const imp: ImportInfo = {
      import_id: importId,
      imported_by: settings.capturedBy || null,
      imported_at: new Date(now).toISOString(),
      import_kind: msg.importKind === "basket" ? "basket" : "manual",
      search_url: isList ? searchKey(msg.pageUrl) : null,
      search_name: isList ? searchName(msg.pageUrl, msg.pageType, typeof msg.pageTitle === "string" ? msg.pageTitle.slice(0, 200) : null) : null,
      list_id: rec?.list_id ?? null,
      page: rec?.page ?? null
    };

    const queue = recoverStaleLeases(await loadQueue(), now);
    const enq = enqueueLeads(dest, settings, leads, source, imp, !!msg.force, now, queue, dedupe);
    await saveDedupe(dedupe);
    await saveDaily({ ...daily, queued: daily.queued + leads.length });
    await saveQueue(prune(queue, now));
    await logEvent("capture.queued", `${leads.length} lead(s) queued for ${describeDestination(dest)}`, { count: leads.length, importId, importKind: imp.import_kind, searchName: imp.search_name, events: enq.eventIds, leads: leads.map(dedupeKey), remainingToday: remaining - leads.length, destination: dest.id });
    void flush();
    broadcast({ type: "STATE_CHANGED" });
    return { ok: true, queued: leads.length, skippedDuplicates: skipped, rejectedReason: null, remainingToday: remaining - leads.length };
  });
}

type SearchMsg = Extract<ContentToBackground, { type: "SEARCH_CAPTURE" }>;

/** Hand a search to the destination so a backend provider fetches the
 *  results. The extension never pages through LinkedIn itself. */
async function handleSearchCapture(msg: SearchMsg): Promise<SearchCaptureResponse> {
  return withLock(async () => {
    const settings = await getSettings();
    const no = (rejectedReason: SearchCaptureResponse["rejectedReason"], detail: string | null = null): SearchCaptureResponse => ({ ok: false, queued: false, duplicate: false, rejectedReason, detail });
    if (!isPageType(msg.pageType) || !isAllowedPageUrl(msg.url, TEST_BUILD)) return no("invalid_message");
    const dest = resolveDestination(settings, msg.destinationId);
    const problem = destinationProblem(dest);
    if (problem || !dest) return no(problem ?? "no_destination");
    if (dest.kind === "deepline_play" && !dest.input.acceptsSearch) return no("unsupported_by_play", `${dest.playName} has no search URL input`);
    // A saved-search deep link only resolves for its owner: require the share link.
    let url = msg.url;
    const savedId = savedSearchIdFrom(url);
    if (savedId) {
      const share = (await loadShareLinks())[savedId];
      if (!share) return no("saved_search_needs_share_link");
      url = share;
    }
    const now = Date.now();
    const key = `search:${searchKey(url).toLowerCase()}:${dest.id}`;
    const dedupe = activeDedupe(await loadDedupe(), settings.dedupeTtlDays, now);
    if (settings.dedupe && !msg.force && dedupe[key]) return { ok: true, queued: false, duplicate: true, rejectedReason: null };
    const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: VERSION, page_type: msg.pageType, page_url: searchKey(url), captured_by: settings.capturedBy || null };
    const eventId = crypto.randomUUID();
    const hint = typeof msg.totalHint === "number" && Number.isFinite(msg.totalHint) && msg.totalHint >= 0 ? Math.floor(msg.totalHint) : null;
    const limit = typeof msg.limit === "number" && Number.isFinite(msg.limit) && msg.limit > 0 ? Math.min(2500, Math.floor(msg.limit)) : settings.searchDefaultLimit;
    const record = buildSearchRecord(url, msg.pageType, hint, new Date(now).toISOString(), limit);
    if (savedId) record.saved_search_id = savedId;
    const name = (typeof msg.searchName === "string" && msg.searchName.trim().slice(0, 200)) || searchName(url, msg.pageType) || null;
    const imp: ImportInfo = { import_id: eventId, imported_by: settings.capturedBy || null, imported_at: new Date(now).toISOString(), import_kind: "search", search_url: record.search_url, search_name: name, list_id: record.list_id, page: null };
    const body = dest.kind === "webhook" ? JSON.stringify(buildSearchBody(record, dest.mappingPreset, source, settings.customFields, eventId, new Date(now).toISOString(), imp)) : playRunBody(dest, buildSearchRun(dest.input, record, source, imp, settings.customFields, name));
    const queue = recoverStaleLeases(await loadQueue(), now);
    queue.push(newItem(eventId, body, [key], 0, now, key, dest, `search: ${name ?? record.search_url}`));
    dedupe[key] = { t: now, confirmed: false, item: eventId };
    await saveDedupe(dedupe);
    await saveQueue(prune(queue, now));
    await logEvent("search.saved", `Search sent to ${describeDestination(dest)}: ${name ?? record.search_url} (limit ${limit})`, { eventId, pageType: msg.pageType, searchUrl: record.search_url, totalHint: hint, limit, savedSearchId: savedId, destination: dest.id });
    void flush();
    broadcast({ type: "STATE_CHANGED" });
    return { ok: true, queued: true, duplicate: false, rejectedReason: null };
  });
}

/* ------------------------------------------------------------ basket */

async function basketResponse(b?: Basket): Promise<BasketResponse> {
  const basket = b ?? (await loadBasket());
  return { items: basketItems(basket), count: Object.keys(basket).length, pages: basketPages(basket) };
}

async function basketAdd(leads: unknown, pageType: PageType, pageUrl: string, pageTitle: string | null): Promise<BasketResponse & { added: number; full: boolean }> {
  return withLock(async () => {
    const valid = validateLeads(leads, 200);
    const res = addToBasket(await loadBasket(), valid, pageType, pageUrl, pageTitle, Date.now());
    await saveBasket(res.basket);
    if (res.added.length) await logEvent("basket.added", `${res.added.length} lead(s) added to basket from ${pageType}`, { pageUrl, keys: res.added, basketSize: Object.keys(res.basket).length, full: res.full });
    const summary = await basketResponse(res.basket);
    broadcast({ type: "BASKET_CHANGED", keys: Object.keys(res.basket) });
    await notifyTabsBasket(Object.keys(res.basket));
    return { ...summary, added: res.added.length, full: res.full };
  });
}

async function basketRemove(keys: string[]): Promise<BasketResponse> {
  return withLock(async () => {
    const next = removeFromBasket(await loadBasket(), keys);
    await saveBasket(next);
    await logEvent("basket.removed", `${keys.length} lead(s) removed from basket`, { keys: keys.slice(0, 100), basketSize: Object.keys(next).length });
    broadcast({ type: "BASKET_CHANGED", keys: Object.keys(next) });
    await notifyTabsBasket(Object.keys(next));
    return basketResponse(next);
  });
}

async function basketClear(): Promise<BasketResponse> {
  return withLock(async () => {
    const before = Object.keys(await loadBasket()).length;
    await saveBasket({});
    await logEvent("basket.cleared", `Basket cleared (${before} lead(s))`, { count: before });
    broadcast({ type: "BASKET_CHANGED", keys: [] });
    await notifyTabsBasket([]);
    return basketResponse({});
  });
}

/** Send everything in the basket: one import id, one capture per source page
 *  so each lead keeps its own search name / list id. Leads that were queued
 *  leave the basket; rejected ones stay so the operator can retry. */
async function basketSend(force: boolean, destinationId?: string): Promise<CaptureResponse & { sentFromPages: number }> {
  const items = basketItems(await loadBasket());
  if (!items.length) return { ok: false, queued: 0, skippedDuplicates: [], rejectedReason: "nothing_to_send", remainingToday: 0, sentFromPages: 0 };
  const importId = crypto.randomUUID();
  const groups = groupByPage(items);
  let queued = 0;
  const skipped: string[] = [];
  let remaining = 0;
  let firstReject: CaptureResponse | null = null;
  const done: string[] = [];
  for (const g of groups) {
    const res = await handleCapture({ type: "CAPTURE", leads: g.leads, pageType: g.pageType, pageUrl: g.pageUrl, pageTitle: g.pageTitle ?? undefined, force, importId, importKind: "basket", destinationId });
    remaining = res.remainingToday;
    if (res.ok) {
      queued += res.queued;
      skipped.push(...res.skippedDuplicates);
      done.push(...g.keys);
    } else if (res.rejectedReason === "nothing_to_send") {
      done.push(...g.keys); // all duplicates
    } else {
      firstReject ??= res;
      if (res.rejectedReason === "daily_cap") break;
    }
  }
  if (done.length) {
    await withLock(async () => {
      const next = removeFromBasket(await loadBasket(), done);
      await saveBasket(next);
      broadcast({ type: "BASKET_CHANGED", keys: Object.keys(next) });
      await notifyTabsBasket(Object.keys(next));
    });
  }
  await logEvent("basket.sent", `Basket send: ${queued} queued, ${skipped.length} already sent, ${items.length - done.length} left in basket`, { importId, queued, skipped: skipped.length, pages: groups.length, left: items.length - done.length, rejected: firstReject?.rejectedReason ?? null });
  if (!queued && firstReject) return { ...firstReject, sentFromPages: 0 };
  return { ok: true, queued, skippedDuplicates: skipped, rejectedReason: firstReject?.rejectedReason ?? null, detail: firstReject?.detail ?? null, remainingToday: remaining, sentFromPages: groups.length };
}

/** Tell every LinkedIn tab which keys are in the basket so row toggles
 *  reflect selections made elsewhere. */
async function notifyTabsBasket(keys: string[]): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const t of tabs) {
    if (t.id != null && isAllowedPageUrl(t.url, TEST_BUILD)) chrome.tabs.sendMessage(t.id, { type: "BASKET_CHANGED", keys }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------ page context */

/** Latest context per tab, kept in worker memory (cheap to rebuild: the
 *  content script re-sends on every mount and on request). */
const contexts = new Map<number, PageContext>();

function sanitizeContext(raw: unknown, tabUrl: string | undefined): PageContext | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const url = typeof c.url === "string" ? c.url : "";
  if (!isAllowedPageUrl(url, TEST_BUILD) || (tabUrl && !sameOrigin(url, tabUrl))) return null;
  const lead = c.lead ? validateLead(c.lead) : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const savedSearchId = typeof c.savedSearchId === "string" && /^[0-9]{1,20}$/.test(c.savedSearchId) ? c.savedSearchId : null;
  return {
    pageType: isPageType(c.pageType) ? c.pageType : null,
    url,
    title: typeof c.title === "string" ? c.title.slice(0, 300) : "",
    lead,
    rowsOnPage: num(c.rowsOnPage),
    selectedOnPage: num(c.selectedOnPage),
    savedSearchId,
    shareUrl: null,
    searchName: typeof c.searchName === "string" ? c.searchName.slice(0, 200) : null,
    totalHint: typeof c.totalHint === "number" && Number.isFinite(c.totalHint) ? Math.floor(c.totalHint) : null
  };
}

async function withShareLink(ctx: PageContext): Promise<PageContext> {
  if (!ctx.savedSearchId) return ctx;
  const links = await loadShareLinks();
  return { ...ctx, shareUrl: links[ctx.savedSearchId] ?? null };
}

/** A share link copied by Sales Navigator's "Share search" button on a saved
 *  search page. Stored per saved-search id for the session. */
async function rememberShareLink(url: string, tabId: number | undefined): Promise<{ ok: boolean }> {
  if (!isAllowedPageUrl(url, TEST_BUILD) || !/\/sales\/search\//.test(url) || !decodeURIComponent(url).includes("query=")) return { ok: false };
  const ctx = tabId != null ? contexts.get(tabId) : undefined;
  const id = ctx?.savedSearchId;
  if (!id) return { ok: false };
  const links = await loadShareLinks();
  links[id] = searchKey(url);
  await session().set({ [SESSION_KEYS.shareLinks]: links });
  await logEvent("share_link.captured", `Share link captured for saved search ${id}`, { savedSearchId: id, searchUrl: searchKey(url) });
  if (tabId != null && ctx) {
    const next = await withShareLink(ctx);
    contexts.set(tabId, next);
    broadcast({ type: "CONTEXT_CHANGED", tabId, context: next });
  }
  return { ok: true };
}

/* ------------------------------------------------------------ delivery */

let flushing = false;
/** Deliver due items one at a time. Claim and commit happen under the lock;
 *  the network call happens outside it so captures are never blocked by a
 *  slow receiver. A worker suspension mid-request leaves a `sending` lease
 *  that `recoverStaleLeases` returns to pending on the next run. */
async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const claimed = await withLock(async (): Promise<{ item: QueueItem; dest: Destination } | null> => {
        const settings = await getSettings();
        const now = Date.now();
        const before = await loadQueue();
        let items = recoverStaleLeases(before, now);
        const recovered = items.filter((i, k) => before[k].status === "sending" && i.status !== "sending").map((i) => i.id);
        if (recovered.length) await logEvent("lease.recovered", `${recovered.length} stalled send(s) re-queued after worker restart`, { items: recovered });
        // Items whose destination was deleted fail permanently (nothing to send to).
        items = items.map((i) => (i.status === "pending" && !settings.destinations.some((d) => d.id === i.destinationId) ? { ...i, status: "failed" as const, lastError: "destination_removed" } : i));
        const next = due(items, now)[0];
        if (!next) {
          await saveQueue(prune(items, now));
          return null;
        }
        const dest = settings.destinations.find((d) => d.id === next.destinationId)!;
        const item = claim(next, now);
        items = items.map((i) => (i.id === item.id ? item : i));
        await saveQueue(items);
        return { item, dest };
      });
      if (!claimed) break;
      await logEvent("send.attempt", `Sending ${claimed.item.label || claimed.item.leadCount || "search"} to ${describeDestination(claimed.dest)} (attempt ${claimed.item.attempts})`, { eventId: claimed.item.id, attempt: claimed.item.attempts, bytes: claimed.item.body.length, leads: claimed.item.leadUrls, destination: claimed.dest.id });
      const result = await sendBody(claimed.dest, claimed.item.body, claimed.item.id, { version: VERSION, dedupeKey: claimed.item.dedupeKey });
      await withLock(async () => {
        const now = Date.now();
        const items = await loadQueue();
        const current = items.find((i) => i.id === claimed.item.id);
        if (!current) return; // cleared meanwhile
        const updated = { ...afterAttempt(current, result, now), runId: result.runId ?? current.runId };
        await saveQueue(items.map((i) => (i.id === updated.id ? updated : i)));
        const settings = await getSettings();
        const dedupe = activeDedupe(await loadDedupe(), settings.dedupeTtlDays, now);
        const daily = await loadDaily();
        if (updated.status === "sent") {
          for (const k of updated.leadUrls) dedupe[k] = { t: dedupe[k]?.t ?? now, confirmed: true, item: null };
          await saveDaily({ ...daily, delivered: daily.delivered + updated.leadCount });
          await logEvent("send.ok", `${claimed.dest.kind === "deepline_play" ? "Play run started" : "Webhook accepted"} (${result.status})${updated.runId ? ` run ${updated.runId}` : ""}`, { eventId: updated.id, status: result.status, attempt: updated.attempts, leads: updated.leadUrls, runId: updated.runId, destination: claimed.dest.id });
        } else if (updated.status === "failed") {
          // Never delivered: release the identity so the rep can resend.
          for (const k of updated.leadUrls) if (dedupe[k] && !dedupe[k].confirmed && dedupe[k].item === updated.id) delete dedupe[k];
          await saveDaily({ ...daily, failed: daily.failed + updated.leadCount });
          await logEvent("send.failed", `Delivery failed permanently: ${result.error ?? result.status}`, { eventId: updated.id, status: result.status, error: result.error, attempt: updated.attempts, leads: updated.leadUrls, destination: claimed.dest.id });
        } else {
          await logEvent("send.retry", `Delivery failed (${result.error ?? result.status}); retry ${updated.attempts + 1} at ${new Date(updated.nextAttemptAt).toISOString()}`, { eventId: updated.id, status: result.status, error: result.error, attempt: updated.attempts, nextAttemptAt: updated.nextAttemptAt });
        }
        await saveDedupe(dedupe);
      });
      broadcast({ type: "STATE_CHANGED" });
    }
  } finally {
    flushing = false;
  }
}

/* ------------------------------------------------------------ state */

async function getState(redacted: boolean): Promise<StateResponse> {
  const [settings, queue, daily, dedupe, basket] = await Promise.all([getSettings(), loadQueue(), loadDaily(), loadDedupe(), loadBasket()]);
  return {
    settings: redacted ? { ...settings, destinations: settings.destinations.map(redactDestination) } : settings,
    queue: queue.slice().sort((a, b) => b.createdAt - a.createdAt),
    sentToday: daily.queued,
    remainingToday: Math.max(0, settings.dailyCap - daily.queued),
    dedupeCount: Object.values(activeDedupe(dedupe, settings.dedupeTtlDays, Date.now())).filter((e) => e.confirmed).length,
    day: daily.day,
    basketCount: Object.keys(basket).length
  };
}

/** Test a destination: a signed `test` event for webhooks, a credential
 *  check for plays (no run is started). Accepts an unsaved destination from
 *  the options form so a bad configuration is never persisted. */
async function testDestination(raw: Destination | undefined, destinationId: string | undefined): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const settings = await getSettings();
  const dest = raw ? sanitizeDestination(raw) : resolveDestination(settings, destinationId);
  if (!dest) return { ok: false, status: null, error: "Destination is incomplete" };
  let r: { ok: boolean; status: number | null; error: string | null };
  if (dest.kind === "webhook") {
    const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: VERSION, page_type: "profile", page_url: "https://www.linkedin.com/in/test-connection", captured_by: settings.capturedBy || null };
    const eventId = crypto.randomUUID();
    const body = JSON.stringify({ schema_version: "1", event: "test", event_id: eventId, sent_at: new Date().toISOString(), source, custom: settings.customFields });
    r = await sendBody(dest, body, eventId, { version: VERSION, timeoutMs: 10_000 });
  } else {
    r = await testApiKey(dest.baseUrl, dest.apiKey);
  }
  await logEvent("destination.test", r.ok ? `${describeDestination(dest)}: test ok (${r.status})` : `${describeDestination(dest)}: test failed: ${r.error}`, { status: r.status, error: r.error, destination: dest.id, kind: dest.kind });
  return { ok: r.ok, status: r.status, error: r.error };
}

async function handleListPlays(baseUrl: string, apiKey: string): Promise<ListPlaysResponse> {
  try {
    const plays = await listPlays(baseUrl, apiKey);
    await logEvent("plays.listed", `${plays.length} Deepline play(s) listed`, { count: plays.length, host: new URL(baseUrl).host });
    return { ok: true, plays, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await logEvent("error", `Listing Deepline plays failed: ${error}`, { error });
    return { ok: false, plays: [], error };
  }
}

/* ------------------------------------------------------------ messages */

/** Extension pages (side panel, options), whether opened as a panel or in a tab.
 *  Content scripts can never present a chrome-extension:// URL. */
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender.url === "string" && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}
function isContentPage(sender: chrome.runtime.MessageSender): boolean {
  return !!sender.tab && isAllowedPageUrl(sender.tab.url ?? sender.url, TEST_BUILD);
}

chrome.runtime.onMessage.addListener((msg: ContentToBackground, sender, sendResponse) => {
  (async () => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object" || typeof msg.type !== "string") return { error: "invalid_sender" };
    const fromExt = isExtensionPage(sender);
    const fromPage = !fromExt && isContentPage(sender);
    if (!fromPage && !fromExt) return { error: "invalid_sender" };
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url;
    switch (msg.type) {
      case "CAPTURE": {
        if (fromPage && (typeof msg.pageUrl !== "string" || !sameOrigin(msg.pageUrl, tabUrl))) return { ok: false, queued: 0, skippedDuplicates: [], rejectedReason: "invalid_message", remainingToday: 0 } satisfies CaptureResponse;
        // Pages send to the active destination only; choosing another is a panel privilege.
        return handleCapture(fromPage ? { ...msg, destinationId: undefined } : msg);
      }
      case "GET_STATE":
        return fromExt ? getState(!!sender.url && !sender.url.includes("options.html")) : { error: "forbidden" };
      case "GET_SETTINGS":
        return fromExt ? getSettings() : toContentSettings(await getSettings());
      case "GET_CONTENT_SETTINGS":
        return toContentSettings(await getSettings());
      case "CHECK_DEDUPE": {
        const keys = Array.isArray(msg.keys) ? msg.keys.filter((k): k is string => typeof k === "string").slice(0, 200) : [];
        const s = await getSettings();
        const map = activeDedupe(await loadDedupe(), s.dedupeTtlDays, Date.now());
        return Object.fromEntries(keys.map((k) => [k, !!map[k]?.confirmed || (!!map[k] && map[k].item != null)]));
      }
      case "GET_LOG":
        return fromExt ? readLog(typeof msg.limit === "number" ? msg.limit : 200) : { error: "forbidden" };
      case "CLEAR_LOG":
        if (!fromExt) return { error: "forbidden" };
        await clearLog();
        return [];
      case "RETRY_NOW": {
        if (!fromExt) return { error: "forbidden" };
        await logEvent("queue.retried", "Retry requested from the panel");
        await withLock(async () => {
          const items = (await loadQueue()).map((i) => (i.status === "pending" || i.status === "failed" ? { ...i, status: "pending" as const, nextAttemptAt: Date.now(), attempts: i.status === "failed" ? 0 : i.attempts } : i));
          await saveQueue(items);
        });
        await flush();
        return getState(true);
      }
      case "CLEAR_QUEUE": {
        if (!fromExt) return { error: "forbidden" };
        await withLock(async () => saveQueue(clearQueue(await loadQueue(), msg.status ?? "all", Date.now())));
        await logEvent("queue.cleared", `Queue cleared (${msg.status ?? "all"})`, { status: msg.status ?? "all" });
        return getState(true);
      }
      case "TEST_DESTINATION":
        return fromExt ? testDestination(msg.destination, msg.destinationId) : { error: "forbidden" };
      case "LIST_PLAYS":
        return fromExt ? handleListPlays(String(msg.baseUrl ?? ""), String(msg.apiKey ?? "")) : { error: "forbidden" };
      case "SET_ACTIVE_DESTINATION": {
        if (!fromExt) return { error: "forbidden" };
        const s = await saveSettings({ activeDestinationId: String(msg.destinationId) });
        await logEvent("destination.changed", `Active destination: ${describeDestination(activeDestination(s))}`, { destination: s.activeDestinationId });
        broadcast({ type: "STATE_CHANGED" });
        return getState(true);
      }
      case "TOGGLE_FAVORITE": {
        if (!fromExt) return { error: "forbidden" };
        const cur = await getSettings();
        await saveSettings({ destinations: cur.destinations.map((d) => (d.id === msg.destinationId ? { ...d, favorite: !d.favorite } : d)) });
        return getState(true);
      }
      case "SEARCH_CAPTURE":
        if (fromPage && !sameOrigin(msg.url, tabUrl)) return { ok: false, queued: false, duplicate: false, rejectedReason: "invalid_message" } satisfies SearchCaptureResponse;
        return handleSearchCapture(fromPage ? { ...msg, destinationId: undefined } : msg);
      case "BASKET_ADD": {
        if (!isPageType(msg.pageType) || typeof msg.pageUrl !== "string" || !isAllowedPageUrl(msg.pageUrl, TEST_BUILD)) return { error: "invalid_message" };
        if (fromPage && !sameOrigin(msg.pageUrl, tabUrl)) return { error: "invalid_message" };
        return basketAdd(msg.leads, msg.pageType, msg.pageUrl, typeof msg.pageTitle === "string" ? msg.pageTitle.slice(0, 200) : null);
      }
      case "BASKET_REMOVE":
        return basketRemove(Array.isArray(msg.keys) ? msg.keys.filter((k): k is string => typeof k === "string").slice(0, 1000) : []);
      case "BASKET_CLEAR":
        return basketClear();
      case "BASKET_GET":
        return basketResponse();
      case "BASKET_SEND":
        return basketSend(!!msg.force, fromExt ? msg.destinationId : undefined);
      case "PAGE_CONTEXT": {
        if (!fromPage || tabId == null) return { error: "forbidden" };
        const ctx = sanitizeContext(msg.context, tabUrl);
        if (!ctx) return { error: "invalid_message" };
        const full = await withShareLink(ctx);
        contexts.set(tabId, full);
        broadcast({ type: "CONTEXT_CHANGED", tabId, context: full });
        return { ok: true };
      }
      case "SHARE_LINK":
        if (!fromPage) return { error: "forbidden" };
        return rememberShareLink(String(msg.url ?? ""), tabId);
      case "GET_PAGE_CONTEXT": {
        if (!fromExt) return { error: "forbidden" };
        const id = Number(msg.tabId);
        const cached = contexts.get(id);
        if (cached) return await withShareLink(cached);
        // Ask the page (it may have loaded before the worker woke up).
        try {
          const fresh = (await chrome.tabs.sendMessage(id, { type: "PAGE_ACTION", action: "refresh" })) as PageContext | undefined;
          const ctx = fresh ? sanitizeContext(fresh, (await chrome.tabs.get(id).catch(() => null))?.url) : null;
          if (ctx) {
            const full = await withShareLink(ctx);
            contexts.set(id, full);
            return full;
          }
        } catch {
          /* no content script on that tab */
        }
        return null;
      }
      case "OPEN_SIDE_PANEL": {
        // User gesture from the on-page panel: open the side panel for that tab.
        if (tabId == null || !chrome.sidePanel?.open) return { ok: false };
        try {
          await chrome.sidePanel.open({ tabId });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      default:
        return { error: "unknown message" };
    }
  })().then(sendResponse, (e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});

function sameOrigin(a: unknown, b: string | undefined): boolean {
  if (typeof a !== "string" || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
  contexts.delete(tabId);
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void flush();
});
chrome.runtime.onStartup.addListener(() => void flush());
chrome.runtime.onInstalled.addListener(() => {
  void flush();
  // Clicking the toolbar icon opens the side panel (no popup).
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined);
});
void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined);
// A fresh worker instance (after suspension) also recovers leases.
void flush();

chrome.commands?.onCommand?.addListener(async (command) => {
  if (command !== "send-current") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SEND_CURRENT" }).catch(() => undefined);
});

export type { PageType, LeadRecord, Settings };
