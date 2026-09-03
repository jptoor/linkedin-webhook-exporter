import { parseTotalHint, type ExportJob } from "../shared/export-job";
import type { BackgroundToContent, CaptureResponse, CollectResponse, ExportStatusResponse } from "../shared/messages";
import { dedupeKey } from "../shared/normalize";
import type { LeadRecord, PageType, Settings } from "../shared/types";
import { detectPageType, isListPage, listRows, parsePage, parsePeopleSearchRow, parseSalesNavRow } from "./parsers";
import { mountExportControls, mountPanel, toast, type PanelHandles } from "./ui";

const send = <T,>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

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
    default:
      return "Rejected.";
  }
}

function summarize(r: CaptureResponse): { text: string; kind: "ok" | "err" | "warn" } {
  if (!r.ok) return { text: describeRejection(r), kind: "err" };
  const parts: string[] = [];
  if (r.queued) parts.push(`Sent ${r.queued}`);
  if (r.skippedDuplicates.length) parts.push(`${r.skippedDuplicates.length} already sent (skipped)`);
  parts.push(`${r.remainingToday} left today`);
  return { text: parts.join(" · "), kind: r.queued ? "ok" : "warn" };
}

async function getSettings(): Promise<Settings> {
  return send<Settings>({ type: "GET_SETTINGS" });
}

/* ---------- single-record pages (profile, Sales Nav lead) ---------- */

async function setupSinglePage(pageType: PageType): Promise<void> {
  const panel = mountPanel(document, "LinkedIn Webhook Exporter", "Send to webhook", "Resend");
  panel.secondary.textContent = "Force resend";
  const settings = await getSettings();
  const doSend = async (force: boolean) => {
    panel.primary.disabled = true;
    panel.setStatus("Reading page…");
    const { leads } = parsePage(document, location.href, { includeExperience: settings.includeExperience, includeEducation: settings.includeEducation, includeAbout: settings.includeAbout });
    const lead = leads[0];
    if (!lead || !lead.full_name) {
      panel.setStatus("Could not read a name from this page. LinkedIn may have changed its layout.", "err");
      panel.primary.disabled = false;
      return;
    }
    const res = await send<CaptureResponse>({ type: "CAPTURE", leads: [lead], pageType, pageUrl: location.href, force });
    const s = summarize(res);
    panel.setStatus(s.text, s.kind);
    panel.primary.disabled = false;
  };
  panel.primary.addEventListener("click", () => void doSend(false));
  panel.secondary.addEventListener("click", () => void doSend(true));
  chrome.runtime.onMessage.addListener((m: { type: string }) => {
    if (m?.type === "SEND_CURRENT") void doSend(false);
  });
  // Show whether this profile was already sent.
  const { leads } = parsePage(document, location.href, { includeExperience: false, includeEducation: false, includeAbout: false });
  if (leads[0]?.full_name) {
    const key = dedupeKey(leads[0]);
    const seen = await send<Record<string, boolean>>({ type: "CHECK_DEDUPE", keys: [key] });
    if (seen[key]) panel.setStatus("Already sent. Use Force resend to send again.", "warn");
  }
}

/* ---------- list pages (Sales Nav search/list, people search) ---------- */

interface RowState {
  el: HTMLElement;
  box: HTMLInputElement;
}

function parseRow(row: HTMLElement, pageType: PageType, now: string): LeadRecord | null {
  return pageType === "people_search" ? parsePeopleSearchRow(row, now) : parseSalesNavRow(row, now);
}

async function setupListPage(pageType: PageType): Promise<void> {
  const panel: PanelHandles = mountPanel(document, "LinkedIn Webhook Exporter", "Send 0 selected", "Select all on page");
  const rows = new Map<HTMLElement, RowState>();

  const refreshCount = () => {
    const n = Array.from(rows.values()).filter((r) => r.box.checked).length;
    panel.primary.textContent = `Send ${n} selected`;
    panel.primary.disabled = n === 0;
  };

  const decorate = async () => {
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
      box.title = "Select for webhook";
      box.addEventListener("change", refreshCount);
      el.prepend(box);
      rows.set(el, { el, box });
      keys.push(dedupeKey(lead));
    }
    if (keys.length) {
      const seen = await send<Record<string, boolean>>({ type: "CHECK_DEDUPE", keys });
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
    const res = await send<CaptureResponse>({ type: "CAPTURE", leads, pageType, pageUrl: location.href, importId: crypto.randomUUID(), importKind: "manual", pageTitle: document.title });
    const s = summarize(res);
    panel.setStatus(s.text, s.kind);
    if (res.ok) {
      for (const r of selected) {
        r.box.checked = false;
        r.el.classList.add("lwe-sent");
      }
      toast(document, s.text);
    }
    refreshCount();
  });

  await decorate();
  await setupExportControls(panel, pageType);
  // LinkedIn renders lists incrementally and on scroll; observe for new rows.
  const mo = new MutationObserver(() => {
    clearTimeout((mo as unknown as { t?: number }).t);
    (mo as unknown as { t?: number }).t = window.setTimeout(() => void decorate(), 300);
  });
  mo.observe(document.body, { childList: true, subtree: true });
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

