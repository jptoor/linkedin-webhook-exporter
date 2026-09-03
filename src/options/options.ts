import { getSettings, originPattern, saveSettings, validateWebhookUrl } from "../shared/settings";
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

$("save").addEventListener("click", async () => {
  const patch = read();
  if (patch.webhookUrl) {
    const v = validateWebhookUrl(patch.webhookUrl);
    if (!v.ok) return setStatus(v.reason ?? "Invalid URL", "err");
    const granted = await ensureHostPermission(patch.webhookUrl);
    if (!granted) return setStatus("Permission to contact that host was not granted.", "err");
  }
  await saveSettings(patch);
  setStatus("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  await saveSettings(read());
  setStatus("Sending test event…");
  const r = (await chrome.runtime.sendMessage({ type: "TEST_WEBHOOK" })) as { ok: boolean; status: number | null; error: string | null };
  setStatus(r.ok ? `Webhook responded ${r.status}.` : `Failed: ${r.error ?? "unknown error"}`, r.ok ? "ok" : "err");
});

getSettings().then(render);
