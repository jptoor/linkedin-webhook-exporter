declare const __EXTENSION_VERSION__: string;

import { buildBodies, buildSearchBody } from "../shared/mapping";
import { buildSearchRecord, searchKey, searchName } from "../shared/search";
import type { CaptureResponse, ContentToBackground, StateResponse } from "../shared/messages";
import { dedupeKey } from "../shared/normalize";
import { getSettings, validateWebhookUrl } from "../shared/settings";
import type { ImportInfo, LeadRecord, PageType, QueueItem, Settings, SourceInfo } from "../shared/types";
import { afterAttempt, due, filterByStatus, newItem, nextWake, prune } from "./queue";
import { sendBody } from "./sender";
import { afterPage, exportablePageType, fail as failJob, isActive, newJob, pageDelayMs, pause as pauseJob, remaining as jobRemaining, resume as resumeJob, stop as stopJob, urlForPage, type ExportJob } from "../shared/export-job";
import type { BackgroundToContent, CollectResponse, ExportStatusResponse } from "../shared/messages";

const VERSION = typeof __EXTENSION_VERSION__ === "string" ? __EXTENSION_VERSION__ : "dev";
const ALARM = "lwe-flush";
const KEYS = { queue: "queue", dedupe: "dedupe", daily: "daily", exportJob: "exportJob", exportHistory: "exportHistory" } as const;
const EXPORT_ALARM = "lwe-export-watchdog";

type DedupeMap = Record<string, number>; // key -> sentAt ms
interface Daily { day: string; count: number }

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadQueue(): Promise<QueueItem[]> {
  return ((await chrome.storage.local.get(KEYS.queue))[KEYS.queue] as QueueItem[] | undefined) ?? [];
}
async function saveQueue(items: QueueItem[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.queue]: items });
  await scheduleAlarm(items);
}
async function loadDedupe(): Promise<DedupeMap> {
  return ((await chrome.storage.local.get(KEYS.dedupe))[KEYS.dedupe] as DedupeMap | undefined) ?? {};
}
async function saveDedupe(map: DedupeMap): Promise<void> {
  await chrome.storage.local.set({ [KEYS.dedupe]: map });
}
async function loadDaily(): Promise<Daily> {
  const d = (await chrome.storage.local.get(KEYS.daily))[KEYS.daily] as Daily | undefined;
  return d && d.day === today() ? d : { day: today(), count: 0 };
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
  for (const [k, t] of Object.entries(map)) if (now - t < ttl) out[k] = t;
  return out;
}

async function handleCapture(msg: Extract<ContentToBackground, { type: "CAPTURE" }> & { partial?: boolean }): Promise<CaptureResponse> {
  const settings = await getSettings();
  const now = Date.now();
  const daily = await loadDaily();
  const remaining = Math.max(0, settings.dailyCap - daily.count);
  const base = { ok: false, queued: 0, skippedDuplicates: [] as string[], rejectedReason: null as CaptureResponse["rejectedReason"], remainingToday: remaining };

  if (!settings.webhookUrl) return { ...base, rejectedReason: "no_webhook" };
  if (!validateWebhookUrl(settings.webhookUrl).ok) return { ...base, rejectedReason: "invalid_url" };

  let leads = msg.leads.filter((l) => l.full_name);
  const skipped: string[] = [];
  let dedupe = activeDedupe(await loadDedupe(), settings.dedupeTtlDays, now);
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
  if (!leads.length) return { ...base, skippedDuplicates: skipped, rejectedReason: skipped.length ? null : "nothing_to_send", ok: skipped.length > 0 };
  if (leads.length > remaining) {
    // Bulk export sends what the cap still allows and reports the truncation;
    // interactive capture is all-or-nothing so the rep sees a clear message.
    if (!msg.partial || remaining === 0) return { ...base, skippedDuplicates: skipped, rejectedReason: "daily_cap" };
    leads = leads.slice(0, remaining);
  }

  const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: VERSION, page_type: msg.pageType, page_url: msg.pageUrl, captured_by: settings.capturedBy || null };
  const isList = msg.pageType === "salesnav_search" || msg.pageType === "salesnav_list" || msg.pageType === "people_search";
  const rec = isList ? buildSearchRecord(msg.pageUrl, msg.pageType, null, "") : null;
  const imp: ImportInfo = {
    import_id: msg.importId ?? crypto.randomUUID(),
    imported_by: settings.capturedBy || null,
    imported_at: new Date(now).toISOString(),
    import_kind: msg.importKind ?? "manual",
    search_url: isList ? searchKey(msg.pageUrl) : null,
    search_name: isList ? searchName(msg.pageUrl, msg.pageType, msg.pageTitle) : null,
    list_id: rec?.list_id ?? null,
    page: rec?.page ?? null
  };
  const bodies = buildBodies(leads, { preset: settings.mappingPreset, mode: settings.sendMode, source, custom: settings.customFields, eventId: () => crypto.randomUUID(), sentAt: new Date(now).toISOString(), import: imp });

  const queue = await loadQueue();
  for (const b of bodies) {
    const keys = b.leads.map(dedupeKey);
    const idem = !msg.force && b.leads.length === 1 ? keys[0] : b.eventId;
    queue.push(newItem(b.eventId, JSON.stringify(b.body), keys, b.leads.length, now, idem));
  }
  for (const l of leads) dedupe[dedupeKey(l)] = now;
  await saveDedupe(dedupe);
  await saveDaily({ day: daily.day, count: daily.count + leads.length });
  await saveQueue(prune(queue, now));
  void flush();
  return { ok: true, queued: leads.length, skippedDuplicates: skipped, rejectedReason: null, remainingToday: remaining - leads.length };
}