/** Sales Navigator renders rows lazily as you scroll; walk to the bottom until
 *  the row count stops growing so the parser sees the whole page. */
async function autoScroll(pageType: PageType): Promise<void> {
  const el = resultsScroller();
  let stable = 0;
  let last = -1;
  for (let i = 0; i < 40 && stable < 3; i++) {
    // Sales Navigator only materializes deferred rows on real (smooth) scrolling.
    el.scrollTo({ top: el.scrollTop + Math.max(400, el.clientHeight * 0.8), behavior: "smooth" });
    await new Promise((r) => setTimeout(r, 700 + Math.random() * 300));
    const n = listRows(document, pageType).length;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 5;
    stable = n === last && atBottom ? stable + 1 : 0;
    last = n;
  }
  el.scrollTop = 0;
}

function detectHasNext(rowCount: number, pageType: PageType): boolean {
  const next = document.querySelector<HTMLButtonElement>('[data-lwe="next-page"], button[aria-label="Next"], button.artdeco-pagination__button--next, a[aria-label="Next"]');
  if (next) return !next.disabled && next.getAttribute("aria-disabled") !== "true";
  // LinkedIn people search shows 10 per page; Sales Navigator shows 25.
  return rowCount >= (pageType === "people_search" ? 10 : 25);
}

function detectTotalHint(): number | null {
  const el = document.querySelector<HTMLElement>('[data-lwe="results-count"], .search-results__total, h2.t-14, .artdeco-pagination__page-state');
  return parseTotalHint(el?.textContent ?? null);
}

async function collectPage(): Promise<CollectResponse> {
  const pageType = detectPageType(location.pathname);
  if (!pageType || !isListPage(pageType)) return { ok: false, pageType, pageUrl: location.href, leads: [], hasNext: false, totalHint: null, error: "not_a_list_page" };
  await autoScroll(pageType);
  const { leads } = parsePage(document, location.href);
  return { ok: true, pageType, pageUrl: location.href, leads, hasNext: detectHasNext(leads.length, pageType), totalHint: detectTotalHint(), error: null };
}

chrome.runtime.onMessage.addListener((m: BackgroundToContent, _s, sendResponse) => {
  if (m?.type === "EXPORT_COLLECT") {
    collectPage().then(sendResponse, (e) => sendResponse({ ok: false, pageType: null, pageUrl: location.href, leads: [], hasNext: false, totalHint: null, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }
  return false;
});

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

async function setupExportControls(panel: PanelHandles, pageType: PageType): Promise<void> {
  const settings = await getSettings();
  const ctl = mountExportControls(panel, settings.exportDefaultLimit);
  let timer: number | null = null;

  const render = (st: ExportStatusResponse & { thisTab?: boolean }) => {
    // Show the finished job too, but only on the tab it ran in.
    const job = st.job ?? (st.thisTab ? st.history[0] ?? null : null);
    const active = !!job && (job.status === "running" || job.status === "paused");
    ctl.form.hidden = active;
    ctl.progress.hidden = !job;
    if (job) {
      ctl.progressText.textContent = describeJob(job);
      ctl.pause.hidden = !active;
      ctl.pause.textContent = job.status === "paused" ? "Resume" : "Pause";
      ctl.stopBtn.hidden = !active;
    }
    if (active && timer == null) timer = window.setInterval(poll, 2000);
    if (!active && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const poll = async () => render(await send<ExportStatusResponse>({ type: "EXPORT_STATUS" }));

  ctl.start.addEventListener("click", async () => {
    const limit = Math.max(1, Math.min(2500, Number(ctl.limit.value) || settings.exportDefaultLimit));
    const st = await send<ExportStatusResponse & { error?: string }>({ type: "EXPORT_START", url: location.href, limit });
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

/* ---------- SPA navigation ---------- */

let currentPath = "";
function boot(): void {
  const path = location.pathname;
  if (path === currentPath) return;
  currentPath = path;
  document.querySelector(".lwe-root")?.remove();
  const pageType = detectPageType(path);
  if (!pageType) return;
  if (isListPage(pageType)) void setupListPage(pageType);
  else void setupSinglePage(pageType);
}

boot();
// LinkedIn is a single-page app; watch for route changes.
const origPush = history.pushState.bind(history);
history.pushState = (...args: Parameters<History["pushState"]>) => {
  origPush(...args);
  setTimeout(boot, 500);
};
window.addEventListener("popstate", () => setTimeout(boot, 500));
setInterval(() => {
  if (location.pathname !== currentPath) boot();
}, 1500);
