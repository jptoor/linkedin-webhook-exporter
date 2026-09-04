import { parseTotalHint, type ExportJob } from "../shared/export-job";
import type { BackgroundToContent, CaptureResponse, CollectResponse, ContentSettingsResponse, ExportStatusResponse } from "../shared/messages";
import { dedupeKey } from "../shared/normalize";
import { isSensitiveParam } from "../shared/search";
import type { LeadRecord, PageType } from "../shared/types";
import { detectPageType, isListPage, listRows, parsePage, parsePeopleSearchRow, parseSalesNavRow } from "./parsers";
import { mountExportControls, mountPanel, toast, type PanelHandles } from "./ui";

const send = <T,>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;
const NEW_ID = () => crypto.randomUUID();

function describeRejection(r: CaptureResponse): string {
  switch (r.rejectedReason) {
    case "no_webhook":
      return "No webhook configured. Open the extension options.";
    case "invalid_url":
      return "Webhook URL must be https://. Fix it in options.";
    case "daily_cap":
      return `Daily cap reached (${r.remainingToday} left). Raise it in options if you accept the risk.`;
    case "nothing_to_send":
      return "Nothing to send: could not read a name from this page.";
    case "invalid_message":
      return "This page is not a supported LinkedIn page.";
    default:
      return "Rejected.";
  }
}

function summarize(r: CaptureResponse): { text: string; kind: "ok" | "err" | "warn" } {
  if (!r.ok) return { text: describeRejection(r), kind: "err" };
  const parts: string[] = [];
  if (r.queued) parts.push(`Queued ${r.queued}`);
  if (r.skippedDuplicates.length) parts.push(`${r.skippedDuplicates.length} already sent (skipped)`);
  parts.push(`${r.remainingToday} left today`);
  return { text: parts.join(" · "), kind: r.queued ? "ok" : "warn" };
}

async function getSettings(): Promise<ContentSettingsResponse> {
  return send<ContentSettingsResponse>({ type: "GET_CONTENT_SETTINGS" });
}

/* ---------- mount lifecycle ---------- */

/** Everything a page mount owns, so navigation can tear it down completely. */
interface Mount {
  dispose(): void;
  sendCurrent?: () => void;
}
let active: Mount | null = null;

/* ---------- single-record pages (profile, Sales Nav lead) ---------- */

async function setupSinglePage(pageType: PageType): Promise<Mount> {
  const panel = mountPanel(document, "LinkedIn Webhook Exporter", "Send to webhook", "Resend");
  panel.secondary.textContent = "Force resend";
  let alive = true;
  // Attach handlers before any async work so an early click is never lost.
  const doSend = async (force: boolean) => {
    panel.primary.disabled = true;
    panel.setStatus("Reading page…");
    const settings = await getSettings();
    if (!alive) return;
    const { leads } = parsePage(document, location.href, { includeExperience: settings.includeExperience, includeEducation: settings.includeEducation, includeAbout: settings.includeAbout });
    const lead = leads[0];
    if (!lead || !lead.full_name) {
      panel.setStatus("Could not read a name from this page. LinkedIn may have changed its layout.", "err");
      panel.primary.disabled = false;
      return;
    }
    const res = await send<CaptureResponse>({ type: "CAPTURE", leads: [lead], pageType, pageUrl: location.href, force, importId: NEW_ID(), importKind: "manual", pageTitle: document.title });
    if (!alive) return;
    const s = summarize(res);
    panel.setStatus(lead.parse_warnings.length && s.kind === "ok" ? `${s.text} · check: ${lead.parse_warnings.join(", ")}` : s.text, s.kind);
    panel.primary.disabled = false;
  };
  panel.primary.addEventListener("click", () => void doSend(false));
  panel.secondary.addEventListener("click", () => void doSend(true));
  // Show whether this profile was already sent.
  const { leads } = parsePage(document, location.href, { includeExperience: false, includeEducation: false, includeAbout: false });
  if (leads[0]?.full_name) {
    const key = dedupeKey(leads[0]);
    const seen = await send<Record<string, boolean>>({ type: "CHECK_DEDUPE", keys: [key] });
    if (alive && seen[key]) panel.setStatus("Already sent. Use Force resend to send again.", "warn");
  }
  return {
    dispose: () => {
      alive = false;
      panel.dispose();
    },
    sendCurrent: () => void doSend(false)
  };
}

/* ---------- list pages (Sales Nav search/list, people search) ---------- */

interface RowState {
  el: HTMLElement;
  box: HTMLInputElement;
}

function parseRow(row: HTMLElement, pageType: PageType, now: string): LeadRecord | null {
  return pageType === "people_search" ? parsePeopleSearchRow(row, now) : parseSalesNavRow(row, now);
}

