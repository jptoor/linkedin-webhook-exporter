import { exportablePageType, type ExportJob } from "../shared/export-job";
import type { ExportStatusResponse, StateResponse } from "../shared/messages";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function render(s: StateResponse) {
  $("webhook").textContent = s.settings.webhookUrl ? host(s.settings.webhookUrl) : "not set";
  $("webhook").className = s.settings.webhookUrl ? "" : "muted";
  $("sentToday").textContent = String(s.sentToday);
  $("remaining").textContent = String(s.remainingToday);
  $("dedupeCount").textContent = String(s.dedupeCount);
  const ul = $("queue");
  ul.textContent = "";
  if (!s.queue.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nothing sent yet.";
    ul.appendChild(li);
  }
  for (const item of s.queue.slice(0, 25)) {
    const li = document.createElement("li");
    const left = document.createElement("span");
    const label = item.leadUrls[0]?.replace(/^https?:\/\/www\.linkedin\.com\//, "") ?? "lead";
    left.textContent = item.leadCount > 1 ? `${item.leadCount} leads` : label;
    left.title = item.lastError ?? "";
    const pill = document.createElement("span");
    pill.className = `pill ${item.status}`;
    pill.textContent = item.status === "pending" && item.attempts > 0 ? `retry ${item.attempts}` : item.status;
    li.append(left, pill);
    ul.appendChild(li);
  }
}

function describeJob(job: ExportJob): string {
  const base = `page ${job.pagesDone} · ${job.collected} collected · ${job.sent} sent · ${job.skipped} already sent`;
  const reason = job.stopReason === "limit" ? "limit reached" : job.stopReason === "daily_cap" ? "daily cap" : job.stopReason === "no_more_pages" ? "no more results" : job.stopReason ?? "";
  return `${job.status}${reason ? ` (${reason})` : ""}: ${base}${job.lastError ? ` · ${job.lastError}` : ""}`;
}

function renderExport(st: ExportStatusResponse & { error?: string }) {
  const job = st.job ?? st.history[0] ?? null;
  const active = !!st.job && (st.job.status === "running" || st.job.status === "paused");
  ($("exportForm") as HTMLElement).hidden = active;
  ($("exportProgress") as HTMLElement).hidden = !job;
  if (job) {
    $("exportText").textContent = describeJob(job);
    ($("exportPause") as HTMLElement).hidden = !active;
    $("exportPause").textContent = job.status === "paused" ? "Resume" : "Pause";
    ($("exportStop") as HTMLElement).hidden = !active;
  }
  $("exportError").textContent = st.error ? (st.error === "no_webhook" ? "Configure a webhook first." : st.error === "not_exportable_url" ? "That is not a Sales Navigator search/list or LinkedIn people search URL." : st.error === "job_running" ? "An export is already running." : st.error) : "";
}

async function refreshExport() {
  renderExport((await chrome.runtime.sendMessage({ type: "EXPORT_STATUS" })) as ExportStatusResponse);
}

async function prefillExport() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && exportablePageType(tab.url)) ($("exportUrl") as HTMLInputElement).value = tab.url;
}

$("exportStart").addEventListener("click", async () => {
  const url = ($("exportUrl") as HTMLInputElement).value.trim();
  const limit = Number(($("exportLimit") as HTMLInputElement).value) || 0;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const useTab = tab?.id != null && tab.url === url ? tab.id : undefined;
  renderExport((await chrome.runtime.sendMessage({ type: "EXPORT_START", url, limit, tabId: useTab })) as ExportStatusResponse);
});
$("exportPause").addEventListener("click", async () => {
  const st = (await chrome.runtime.sendMessage({ type: "EXPORT_STATUS" })) as ExportStatusResponse;
  renderExport((await chrome.runtime.sendMessage({ type: st.job?.status === "paused" ? "EXPORT_RESUME" : "EXPORT_PAUSE" })) as ExportStatusResponse);
});
$("exportStop").addEventListener("click", async () => renderExport((await chrome.runtime.sendMessage({ type: "EXPORT_STOP" })) as ExportStatusResponse));

function fmtTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
async function refreshLog() {
  const entries = (await chrome.runtime.sendMessage({ type: "GET_LOG", limit: 15 })) as Array<{ t: number; kind: string; msg: string }>;
  const ul = $("log");
  ul.textContent = "";
  if (!Array.isArray(entries) || !entries.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No activity yet.";
    ul.appendChild(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = e.kind;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = fmtTime(e.t);
    li.append(k, document.createTextNode(e.msg), t);
    ul.appendChild(li);
  }
}
$("openLog").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html#log") });
});

async function refresh() {
  render((await chrome.runtime.sendMessage({ type: "GET_STATE" })) as StateResponse);
}

$("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
$("retry").addEventListener("click", async () => render((await chrome.runtime.sendMessage({ type: "RETRY_NOW" })) as StateResponse));
$("clear").addEventListener("click", async () => render((await chrome.runtime.sendMessage({ type: "CLEAR_QUEUE", status: "all" })) as StateResponse));
void refresh();
void refreshExport();
void refreshLog();
void prefillExport();
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).then((s: { exportDefaultLimit?: number }) => {
  ($("exportLimit") as HTMLInputElement).value = String(s?.exportDefaultLimit ?? 500);
});
setInterval(() => {
  void refresh();
  void refreshExport();
  void refreshLog();
}, 2000);