let flushing = false;
async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const settings = await getSettings();
    if (!settings.webhookUrl) return;
    let items = await loadQueue();
    const now = Date.now();
    for (const item of due(items, now)) {
      items = items.map((i) => (i.id === item.id ? { ...i, status: "sending" } : i));
      await chrome.storage.local.set({ [KEYS.queue]: items });
      const result = await sendBody(settings, item.body, item.id, { version: VERSION, dedupeKey: item.dedupeKey ?? item.id });
      const updated = afterAttempt({ ...item, status: "pending" }, result, Date.now());
      items = items.map((i) => (i.id === item.id ? updated : i));
      await chrome.storage.local.set({ [KEYS.queue]: items });
    }
    await saveQueue(prune(items, Date.now()));
  } finally {
    flushing = false;
  }
}

async function handleSearchCapture(url: string, pageType: PageType, totalHint: number | null, force = false): Promise<{ ok: boolean; queued: boolean; duplicate: boolean; rejectedReason: CaptureResponse["rejectedReason"] }> {
  const settings = await getSettings();
  if (!settings.webhookUrl) return { ok: false, queued: false, duplicate: false, rejectedReason: "no_webhook" };
  if (!validateWebhookUrl(settings.webhookUrl).ok) return { ok: false, queued: false, duplicate: false, rejectedReason: "invalid_url" };
  const now = Date.now();
  const key = `search:${searchKey(url).toLowerCase()}`;
  const dedupe = activeDedupe(await loadDedupe(), settings.dedupeTtlDays, now);
  if (settings.dedupe && !force && dedupe[key]) return { ok: true, queued: false, duplicate: true, rejectedReason: null };
  const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: VERSION, page_type: pageType, page_url: url, captured_by: settings.capturedBy || null };
  const eventId = crypto.randomUUID();
  const body = buildSearchBody(buildSearchRecord(url, pageType, totalHint, new Date(now).toISOString()), settings.mappingPreset, source, settings.customFields, eventId, new Date(now).toISOString());
  const queue = await loadQueue();
  queue.push(newItem(eventId, JSON.stringify(body), [key], 0, now, key));
  dedupe[key] = now;
  await saveDedupe(dedupe);
  await saveQueue(prune(queue, now));
  void flush();
  return { ok: true, queued: true, duplicate: false, rejectedReason: null };
}

async function getState(): Promise<StateResponse> {
  const [settings, queue, daily, dedupe] = await Promise.all([getSettings(), loadQueue(), loadDaily(), loadDedupe()]);
  return { settings, queue: queue.slice().sort((a, b) => b.createdAt - a.createdAt), exportJob: await loadJob(), sentToday: daily.count, remainingToday: Math.max(0, settings.dailyCap - daily.count), dedupeCount: Object.keys(activeDedupe(dedupe, settings.dedupeTtlDays, Date.now())).length };
}

async function testWebhook(): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const settings = await getSettings();
  if (!settings.webhookUrl) return { ok: false, status: null, error: "No webhook URL configured" };
  const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: VERSION, page_type: "profile", page_url: "https://www.linkedin.com/in/test-connection", captured_by: settings.capturedBy || null };
  const eventId = crypto.randomUUID();
  const body = JSON.stringify({ schema_version: "1", event: "test", event_id: eventId, sent_at: new Date().toISOString(), source, custom: settings.customFields });
  const r = await sendBody(settings, body, eventId, { version: VERSION, timeoutMs: 10_000 });
  return { ok: r.ok, status: r.status, error: r.error };
}


