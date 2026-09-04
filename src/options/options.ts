import { getSettings, originPattern, saveSettings, validateHeader, validateWebhookUrl } from "../shared/settings";
import type { Settings } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");

function setStatus(text: string, cls: "ok" | "err" | "" = "") {
  status.textContent = text;
  status.className = cls;
}

function parseCustom(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().replace(/[^A-Za-z0-9_]/g, "_");
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function render(s: Settings) {
  $<HTMLInputElement>("webhookUrl").value = s.webhookUrl;
  $<HTMLInputElement>("signingSecret").value = s.signingSecret;
  $<HTMLSelectElement>("signatureScheme").value = s.signatureScheme;
  $<HTMLInputElement>("authHeaderName").value = s.authHeaderName;
  $<HTMLInputElement>("authHeaderValue").value = s.authHeaderValue;
  $<HTMLSelectElement>("mappingPreset").value = s.mappingPreset;
  $<HTMLSelectElement>("sendMode").value = s.sendMode;
  $<HTMLInputElement>("capturedBy").value = s.capturedBy;
  $<HTMLTextAreaElement>("customFields").value = Object.entries(s.customFields).map(([k, v]) => `${k}=${v}`).join("\n");
  $<HTMLInputElement>("includeExperience").checked = s.includeExperience;
  $<HTMLInputElement>("includeEducation").checked = s.includeEducation;
  $<HTMLInputElement>("includeAbout").checked = s.includeAbout;
  $<HTMLInputElement>("dedupe").checked = s.dedupe;
  $<HTMLInputElement>("dedupeTtlDays").value = String(s.dedupeTtlDays);
  $<HTMLInputElement>("dailyCap").value = String(s.dailyCap);
  $<HTMLInputElement>("exportDefaultLimit").value = String(s.exportDefaultLimit);
  $<HTMLInputElement>("exportPageDelayMinMs").value = String(s.exportPageDelayMinMs);
  $<HTMLInputElement>("exportPageDelayMaxMs").value = String(s.exportPageDelayMaxMs);
}

function read(): Partial<Settings> {
  return {
    webhookUrl: $<HTMLInputElement>("webhookUrl").value.trim(),
    signingSecret: $<HTMLInputElement>("signingSecret").value,
    signatureScheme: $<HTMLSelectElement>("signatureScheme").value as Settings["signatureScheme"],
    authHeaderName: $<HTMLInputElement>("authHeaderName").value.trim(),
    authHeaderValue: $<HTMLInputElement>("authHeaderValue").value.trim(),
    mappingPreset: $<HTMLSelectElement>("mappingPreset").value as Settings["mappingPreset"],
    sendMode: $<HTMLSelectElement>("sendMode").value as Settings["sendMode"],
    capturedBy: $<HTMLInputElement>("capturedBy").value.trim(),
    customFields: parseCustom($<HTMLTextAreaElement>("customFields").value),
    includeExperience: $<HTMLInputElement>("includeExperience").checked,
    includeEducation: $<HTMLInputElement>("includeEducation").checked,
    includeAbout: $<HTMLInputElement>("includeAbout").checked,
    dedupe: $<HTMLInputElement>("dedupe").checked,
    dedupeTtlDays: Math.max(1, Number($<HTMLInputElement>("dedupeTtlDays").value) || 30),
    dailyCap: Math.max(1, Number($<HTMLInputElement>("dailyCap").value) || 100),
    exportDefaultLimit: Math.max(1, Math.min(2500, Number($<HTMLInputElement>("exportDefaultLimit").value) || 500)),
    exportPageDelayMinMs: Math.max(0, Number($<HTMLInputElement>("exportPageDelayMinMs").value) || 0),
    exportPageDelayMaxMs: Math.max(0, Number($<HTMLInputElement>("exportPageDelayMaxMs").value) || 0)
  };
}

async function ensureHostPermission(url: string): Promise<boolean> {
  if (!chrome.permissions?.request) return true;
  const origins = [originPattern(url)];
  if (await chrome.permissions.contains({ origins })) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

/** One validation + authorization path shared by Save and Test (audit SEC-04). */
async function validateAndAuthorize(patch: Partial<Settings>): Promise<{ ok: boolean; reason: string | null }> {
  if (!patch.webhookUrl) return { ok: true, reason: null };
  const v = validateWebhookUrl(patch.webhookUrl);
  if (!v.ok) return v;
  const h = validateHeader(patch.authHeaderName ?? "", patch.authHeaderValue ?? "");
  if (!h.ok) return h;
  if ((patch.exportPageDelayMinMs ?? 0) > (patch.exportPageDelayMaxMs ?? 0)) return { ok: false, reason: "Minimum page delay must not exceed the maximum" };
  const granted = await ensureHostPermission(patch.webhookUrl);
  if (!granted) return { ok: false, reason: "Permission to contact that host was not granted." };
  return { ok: true, reason: null };
}

$("save").addEventListener("click", async () => {
  const patch = read();
  const v = await validateAndAuthorize(patch);
  if (!v.ok) return setStatus(v.reason ?? "Invalid settings", "err");
  await saveSettings(patch);
  setStatus("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  const patch = read();
  const v = await validateAndAuthorize(patch);
  if (!v.ok) return setStatus(v.reason ?? "Invalid settings", "err");
  if (!patch.webhookUrl) return setStatus("Enter a webhook URL first.", "err");
  // Test with the current form values, without persisting a failed configuration.
  const previous = await getSettings();
  await saveSettings(patch);
  setStatus("Sending test event…");
  const r = (await chrome.runtime.sendMessage({ type: "TEST_WEBHOOK" })) as { ok: boolean; status: number | null; error: string | null };
  if (!r.ok) await saveSettings(previous);
  setStatus(r.ok ? `Webhook responded ${r.status}. Saved.` : `Failed: ${r.error ?? "unknown error"} (settings not saved)`, r.ok ? "ok" : "err");
});

getSettings().then(render);

/* ---------- activity log ---------- */
type LogEntry = { t: number; kind: string; msg: string; data?: Record<string, unknown> };
async function loadLog(limit = 1000): Promise<LogEntry[]> {
  const r = (await chrome.runtime.sendMessage({ type: "GET_LOG", limit })) as LogEntry[];
  return Array.isArray(r) ? r : [];
}
async function renderLog() {
  const entries = await loadLog(100);
  $("logPreview").textContent = entries.map((e) => `${new Date(e.t).toISOString()}  ${e.kind.padEnd(18)} ${e.msg}${e.data ? "  " + JSON.stringify(e.data) : ""}`).join("\n") || "No activity yet.";
}
$("downloadLog").addEventListener("click", async () => {
  const entries = await loadLog(1000);
  const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), entries }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `linkedin-webhook-exporter-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("clearLog").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_LOG" });
  $("logStatus").textContent = "Cleared.";
  void renderLog();
});
void renderLog();
if (location.hash === "#log") document.getElementById("log")?.scrollIntoView();
