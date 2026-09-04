declare const __EXTENSION_VERSION__: string;
declare const __TEST_BUILD__: boolean;

import { buildBodies, buildSearchBody } from "../shared/mapping";
import type { CaptureResponse, CollectResponse, ContentToBackground, ExportStatusResponse, StateResponse } from "../shared/messages";
import { dedupeKey } from "../shared/normalize";
import { buildSearchRecord, searchKey, searchName } from "../shared/search";
import { getSettings, toContentSettings, validateWebhookUrl } from "../shared/settings";
import type { ImportInfo, LeadRecord, PageType, QueueItem, Settings, SourceInfo } from "../shared/types";
import { isAllowedPageUrl, isPageType, validateLeads } from "../shared/validate";
import { afterPage, exportablePageType, fail as failJob, isActive, isSameSearchPage, newJob, pageDelayMs, pause as pauseJob, remaining as jobRemaining, resume as resumeJob, stop as stopJob, urlForPage, type ExportJob } from "../shared/export-job";
import { withLock } from "./lock";
import { clearLog, logEvent, readLog } from "../shared/log";
import { afterAttempt, claim, clearQueue, due, newItem, nextWake, prune, recoverStaleLeases } from "./queue";
import { sendBody } from "./sender";

const VERSION = typeof __EXTENSION_VERSION__ === "string" ? __EXTENSION_VERSION__ : "dev";
const TEST_BUILD = typeof __TEST_BUILD__ === "boolean" ? __TEST_BUILD__ : false;
const ALARM = "lwe-flush";
const EXPORT_ALARM = "lwe-export-watchdog";
const KEYS = { queue: "queue", dedupe: "dedupe", daily: "daily", exportJob: "exportJob", exportHistory: "exportHistory" } as const;

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