/* ---------------- Bulk export: walk every page of a search ---------------- */

async function loadJob(): Promise<ExportJob | null> {
  return ((await chrome.storage.local.get(KEYS.exportJob))[KEYS.exportJob] as ExportJob | undefined) ?? null;
}
async function saveJob(job: ExportJob | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.exportJob]: job });
}
async function loadHistory(): Promise<ExportJob[]> {
  return ((await chrome.storage.local.get(KEYS.exportHistory))[KEYS.exportHistory] as ExportJob[] | undefined) ?? [];
}
async function archiveJob(job: ExportJob): Promise<void> {
  const h = [job, ...(await loadHistory())].slice(0, 20);
  await chrome.storage.local.set({ [KEYS.exportHistory]: h, [KEYS.exportJob]: null });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id: number, info: { status?: string }) {
      if (id === tabId && info.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function collectWithRetry(tabId: number, jobId: string, page: number, attempts = 8): Promise<CollectResponse> {
  let lastErr = "content script did not answer";
  for (let i = 0; i < attempts; i++) {
    try {
      const msg: BackgroundToContent = { type: "EXPORT_COLLECT", jobId, expectedPage: page };
      const res = (await chrome.tabs.sendMessage(tabId, msg)) as CollectResponse | undefined;
      if (res) return res;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000);
  }
  return { ok: false, pageType: null, pageUrl: "", leads: [], hasNext: false, totalHint: null, error: lastErr };
}

function sameUrl(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname && (x.searchParams.get("page") ?? "1") === (y.searchParams.get("page") ?? "1");
  } catch {
    return false;
  }
}

let exportLoopRunning = false;
async function runExportLoop(): Promise<void> {
  if (exportLoopRunning) return;
  exportLoopRunning = true;
  try {
    for (;;) {
      let job = await loadJob();
      if (!job || job.status !== "running") break;
      const settings = await getSettings();
      if (!settings.webhookUrl || job.tabId == null) {
        await saveJob(failJob(job, settings.webhookUrl ? "tab_missing" : "no_webhook", Date.now()));
        break;
      }
      const tab = await chrome.tabs.get(job.tabId).catch(() => null);
      if (!tab) {
        await saveJob(failJob(job, "tab_closed", Date.now()));
        break;
      }
      const url = urlForPage(job.sourceUrl, job.page);
      if (!sameUrl(tab.url, url)) {
        await chrome.tabs.update(job.tabId, { url });
        await waitForTabComplete(job.tabId, 30_000);
      }
      await sleep(1200 + Math.random() * 800);
      const res = await collectWithRetry(job.tabId, job.id, job.page);
      job = (await loadJob()) ?? job; // user may have paused/stopped meanwhile
      if (job.status !== "running") break;
      if (!res.ok) {
        await saveJob(failJob(job, res.error ?? "collect_failed", Date.now()));
        break;
      }
      const leads = res.leads.slice(0, jobRemaining(job));
      let queued = 0, skipped = 0, capReached = false;
      if (leads.length) {
        const cap = await handleCapture({ type: "CAPTURE", leads, pageType: job.pageType, pageUrl: res.pageUrl, partial: true, importId: job.id, importKind: "export" });
        if (cap.rejectedReason === "no_webhook" || cap.rejectedReason === "invalid_url") {
          await saveJob(failJob(job, cap.rejectedReason, Date.now()));
          break;
        }
        queued = cap.queued;
        skipped = cap.skippedDuplicates.length;
        capReached = cap.rejectedReason === "daily_cap" || (cap.ok && cap.remainingToday === 0 && queued + skipped < leads.length);
      }
      job = afterPage(job, { rows: leads.length, queued, skipped, hasNext: res.hasNext, totalHint: res.totalHint, capReached }, Date.now());
      await saveJob(job);
      if (job.status !== "running") break;
      await sleep(pageDelayMs(settings.exportPageDelayMinMs, settings.exportPageDelayMaxMs));
    }
  } catch (e) {
    const job = await loadJob();
    if (job && isActive(job)) await saveJob(failJob(job, e instanceof Error ? e.message : String(e), Date.now()));
  } finally {
    exportLoopRunning = false;
    const job = await loadJob();
    if (job && !isActive(job)) {
      await archiveJob(job);
      await chrome.alarms.clear(EXPORT_ALARM);
    }
  }
}

async function startExport(url: string, limit: number, tabId: number | undefined): Promise<ExportStatusResponse & { error?: string }> {
  const pageType = exportablePageType(url);
  const existing = await loadJob();
  if (existing && isActive(existing)) return { job: existing, history: await loadHistory(), error: "job_running" };
  if (!pageType) return { job: null, history: await loadHistory(), error: "not_exportable_url" };
  const settings = await getSettings();
  if (!settings.webhookUrl) return { job: null, history: await loadHistory(), error: "no_webhook" };
  let job = newJob(crypto.randomUUID(), url, pageType, limit || settings.exportDefaultLimit, Date.now());
  void handleSearchCapture(job.sourceUrl, pageType, null);
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: urlForPage(job.sourceUrl, job.page), active: true });
    tabId = tab.id;
  }
  job = { ...job, tabId: tabId ?? null };
  await saveJob(job);
  await chrome.alarms.create(EXPORT_ALARM, { periodInMinutes: 1 });
  void runExportLoop();
  return { job, history: await loadHistory() };
}