async function setupListPage(pageType: PageType): Promise<Mount> {
  const panel: PanelHandles = mountPanel(document, "LinkedIn Webhook Exporter", "Send 0 selected", "Select all on page");
  const rows = new Map<HTMLElement, RowState>();
  let alive = true;
  const disposers: Array<() => void> = [() => (alive = false), () => panel.dispose()];

  const refreshCount = () => {
    const n = Array.from(rows.values()).filter((r) => r.box.checked).length;
    panel.primary.textContent = `Send ${n} selected`;
    panel.primary.disabled = n === 0;
  };

  let decorating = false;
  const decorate = async () => {
    if (decorating || !alive) return;
    decorating = true;
    try {
      const found = listRows(document, pageType);
      const now = new Date().toISOString();
      const keys: string[] = [];
      for (const el of found) {
        if (rows.has(el)) continue;
        const lead = parseRow(el, pageType, now);
        if (!lead) continue;
        el.classList.add("lwe-row-host");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.className = "lwe-check";
        box.setAttribute("data-lwe-row-check", "");
        box.setAttribute("aria-label", `Select ${lead.full_name} for webhook`);
        box.title = "Select for webhook";
        box.addEventListener("change", refreshCount);
        el.prepend(box);
        rows.set(el, { el, box });
        keys.push(dedupeKey(lead));
      }
      // Rows LinkedIn removed (virtualized lists) are dropped from the map.
      for (const [el, st] of rows) {
        if (!el.isConnected) {
          rows.delete(el);
          st.box.remove();
        }
      }
      if (keys.length) {
        const seen = await send<Record<string, boolean>>({ type: "CHECK_DEDUPE", keys });
        if (!alive) return; // navigated away while waiting
        for (const [el, st] of rows) {
          const lead = parseRow(el, pageType, now);
          if (lead && seen[dedupeKey(lead)]) {
            st.el.classList.add("lwe-sent");
            st.box.title = "Already sent";
          }
        }
      }
      refreshCount();
      panel.title.textContent = `LinkedIn Webhook Exporter · ${rows.size} on page`;
    } finally {
      decorating = false;
    }
  };

  panel.secondary.addEventListener("click", () => {
    const all = Array.from(rows.values());
    const anyUnchecked = all.some((r) => !r.box.checked);
    for (const r of all) r.box.checked = anyUnchecked;
    panel.secondary.textContent = anyUnchecked ? "Clear selection" : "Select all on page";
    refreshCount();
  });

  panel.primary.addEventListener("click", async () => {
    const now = new Date().toISOString();
    const selected = Array.from(rows.values()).filter((r) => r.box.checked);
    const leads = selected.map((r) => parseRow(r.el, pageType, now)).filter((l): l is LeadRecord => !!l);
    if (!leads.length) return;
    panel.primary.disabled = true;
    panel.setStatus(`Sending ${leads.length}…`);
    const res = await send<CaptureResponse>({ type: "CAPTURE", leads, pageType, pageUrl: location.href, importId: NEW_ID(), importKind: "manual", pageTitle: document.title });
    if (!alive) return;
    const s = summarize(res);
    panel.setStatus(s.text, s.kind);
    if (res.ok) {
      for (const r of selected) {
        r.box.checked = false;
        r.el.classList.add("lwe-sent");
      }
      disposers.push(toast(document, s.text));
    }
    refreshCount();
  });

  await decorate();
  await setupExportControls(panel, pageType, disposers);
  // LinkedIn renders lists incrementally and on scroll; observe the results
  // container (not the whole body) for new rows, debounced.
  const container = document.querySelector("#search-results-container, main") ?? document.body;
  let debounce: number | null = null;
  const mo = new MutationObserver(() => {
    if (debounce != null) clearTimeout(debounce);
    debounce = window.setTimeout(() => void decorate(), 300);
  });
  mo.observe(container, { childList: true, subtree: true });
  disposers.push(() => {
    mo.disconnect();
    if (debounce != null) clearTimeout(debounce);
    for (const st of rows.values()) {
      st.box.remove();
      st.el.classList.remove("lwe-row-host", "lwe-sent");
    }
    rows.clear();
  });
  return { dispose: () => disposers.splice(0).forEach((d) => d()) };
}

/* ---------- bulk export: collect one page on request ---------- */

function resultsScroller(): HTMLElement {
  const candidates = ["#search-results-container", ".search-results-container", "main"];
  for (const sel of candidates) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.scrollHeight > el.clientHeight + 50) return el;
  }
  return document.scrollingElement as HTMLElement;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sales Navigator renders rows lazily as you scroll (only on real/smooth
 *  scrolling). Scroll in steps, wait for the scroll position to settle and
 *  for the DOM to be quiet, and stop when the row count is stable at the
 *  bottom. Bounded by time and iterations. */