async function loadQueue(): Promise<QueueItem[]> {
  const q = (await chrome.storage.local.get(KEYS.queue))[KEYS.queue];
  return Array.isArray(q) ? (q as QueueItem[]).map((i) => Object.assign({ sendingAt: null, dedupeKey: i.id }, i)) : [];
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

/* ------------------------------------------------------------ capture */

type CaptureMsg = Extract<ContentToBackground, { type: "CAPTURE" }> & { partial?: boolean };

async function handleCapture(msg: CaptureMsg): Promise<CaptureResponse> {
  return withLock(async () => {
    const settings = await getSettings();
    const now = Date.now();
    const daily = await loadDaily();
    const remaining = Math.max(0, settings.dailyCap - daily.queued);
    const base: CaptureResponse = { ok: false, queued: 0, skippedDuplicates: [], rejectedReason: null, remainingToday: remaining };

    const reject = async (reason: NonNullable<CaptureResponse["rejectedReason"]>, extra: Record<string, unknown> = {}) => {
      await logEvent("capture.rejected", `Capture rejected: ${reason}`, { reason, pageType: msg.pageType, pageUrl: msg.pageUrl, ...extra });
      return { ...base, rejectedReason: reason };
    };
    if (!isPageType(msg.pageType) || !isAllowedPageUrl(msg.pageUrl, TEST_BUILD)) return reject("invalid_message");
    if (!settings.webhookUrl) return reject("no_webhook");
    if (!validateWebhookUrl(settings.webhookUrl).ok) return reject("invalid_url");

    const requested = Array.isArray(msg.leads) ? msg.leads.length : 0;
    let leads = validateLeads(msg.leads);
    await logEvent("capture.requested", `${requested} lead(s) captured on ${msg.pageType}`, { pageType: msg.pageType, pageUrl: msg.pageUrl, requested, valid: leads.length, force: !!msg.force, importKind: msg.importKind ?? "manual" });
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
    if (leads.length > remaining) {
      // Bulk export sends what the cap still allows and reports the truncation;
      // interactive capture is all-or-nothing so the rep sees a clear message.
      if (!msg.partial || remaining === 0) return reject("daily_cap", { requested: leads.length, remaining });
      await logEvent("capture.rejected", `Daily cap truncates export page to ${remaining}`, { reason: "daily_cap_partial", requested: leads.length, remaining });
      leads = leads.slice(0, remaining);
    }

    const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: VERSION, page_type: msg.pageType, page_url: msg.pageUrl, captured_by: settings.capturedBy || null };
    const isList = msg.pageType === "salesnav_search" || msg.pageType === "salesnav_list" || msg.pageType === "people_search";
    const rec = isList ? buildSearchRecord(msg.pageUrl, msg.pageType, null, "") : null;
    const importId = typeof msg.importId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(msg.importId) ? msg.importId : crypto.randomUUID();
    const imp: ImportInfo = {
      import_id: importId,
      imported_by: settings.capturedBy || null,
      imported_at: new Date(now).toISOString(),
      import_kind: msg.importKind === "export" ? "export" : "manual",
      search_url: isList ? searchKey(msg.pageUrl) : null,
      search_name: isList ? searchName(msg.pageUrl, msg.pageType, typeof msg.pageTitle === "string" ? msg.pageTitle.slice(0, 200) : null) : null,
      list_id: rec?.list_id ?? null,
      page: rec?.page ?? null
    };
    const bodies = buildBodies(leads, { preset: settings.mappingPreset, mode: settings.sendMode, source, custom: settings.customFields, eventId: () => crypto.randomUUID(), sentAt: new Date(now).toISOString(), import: imp });

    const queue = recoverStaleLeases(await loadQueue(), now);
    for (const b of bodies) {
      const keys = b.leads.map(dedupeKey);
      const idem = !msg.force && b.leads.length === 1 ? keys[0] : b.eventId;
      queue.push(newItem(b.eventId, JSON.stringify(b.body), keys, b.leads.length, now, idem));
      for (const k of keys) dedupe[k] = { t: now, confirmed: false, item: b.eventId };
    }
    await saveDedupe(dedupe);
    await saveDaily({ ...daily, queued: daily.queued + leads.length });
    await saveQueue(prune(queue, now));
    await logEvent("capture.queued", `${leads.length} lead(s) queued for ${new URL(settings.webhookUrl).host}`, { count: leads.length, importId, importKind: imp.import_kind, searchName: imp.search_name, events: bodies.map((b) => b.eventId), leads: leads.map(dedupeKey), remainingToday: remaining - leads.length });
    void flush();
    return { ok: true, queued: leads.length, skippedDuplicates: skipped, rejectedReason: null, remainingToday: remaining - leads.length };
  });
}

async function handleSearchCapture(url: string, pageType: PageType, totalHint: number | null, force = false): Promise<{ ok: boolean; queued: boolean; duplicate: boolean; rejectedReason: CaptureResponse["rejectedReason"] }> {
  return withLock(async () => {
    const settings = await getSettings();
    if (!isPageType(pageType) || !isAllowedPageUrl(url, TEST_BUILD)) return { ok: false, queued: false, duplicate: false, rejectedReason: "invalid_message" };
    if (!settings.webhookUrl) return { ok: false, queued: false, duplicate: false, rejectedReason: "no_webhook" };
    if (!validateWebhookUrl(settings.webhookUrl).ok) return { ok: false, queued: false, duplicate: false, rejectedReason: "invalid_url" };
    const now = Date.now();
    const key = `search:${searchKey(url).toLowerCase()}`;
    const dedupe = activeDedupe(await loadDedupe(), settings.dedupeTtlDays, now);
    if (settings.dedupe && !force && dedupe[key]) return { ok: true, queued: false, duplicate: true, rejectedReason: null };
    const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: VERSION, page_type: pageType, page_url: searchKey(url), captured_by: settings.capturedBy || null };
    const eventId = crypto.randomUUID();
    const hint = typeof totalHint === "number" && Number.isFinite(totalHint) && totalHint >= 0 ? Math.floor(totalHint) : null;
    const body = buildSearchBody(buildSearchRecord(url, pageType, hint, new Date(now).toISOString()), settings.mappingPreset, source, settings.customFields, eventId, new Date(now).toISOString());
    const queue = recoverStaleLeases(await loadQueue(), now);
    queue.push(newItem(eventId, JSON.stringify(body), [key], 0, now, key));
    dedupe[key] = { t: now, confirmed: false, item: eventId };
    await saveDedupe(dedupe);
    await saveQueue(prune(queue, now));
    await logEvent("search.saved", `Search saved: ${searchName(url, pageType) ?? searchKey(url)}`, { eventId, pageType, searchUrl: searchKey(url), totalHint: hint });
    void flush();
    return { ok: true, queued: true, duplicate: false, rejectedReason: null };
  });
}