async function exportStatus(senderTabId?: number): Promise<ExportStatusResponse & { thisTab: boolean }> {
  const job = await loadJob();
  const history = await loadHistory();
  const ref = job ?? history[0] ?? null;
  return { job, history, thisTab: !!ref && senderTabId != null && ref.tabId === senderTabId };
}

chrome.runtime.onMessage.addListener((msg: ContentToBackground, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "CAPTURE":
        return handleCapture(msg);
      case "GET_STATE":
        return getState();
      case "GET_SETTINGS":
        return getSettings();
      case "CHECK_DEDUPE": {
        const s = await getSettings();
        const map = activeDedupe(await loadDedupe(), s.dedupeTtlDays, Date.now());
        return Object.fromEntries(msg.keys.map((k) => [k, !!map[k]]));
      }
      case "RETRY_NOW": {
        const items = (await loadQueue()).map((i) => (i.status === "pending" || i.status === "failed" ? { ...i, status: "pending" as const, nextAttemptAt: Date.now(), attempts: i.status === "failed" ? 0 : i.attempts } : i));
        await saveQueue(items);
        await flush();
        return getState();
      }
      case "CLEAR_QUEUE": {
        await saveQueue(filterByStatus(await loadQueue(), msg.status ?? "all"));
        return getState();
      }
      case "TEST_WEBHOOK":
        return testWebhook();
      case "SEARCH_CAPTURE":
        return handleSearchCapture(msg.url, msg.pageType, msg.totalHint);
      case "EXPORT_START": {
        // Reuse the sender's tab only when the request comes from the content
        // script on that page; the popup (or a test page) must not be navigated.
        const fromPage = _sender.tab?.id != null && !!_sender.url && !_sender.url.startsWith("chrome-extension://");
        return startExport(msg.url, msg.limit, msg.tabId ?? (fromPage ? _sender.tab!.id : undefined));
      }
      case "EXPORT_PAUSE": {
        const j = await loadJob();
        if (j) await saveJob(pauseJob(j, Date.now()));
        return exportStatus(_sender.tab?.id);
      }
      case "EXPORT_RESUME": {
        const j = await loadJob();
        if (j) {
          await saveJob(resumeJob(j, Date.now()));
          void runExportLoop();
        }
        return exportStatus(_sender.tab?.id);
      }
      case "EXPORT_STOP": {
        const j = await loadJob();
        if (j) {
          const stopped = stopJob(j, Date.now());
          await saveJob(stopped);
          if (!exportLoopRunning) {
            await archiveJob(stopped);
            await chrome.alarms.clear(EXPORT_ALARM);
          }
        }
        return exportStatus(_sender.tab?.id);
      }
      case "EXPORT_STATUS":
        return exportStatus(_sender.tab?.id);
      default:
        return { error: "unknown message" };
    }
  })().then(sendResponse, (e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void flush();
  if (a.name === EXPORT_ALARM) void runExportLoop(); // watchdog: resumes a job if the worker was suspended mid-run
});
chrome.runtime.onStartup.addListener(() => {
  void flush();
  void runExportLoop();
});
chrome.runtime.onInstalled.addListener(() => void flush());

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "send-current") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "SEND_CURRENT" }).catch(() => undefined);
});

export type { PageType, LeadRecord, Settings };