async function autoScroll(pageType: PageType, maxMs = 25_000): Promise<void> {
  const el = resultsScroller();
  const started = Date.now();
  let stable = 0;
  let last = -1;
  let lastMutation = Date.now();
  const mo = new MutationObserver(() => (lastMutation = Date.now()));
  mo.observe(el, { childList: true, subtree: true });
  try {
    for (let i = 0; i < 60 && stable < 3 && Date.now() - started < maxMs; i++) {
      const target = Math.min(el.scrollHeight, el.scrollTop + Math.max(400, el.clientHeight * 0.8));
      el.scrollTo({ top: target, behavior: "smooth" });
      // Wait for the smooth scroll to settle.
      let prev = -1;
      for (let k = 0; k < 20 && el.scrollTop !== prev; k++) {
        prev = el.scrollTop;
        await wait(100);
      }
      // Quiet period: no DOM mutations for 500 ms (lazy rows finished rendering).
      for (let k = 0; k < 20 && Date.now() - lastMutation < 500; k++) await wait(100);
      const n = listRows(document, pageType).length;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 5;
      stable = n === last && atBottom ? stable + 1 : 0;
      last = n;
    }
  } finally {
    mo.disconnect();
    el.scrollTo({ top: 0 });
  }
}

/** Next-page decision. A real pagination control is authoritative; the row
 *  count is only a fallback and is reported as such so the export job can
 *  stop on an empty page rather than trusting a guess. */
function detectHasNext(rowCount: number, pageType: PageType): { hasNext: boolean; source: "control" | "row_count" | "none" } {
  const next = document.querySelector<HTMLButtonElement>('[data-lwe="next-page"], button[aria-label="Next"], button.artdeco-pagination__button--next, a[aria-label="Next"], button[aria-label="Weiter"], button[aria-label="Suivant"]');
  if (next) return { hasNext: !next.disabled && next.getAttribute("aria-disabled") !== "true", source: "control" };
  // LinkedIn people search shows 10 per page; Sales Navigator shows 25.
  const pageSize = pageType === "people_search" ? 10 : 25;
  return rowCount >= pageSize ? { hasNext: true, source: "row_count" } : { hasNext: false, source: "none" };
}

function detectTotalHint(): number | null {
  const el = document.querySelector<HTMLElement>('[data-lwe="results-count"], .search-results__total, h2.t-14, .artdeco-pagination__page-state');
  return parseTotalHint(el?.textContent ?? null);
}

async function collectPage(jobId: string, expectedPage: number): Promise<CollectResponse> {
  const pageType = detectPageType(location.pathname);
  const base = { jobId, expectedPage, pageType, pageUrl: location.href, leads: [] as LeadRecord[], hasNext: false, hasNextSource: "none" as const, totalHint: null };
  if (!pageType || !isListPage(pageType)) return { ...base, ok: false, error: "not_a_list_page" };
  await autoScroll(pageType);
  // The page may have navigated during the scroll; report the URL we parsed.
  const pageUrl = location.href;
  const { leads } = parsePage(document, pageUrl);
  const next = detectHasNext(leads.length, pageType);
  return { ...base, ok: true, pageUrl, leads, hasNext: next.hasNext, hasNextSource: next.source, totalHint: detectTotalHint(), error: null };
}

function describeJob(job: ExportJob): string {
  const base = `Page ${job.pagesDone}${job.totalHint ? ` of ~${Math.min(100, Math.ceil(job.totalHint / 25))}` : ""} · ${job.collected} collected · ${job.sent} sent · ${job.skipped} already sent`;
  switch (job.status) {
    case "running":
      return `Exporting… ${base}`;
    case "paused":
      return `Paused. ${base}`;
    case "done":
      return `Done (${job.stopReason === "limit" ? "limit reached" : "no more results"}). ${base}`;
    case "stopped":
      return `Stopped${job.stopReason === "daily_cap" ? " at daily cap" : ""}. ${base}`;
    case "error":
      return `Failed: ${job.lastError}. ${base}`;
  }
}