/* ------------------------------------------------------------ delivery */

let flushing = false;
/** Deliver due items one at a time. Claim and commit happen under the lock;
 *  the network call happens outside it so captures are never blocked by a
 *  slow webhook. A worker suspension mid-request leaves a `sending` lease
 *  that `recoverStaleLeases` returns to pending on the next run. */
async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const claimed = await withLock(async (): Promise<{ item: QueueItem; settings: Settings } | null> => {
        const settings = await getSettings();
        if (!settings.webhookUrl) return null;
        const now = Date.now();
        const before = await loadQueue();
        let items = recoverStaleLeases(before, now);
        const recovered = items.filter((i, k) => before[k].status === "sending" && i.status !== "sending").map((i) => i.id);
        if (recovered.length) await logEvent("lease.recovered", `${recovered.length} stalled send(s) re-queued after worker restart`, { items: recovered });
        const next = due(items, now)[0];
        if (!next) {
          await saveQueue(prune(items, now));
          return null;
        }
        const item = claim(next, now);
        items = items.map((i) => (i.id === item.id ? item : i));
        await saveQueue(items);
        return { item, settings };
      });
      if (!claimed) break;
      await logEvent("send.attempt", `Sending ${claimed.item.leadCount || "search"} (attempt ${claimed.item.attempts})`, { eventId: claimed.item.id, attempt: claimed.item.attempts, bytes: claimed.item.body.length, leads: claimed.item.leadUrls });
      const result = await sendBody(claimed.settings, claimed.item.body, claimed.item.id, { version: VERSION, dedupeKey: claimed.item.dedupeKey });
      await withLock(async () => {
        const now = Date.now();
        const items = await loadQueue();
        const current = items.find((i) => i.id === claimed.item.id);
        if (!current) return; // cleared meanwhile
        const updated = afterAttempt(current, result, now);
        await saveQueue(items.map((i) => (i.id === updated.id ? updated : i)));
        const settings = await getSettings();
        const dedupe = activeDedupe(await loadDedupe(), settings.dedupeTtlDays, now);
        const daily = await loadDaily();
        if (updated.status === "sent") {
          for (const k of updated.leadUrls) dedupe[k] = { t: dedupe[k]?.t ?? now, confirmed: true, item: null };
          await saveDaily({ ...daily, delivered: daily.delivered + updated.leadCount });
          await logEvent("send.ok", `Webhook accepted (${result.status})`, { eventId: updated.id, status: result.status, attempt: updated.attempts, leads: updated.leadUrls });
        } else if (updated.status === "failed") {
          // Never delivered: release the identity so the rep can resend.
          for (const k of updated.leadUrls) if (dedupe[k] && !dedupe[k].confirmed && dedupe[k].item === updated.id) delete dedupe[k];
          await saveDaily({ ...daily, failed: daily.failed + updated.leadCount });
          await logEvent("send.failed", `Delivery failed permanently: ${result.error ?? result.status}`, { eventId: updated.id, status: result.status, error: result.error, attempt: updated.attempts, leads: updated.leadUrls });
        } else {
          await logEvent("send.retry", `Delivery failed (${result.error ?? result.status}); retry ${updated.attempts + 1} at ${new Date(updated.nextAttemptAt).toISOString()}`, { eventId: updated.id, status: result.status, error: result.error, attempt: updated.attempts, nextAttemptAt: updated.nextAttemptAt });
        }
        await saveDedupe(dedupe);
      });
    }
  } finally {
    flushing = false;
  }
}

/* ------------------------------------------------------------ state */

async function getState(): Promise<StateResponse> {
  const [settings, queue, daily, dedupe, exportJob] = await Promise.all([getSettings(), loadQueue(), loadDaily(), loadDedupe(), loadJob()]);
  return {
    settings,
    queue: queue.slice().sort((a, b) => b.createdAt - a.createdAt),
    exportJob,
    sentToday: daily.queued,
    remainingToday: Math.max(0, settings.dailyCap - daily.queued),
    dedupeCount: Object.values(activeDedupe(dedupe, settings.dedupeTtlDays, Date.now())).filter((e) => e.confirmed).length,
    day: daily.day
  };
}

async function testWebhook(): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const settings = await getSettings();
  if (!settings.webhookUrl) return { ok: false, status: null, error: "No webhook URL configured" };
  const v = validateWebhookUrl(settings.webhookUrl);
  if (!v.ok) return { ok: false, status: null, error: v.reason };
  const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: VERSION, page_type: "profile", page_url: "https://www.linkedin.com/in/test-connection", captured_by: settings.capturedBy || null };
  const eventId = crypto.randomUUID();
  const body = JSON.stringify({ schema_version: "1", event: "test", event_id: eventId, sent_at: new Date().toISOString(), source, custom: settings.customFields });
  const r = await sendBody(settings, body, eventId, { version: VERSION, timeoutMs: 10_000 });
  await logEvent("webhook.test", r.ok ? `Test event accepted (${r.status})` : `Test event failed: ${r.error}`, { status: r.status, error: r.error, host: new URL(settings.webhookUrl).host });
  return { ok: r.ok, status: r.status, error: r.error };
}

/* ---------------- Bulk export: walk every page of a search ---------------- */

async function loadJob(): Promise<ExportJob | null> {
  const j = (await chrome.storage.local.get(KEYS.exportJob))[KEYS.exportJob] as ExportJob | null | undefined;
  return j ? Object.assign({ rev: 0 }, j) : null;
}
async function loadHistory(): Promise<ExportJob[]> {
  return ((await chrome.storage.local.get(KEYS.exportHistory))[KEYS.exportHistory] as ExportJob[] | undefined) ?? [];
}
/** Compare-and-swap commit: only writes when the stored job is the same job
 *  at the expected revision. Returns the stored job on conflict. */