async function setupExportControls(panel: PanelHandles, pageType: PageType, disposers: Array<() => void>): Promise<void> {
  const settings = await getSettings();
  if (!panel.host.isConnected) return; // torn down while settings loaded
  const ctl = mountExportControls(panel, settings.exportDefaultLimit);
  let timer: number | null = null;
  const stopTimer = () => {
    if (timer != null) clearInterval(timer);
    timer = null;
  };
  disposers.push(stopTimer);

  const render = (st: ExportStatusResponse) => {
    if (!panel.host.isConnected) return stopTimer();
    // Show the finished job too, but only on the tab it ran in.
    const job = st.job ?? (st.thisTab ? st.history[0] ?? null : null);
    const isActive = !!job && (job.status === "running" || job.status === "paused");
    ctl.form.hidden = isActive;
    ctl.progress.hidden = !job;
    if (job) {
      ctl.progressText.textContent = describeJob(job);
      ctl.pause.hidden = !isActive;
      ctl.pause.textContent = job.status === "paused" ? "Resume" : "Pause";
      ctl.stopBtn.hidden = !isActive;
    }
    if (isActive && timer == null) timer = window.setInterval(poll, 2000);
    if (!isActive) stopTimer();
  };
  const poll = async () => {
    if (!panel.host.isConnected) return stopTimer();
    render(await send<ExportStatusResponse>({ type: "EXPORT_STATUS" }));
  };

  ctl.start.addEventListener("click", async () => {
    const limit = Math.max(1, Math.min(2500, Number(ctl.limit.value) || settings.exportDefaultLimit));
    const st = await send<ExportStatusResponse & { error?: string }>({ type: "EXPORT_START", url: location.href, limit });
    if (!panel.host.isConnected) return;
    if (st.error) {
      panel.setStatus(st.error === "no_webhook" ? "No webhook configured. Open the extension options." : st.error === "job_running" ? "Another export is already running." : `Cannot export: ${st.error}`, "err");
      return;
    }
    render(st);
  });
  ctl.pause.addEventListener("click", async () => {
    const st = await send<ExportStatusResponse>({ type: "EXPORT_STATUS" });
    render(await send<ExportStatusResponse>({ type: st.job?.status === "paused" ? "EXPORT_RESUME" : "EXPORT_PAUSE" }));
  });
  ctl.stopBtn.addEventListener("click", async () => render(await send<ExportStatusResponse>({ type: "EXPORT_STOP" })));
  ctl.saveSearch.addEventListener("click", async () => {
    const r = await send<{ ok: boolean; queued: boolean; duplicate: boolean; rejectedReason: CaptureResponse["rejectedReason"] }>({ type: "SEARCH_CAPTURE", url: location.href, pageType, totalHint: detectTotalHint() });
    if (!r.ok) panel.setStatus(r.rejectedReason === "no_webhook" ? "No webhook configured. Open the extension options." : "Could not save search.", "err");
    else panel.setStatus(r.duplicate ? "Search already saved." : "Search saved to webhook.", r.duplicate ? "warn" : "ok");
  });
  await poll();
}

/* ---------- single global message listener ---------- */

chrome.runtime.onMessage.addListener((m: BackgroundToContent, _s, sendResponse) => {
  if (m?.type === "EXPORT_COLLECT") {
    collectPage(String(m.jobId), Number(m.expectedPage)).then(sendResponse, (e) => sendResponse({ ok: false, jobId: String(m.jobId), expectedPage: Number(m.expectedPage), pageType: null, pageUrl: location.href, leads: [], hasNext: false, hasNextSource: "none", totalHint: null, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }
  if (m?.type === "SEND_CURRENT") active?.sendCurrent?.();
  return false;
});

/* ---------- navigation controller ---------- */

/** Route identity: path + query minus session/tracking params, so a new
 *  search on the same path remounts, while a sessionId refresh does not. */
function routeKey(): string {
  const u = new URL(location.href);
  const parts = Array.from(u.searchParams.entries())
    .filter(([k]) => !isSensitiveParam(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return `${u.pathname}?${parts.join("&")}`;
}

let currentRoute = "";
let mounting: Promise<void> | null = null;
function boot(): void {
  const key = routeKey();
  if (key === currentRoute) return;
  currentRoute = key;
  const run = async () => {
    active?.dispose();
    active = null;
    const pageType = detectPageType(location.pathname);
    if (!pageType) return;
    const mount = isListPage(pageType) ? await setupListPage(pageType) : await setupSinglePage(pageType);
    // A navigation during setup wins: tear down what we just built.
    if (routeKey() !== key) mount.dispose();
    else active = mount;
  };
  mounting = (mounting ?? Promise.resolve()).then(run, run);
}

boot();
// LinkedIn is a single-page app; watch every way the route can change.
for (const method of ["pushState", "replaceState"] as const) {
  const orig = history[method].bind(history);
  history[method] = (...args: Parameters<History["pushState"]>) => {
    orig(...args);
    setTimeout(boot, 400);
  };
}
window.addEventListener("popstate", () => setTimeout(boot, 400));
setInterval(() => {
  if (routeKey() !== currentRoute) boot();
}, 1500);