async function commitJob(expected: ExportJob, next: ExportJob): Promise<{ ok: boolean; current: ExportJob | null }> {
  return withLock(async () => {
    const current = await loadJob();
    if (!current || current.id !== expected.id || current.rev !== expected.rev) return { ok: false, current };
    const saved = { ...next, rev: expected.rev + 1 };
    if (saved.pagesDone !== expected.pagesDone) {
      await logEvent("export.page", `Export page ${saved.pagesDone} done (${saved.collected} collected, ${saved.sent} sent)`, { jobId: saved.id, page: saved.pagesDone, collected: saved.collected, sent: saved.sent, skipped: saved.skipped });
    }
    if (saved.status !== expected.status) {
      const kind = saved.status === "paused" ? "export.paused" : saved.status === "running" ? "export.resumed" : saved.status === "stopped" ? "export.stopped" : saved.status === "error" ? "export.failed" : "export.finished";
      await logEvent(kind, `Export ${saved.status}${saved.stopReason ? ` (${saved.stopReason})` : ""}${saved.lastError ? `: ${saved.lastError}` : ""}`, { jobId: saved.id, pagesDone: saved.pagesDone, collected: saved.collected, sent: saved.sent, skipped: saved.skipped, reason: saved.stopReason });
    }
    if (isActive(saved)) await chrome.storage.local.set({ [KEYS.exportJob]: saved });
    else {
      const h = [saved, ...(await loadHistory())].slice(0, 20);
      await chrome.storage.local.set({ [KEYS.exportHistory]: h, [KEYS.exportJob]: null });
      await chrome.alarms.clear(EXPORT_ALARM);
    }
    return { ok: true, current: saved };
  });
}
/** Apply a transition to whatever job is stored right now (used by controls). */
async function transitionJob(fn: (j: ExportJob) => ExportJob): Promise<ExportJob | null> {
  for (let i = 0; i < 5; i++) {
    const cur = await loadJob();
    if (!cur) return null;
    const res = await commitJob(cur, fn(cur));
    if (res.ok) return res.current;
  }
  return await loadJob();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const sameUrl = isSameSearchPage;

/** Navigate the job's tab to `url` and wait until it reports complete at that
 *  URL. The listener is attached before navigation so a fast load cannot be
 *  missed; a removed tab rejects immediately. */
function navigateAndWait(tabId: number, url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("navigation_timeout")), timeoutMs);
    const onUpdated = (id: number, info: { status?: string }, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === "complete" && sameUrl(tab.url, url)) finish();
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(new Error("tab_closed"));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs
      .update(tabId, { url })
      .then(async () => {
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (!t) finish(new Error("tab_closed"));
        else if (t.status === "complete" && sameUrl(t.url, url)) finish();
      })
      .catch(() => finish(new Error("tab_closed")));
  });
}

async function collectWithRetry(tabId: number, jobId: string, page: number, attempts = 8): Promise<CollectResponse> {
  let lastErr = "content script did not answer";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, { type: "EXPORT_COLLECT", jobId, expectedPage: page })) as CollectResponse | undefined;
      if (res) return res;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000);
  }
  return { ok: false, jobId, expectedPage: page, pageType: null, pageUrl: "", leads: [], hasNext: false, hasNextSource: "none", totalHint: null, error: lastErr };
}

let exportLoopRunning = false;
async function runExportLoop(): Promise<void> {
  if (exportLoopRunning) return;
  exportLoopRunning = true;
  try {
    for (;;) {
      const job = await loadJob();
      if (!job || job.status !== "running") break;
      const settings = await getSettings();
      if (!settings.webhookUrl || job.tabId == null) {
        await commitJob(job, failJob(job, settings.webhookUrl ? "tab_missing" : "no_webhook", Date.now()));
        break;
      }
      const url = urlForPage(job.sourceUrl, job.page);
      try {
        const tab = await chrome.tabs.get(job.tabId).catch(() => null);
        if (!tab) throw new Error("tab_closed");
        if (!sameUrl(tab.url, url)) await navigateAndWait(job.tabId, url, 30_000);
      } catch (e) {
        await commitJob(job, failJob(job, e instanceof Error ? e.message : String(e), Date.now()));
        break;
      }
      await sleep(1200 + Math.random() * 800);
      // Re-check after every await: the user may have paused or stopped.
      if ((await loadJob())?.status !== "running") break;
      const res = await collectWithRetry(job.tabId, job.id, job.page);
      const fresh = await loadJob();
      if (!fresh || fresh.id !== job.id || fresh.status !== "running") break;
      if (!res.ok) {
        await commitJob(fresh, failJob(fresh, res.error ?? "collect_failed", Date.now()));
        break;
      }
      // Handshake: the content script must answer for THIS job and page, at
      // the exact search URL the job owns (filters included), or the page is
      // rejected rather than attributed to the job (NF-02).
      if (res.jobId !== fresh.id || res.expectedPage !== fresh.page || !sameUrl(res.pageUrl, url)) {
        await commitJob(fresh, failJob(fresh, "unexpected_navigation", Date.now()));
        break;
      }
      const leads = res.leads.slice(0, jobRemaining(fresh));
      let queued = 0, skipped = 0, capReached = false;
      if (leads.length) {
        const cap = await handleCapture({ type: "CAPTURE", leads, pageType: fresh.pageType, pageUrl: res.pageUrl, partial: true, importId: fresh.id, importKind: "export" });
        if (cap.rejectedReason === "no_webhook" || cap.rejectedReason === "invalid_url" || cap.rejectedReason === "invalid_message") {
          await commitJob(fresh, failJob(fresh, cap.rejectedReason, Date.now()));
          break;
        }
        queued = cap.queued;
        skipped = cap.skippedDuplicates.length;
        capReached = cap.rejectedReason === "daily_cap" || (cap.ok && cap.remainingToday === 0 && queued + skipped < leads.length);
      }
      // Commit the page with compare-and-swap; a pause/stop that landed during
      // capture wins and this page's transition is discarded.
      const latest = await loadJob();
      if (!latest || latest.id !== job.id || latest.status !== "running") break;
      const next = afterPage(latest, { rows: leads.length, queued, skipped, hasNext: res.hasNext, totalHint: res.totalHint, capReached }, Date.now());
      const committed = await commitJob(latest, next);
      if (!committed.ok || !committed.current || committed.current.status !== "running") break;
      await sleep(pageDelayMs(settings.exportPageDelayMinMs, settings.exportPageDelayMaxMs));
    }
  } catch (e) {
    const job = await loadJob();
    if (job && isActive(job)) await commitJob(job, failJob(job, e instanceof Error ? e.message : String(e), Date.now()));
  } finally {
    exportLoopRunning = false;
  }
}

async function startExport(url: string, limit: number, tabId: number | undefined): Promise<ExportStatusResponse & { error?: string }> {
  const pageType = exportablePageType(url);
  if (!pageType || !isAllowedPageUrl(url, TEST_BUILD)) return { job: null, history: await loadHistory(), error: "not_exportable_url" };
  const settings = await getSettings();
  if (!settings.webhookUrl) return { job: null, history: await loadHistory(), error: "no_webhook" };
  const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : settings.exportDefaultLimit;
  // Check-and-reserve atomically: the job row is written under the lock with
  // tabId null, so a concurrent start sees it and is refused (NF-01).
  const reserved = await withLock(async (): Promise<{ job: ExportJob } | { error: string; existing: ExportJob }> => {
    const existing = await loadJob();
    if (existing && isActive(existing)) return { error: "job_running", existing };
    const job = newJob(crypto.randomUUID(), url, pageType, lim, Date.now());
    await chrome.storage.local.set({ [KEYS.exportJob]: job });
    return { job };
  });
  if ("error" in reserved) return { job: reserved.existing, history: await loadHistory(), error: reserved.error };
  let job = reserved.job;
  void handleSearchCapture(job.sourceUrl, pageType, null);
  if (tabId == null) {
    try {
      const tab = await chrome.tabs.create({ url: urlForPage(job.sourceUrl, job.page), active: true });
      tabId = tab.id;
    } catch (e) {
      await commitJob(job, failJob(job, e instanceof Error ? e.message : "tab_create_failed", Date.now()));
      return { job: null, history: await loadHistory(), error: "tab_create_failed" };
    }
  }
  const committed = await commitJob(job, { ...job, tabId: tabId ?? null });
  if (!committed.ok || !committed.current) return { job: null, history: await loadHistory(), error: "job_running" };
  job = committed.current;
  await logEvent("export.started", `Export started: up to ${job.limit} results from ${searchName(url, pageType) ?? job.sourceUrl}`, { jobId: job.id, pageType, limit: job.limit, sourceUrl: job.sourceUrl, tabId: job.tabId });
  await chrome.alarms.create(EXPORT_ALARM, { periodInMinutes: 1 });
  void runExportLoop();
  return { job, history: await loadHistory() };
}

async function exportStatus(senderTabId?: number): Promise<ExportStatusResponse> {
  const job = await loadJob();
  const history = await loadHistory();
  const ref = job ?? history[0] ?? null;
  return { job, history, thisTab: !!ref && senderTabId != null && ref.tabId === senderTabId };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = await loadJob();
  if (job && isActive(job) && job.tabId === tabId) await commitJob(job, failJob(job, "tab_closed", Date.now()));
});

/* ------------------------------------------------------------ messages */

/** Popup/options pages, whether opened as the action popup or in a tab.
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
    switch (msg.type) {
      case "CAPTURE": {
        if (fromPage && (typeof msg.pageUrl !== "string" || !sameOrigin(msg.pageUrl, sender.tab?.url))) return { ok: false, queued: 0, skippedDuplicates: [], rejectedReason: "invalid_message", remainingToday: 0 } satisfies CaptureResponse;
        return handleCapture(msg);
      }
      case "GET_STATE":
        return fromExt ? getState() : { error: "forbidden" };
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
        await logEvent("queue.retried", "Retry requested from popup");
        await withLock(async () => {
          const items = (await loadQueue()).map((i) => (i.status === "pending" || i.status === "failed" ? { ...i, status: "pending" as const, nextAttemptAt: Date.now(), attempts: i.status === "failed" ? 0 : i.attempts } : i));
          await saveQueue(items);
        });
        await flush();
        return getState();
      }
      case "CLEAR_QUEUE": {
        if (!fromExt) return { error: "forbidden" };
        await withLock(async () => saveQueue(clearQueue(await loadQueue(), msg.status ?? "all", Date.now())));
        await logEvent("queue.cleared", `Queue cleared (${msg.status ?? "all"})`, { status: msg.status ?? "all" });
        return getState();
      }
      case "TEST_WEBHOOK":
        return fromExt ? testWebhook() : { error: "forbidden" };
      case "SEARCH_CAPTURE":
        if (fromPage && !sameOrigin(msg.url, sender.tab?.url)) return { ok: false, queued: false, duplicate: false, rejectedReason: "invalid_message" };
        return handleSearchCapture(msg.url, msg.pageType, msg.totalHint);
      case "EXPORT_START": {
        // Reuse the sender's tab only when the request comes from the content
        // script on that page; the popup (or a test page) must not be navigated.
        if (fromPage && !sameOrigin(msg.url, sender.tab?.url)) return { job: null, history: [], error: "not_exportable_url" };
        return startExport(String(msg.url ?? ""), Number(msg.limit), fromPage ? tabId : typeof msg.tabId === "number" ? msg.tabId : undefined);
      }
      case "EXPORT_PAUSE":
        await transitionJob((j) => pauseJob(j, Date.now()));
        return exportStatus(tabId);
      case "EXPORT_RESUME":
        await transitionJob((j) => resumeJob(j, Date.now()));
        void runExportLoop();
        return exportStatus(tabId);
      case "EXPORT_STOP":
        await transitionJob((j) => stopJob(j, Date.now()));
        return exportStatus(tabId);
      case "EXPORT_STATUS":
        return exportStatus(tabId);
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

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void flush();
  if (a.name === EXPORT_ALARM) void runExportLoop(); // watchdog: resumes a job if the worker was suspended mid-run
});
chrome.runtime.onStartup.addListener(() => {
  void flush();
  void runExportLoop();
});
chrome.runtime.onInstalled.addListener(() => void flush());
// A fresh worker instance (after suspension) also recovers leases and jobs.
void flush();
void runExportLoop();

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "send-current") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SEND_CURRENT" }).catch(() => undefined);
});

export type { PageType, LeadRecord, Settings };
