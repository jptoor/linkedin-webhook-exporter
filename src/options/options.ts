import { DEFAULT_BASE_URL, summarizePlayInput, type PlaySummary } from "../shared/deepline";
import type { ListPlaysResponse } from "../shared/messages";
import { getSettings, newId, originPattern, saveSettings, validateHeader, validateWebhookUrl } from "../shared/settings";
import type { Destination, PlayDestination, Settings, WebhookDestination } from "../shared/types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => $<HTMLInputElement>(id).value;
const msg = <T,>(m: unknown): Promise<T> => chrome.runtime.sendMessage(m) as Promise<T>;

function setStatus(el: HTMLElement, text: string, cls: "ok" | "err" | "" = "") {
  el.textContent = text;
  el.className = `status${cls ? " " + cls : ""}`;
}

let settings: Settings;
let editing: { id: string; kind: "deepline_play" | "webhook"; favorite: boolean } | null = null;
let plays: PlaySummary[] = [];
let pickedPlay: PlaySummary | null = null;

/* ---------- destinations list ---------- */

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function renderDests() {
  const ul = $("dests");
  ul.textContent = "";
  if (!settings.destinations.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing connected yet. Connect a Deepline play to start pushing people.";
    ul.appendChild(li);
  }
  for (const d of settings.destinations) {
    const li = document.createElement("li");
    li.setAttribute("data-lwe-dest", d.id);
    const t = document.createElement("span");
    t.className = "t";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `${d.favorite ? "★ " : ""}${d.name}${d.id === settings.activeDestinationId ? " · current" : ""}`;
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = d.kind === "deepline_play" ? `${d.playKey} · ${safeHost(d.baseUrl)} · ${summarizePlayInput(d.input)}` : `${d.url} · ${d.mappingPreset}, ${d.sendMode}`;
    t.append(n, k);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = d.kind === "deepline_play" ? "Play" : "Webhook";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openEditor(d));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Remove";
    del.addEventListener("click", async () => {
      settings = await saveSettings({ destinations: settings.destinations.filter((x) => x.id !== d.id) });
      renderDests();
    });
    li.append(t, kind, edit, del);
    ul.appendChild(li);
  }
}

/* ---------- editor ---------- */

function setKind(kind: "deepline_play" | "webhook") {
  if (!editing) return;
  editing.kind = kind;
  $("kindPlay").setAttribute("aria-pressed", String(kind === "deepline_play"));
  $("kindWebhook").setAttribute("aria-pressed", String(kind === "webhook"));
  $("playFields").hidden = kind !== "deepline_play";
  $("webhookFields").hidden = kind !== "webhook";
}

function openEditor(d?: Destination, kind: "deepline_play" | "webhook" = "deepline_play") {
  editing = { id: d?.id ?? newId(), kind: d?.kind ?? kind, favorite: d?.favorite ?? false };
  pickedPlay = null;
  plays = [];
  $("plays").hidden = true;
  $("plays").textContent = "";
  setStatus($("destStatus"), "");
  setStatus($("playsStatus"), "");
  $<HTMLInputElement>("destName").value = d?.name ?? "";
  // Play fields
  $<HTMLInputElement>("apiKey").value = d?.kind === "deepline_play" ? d.apiKey : "";
  $<HTMLInputElement>("baseUrl").value = d?.kind === "deepline_play" ? d.baseUrl : DEFAULT_BASE_URL;
  $("playPicked").textContent = d?.kind === "deepline_play" ? `Play: ${d.playName} (${d.playKey}) · ${summarizePlayInput(d.input)}` : "";
  if (d?.kind === "deepline_play") pickedPlay = { playKey: d.playKey, name: d.playName, displayName: d.playName, description: null, origin: "owned", inputSchema: null, input: d.input };
  // Webhook fields
  const w = d?.kind === "webhook" ? d : null;
  $<HTMLInputElement>("url").value = w?.url ?? "";
  $<HTMLSelectElement>("mappingPreset").value = w?.mappingPreset ?? "generic";
  $<HTMLSelectElement>("sendMode").value = w?.sendMode ?? "single";
  $<HTMLInputElement>("signingSecret").value = w?.signingSecret ?? "";
  $<HTMLSelectElement>("signatureScheme").value = w?.signatureScheme ?? "lwe";
  $<HTMLInputElement>("authHeaderName").value = w?.authHeaderName ?? "";
  $<HTMLInputElement>("authHeaderValue").value = w?.authHeaderValue ?? "";
  setKind(editing.kind);
  $("editor").hidden = false;
  $("editor").scrollIntoView({ block: "nearest" });
}

function closeEditor() {
  editing = null;
  $("editor").hidden = true;
}

/** Build the destination from the form. Returns a reason when incomplete. */
function readDest(): { dest: Destination | null; reason: string | null } {
  if (!editing) return { dest: null, reason: "Nothing to save" };
  if (editing.kind === "deepline_play") {
    const apiKey = val("apiKey").trim();
    if (!apiKey) return { dest: null, reason: "Paste your Deepline API key." };
    if (!pickedPlay) return { dest: null, reason: "Load your plays and pick one." };
    const dest: PlayDestination = { id: editing.id, kind: "deepline_play", name: val("destName").trim() || pickedPlay.displayName, favorite: editing.favorite, baseUrl: val("baseUrl").trim() || DEFAULT_BASE_URL, apiKey, playKey: pickedPlay.playKey, playName: pickedPlay.displayName, input: pickedPlay.input };
    try {
      new URL(dest.baseUrl);
    } catch {
      return { dest: null, reason: "The Deepline address is not a valid URL." };
    }
    return { dest, reason: null };
  }
  const url = val("url").trim();
  const v = validateWebhookUrl(url);
  if (!v.ok) return { dest: null, reason: v.reason };
  const h = validateHeader(val("authHeaderName").trim(), val("authHeaderValue").trim());
  if (!h.ok) return { dest: null, reason: h.reason };
  const dest: WebhookDestination = {
    id: editing.id,
    kind: "webhook",
    name: val("destName").trim() || safeHost(url),
    favorite: editing.favorite,
    url,
    signingSecret: val("signingSecret"),
    signatureScheme: $<HTMLSelectElement>("signatureScheme").value === "standard" ? "standard" : "lwe",
    authHeaderName: val("authHeaderName").trim(),
    authHeaderValue: val("authHeaderValue").trim(),
    mappingPreset: $<HTMLSelectElement>("mappingPreset").value as WebhookDestination["mappingPreset"],
    sendMode: $<HTMLSelectElement>("sendMode").value === "batch" ? "batch" : "single"
  };
  return { dest, reason: null };
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

async function loadPlays() {
  const apiKey = val("apiKey").trim();
  if (!apiKey) return setStatus($("playsStatus"), "Paste your API key first.", "err");
  const baseUrl = val("baseUrl").trim() || DEFAULT_BASE_URL;
  if (!(await ensureHostPermission(baseUrl))) return setStatus($("playsStatus"), "Chrome needs permission to reach that address.", "err");
  setStatus($("playsStatus"), "Loading…");
  const r = await msg<ListPlaysResponse>({ type: "LIST_PLAYS", baseUrl, apiKey });
  if (!r.ok) return setStatus($("playsStatus"), r.error === "Deepline rejected the API key" ? "That API key was rejected." : `Could not load plays: ${r.error}`, "err");
  plays = r.plays;
  setStatus($("playsStatus"), plays.length ? `${plays.length} plays` : "No plays found in this org.", plays.length ? "ok" : "err");
  renderPlays();
}

function renderPlays() {
  const box = $("plays");
  box.textContent = "";
  box.hidden = !plays.length;
  const sorted = plays.slice().sort((a, b) => (a.origin === b.origin ? a.displayName.localeCompare(b.displayName) : a.origin === "owned" ? -1 : 1));
  for (const p of sorted) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("data-lwe-play", p.playKey);
    b.setAttribute("aria-pressed", String(pickedPlay?.playKey === p.playKey));
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `${p.displayName}${p.origin === "prebuilt" ? " · Deepline prebuilt" : ""}`;
    const d = document.createElement("span");
    d.className = "d";
    d.textContent = p.description ?? p.playKey;
    const i = document.createElement("span");
    i.className = "i";
    i.textContent = summarizePlayInput(p.input);
    b.append(n, d, i);
    b.addEventListener("click", () => {
      pickedPlay = p;
      if (!val("destName").trim()) $<HTMLInputElement>("destName").value = p.displayName;
      $("playPicked").textContent = `Play: ${p.displayName} (${p.playKey}) · ${summarizePlayInput(p.input)}`;
      renderPlays();
    });
    box.appendChild(b);
  }
}

$("addDest").addEventListener("click", () => openEditor(undefined, "deepline_play"));
$("addWebhook").addEventListener("click", () => openEditor(undefined, "webhook"));
$("kindPlay").addEventListener("click", () => setKind("deepline_play"));
$("kindWebhook").addEventListener("click", () => setKind("webhook"));
$("cancelDest").addEventListener("click", closeEditor);
$("loadPlays").addEventListener("click", () => void loadPlays());

$("saveDest").addEventListener("click", async () => {
  const { dest, reason } = readDest();
  if (!dest) return setStatus($("destStatus"), reason ?? "Incomplete", "err");
  const target = dest.kind === "webhook" ? dest.url : dest.baseUrl;
  if (!(await ensureHostPermission(target))) return setStatus($("destStatus"), "Chrome needs permission to reach that address.", "err");
  const others = settings.destinations.filter((d) => d.id !== dest.id);
  settings = await saveSettings({ destinations: [...others, dest], activeDestinationId: settings.activeDestinationId ?? dest.id });
  renderDests();
  closeEditor();
  setStatus($("status"), `Saved “${dest.name}”.`, "ok");
});

$("testDest").addEventListener("click", async () => {
  const { dest, reason } = readDest();
  if (!dest) return setStatus($("destStatus"), reason ?? "Incomplete", "err");
  const target = dest.kind === "webhook" ? dest.url : dest.baseUrl;
  if (!(await ensureHostPermission(target))) return setStatus($("destStatus"), "Chrome needs permission to reach that address.", "err");
  setStatus($("destStatus"), "Testing…");
  const r = await msg<{ ok: boolean; status: number | null; error: string | null }>({ type: "TEST_DESTINATION", destination: dest });
  setStatus($("destStatus"), r.ok ? (dest.kind === "webhook" ? `Your webhook answered ${r.status}.` : "Connected to Deepline.") : `Failed: ${r.error ?? "unknown error"}`, r.ok ? "ok" : "err");
});

/* ---------- general settings ---------- */

function renderGeneral(s: Settings) {
  $<HTMLInputElement>("capturedBy").value = s.capturedBy;
  $<HTMLInputElement>("dailyCap").value = String(s.dailyCap);
  $<HTMLInputElement>("searchDefaultLimit").value = String(s.searchDefaultLimit);
  $<HTMLInputElement>("dedupeTtlDays").value = String(s.dedupeTtlDays);
  $<HTMLInputElement>("dedupe").checked = s.dedupe;
  $<HTMLInputElement>("includeExperience").checked = s.includeExperience;
  $<HTMLInputElement>("includeEducation").checked = s.includeEducation;
  $<HTMLInputElement>("includeAbout").checked = s.includeAbout;
  $<HTMLTextAreaElement>("customFields").value = Object.entries(s.customFields).map(([k, v]) => `${k}=${v}`).join("\n");
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

$("save").addEventListener("click", async () => {
  settings = await saveSettings({
    capturedBy: val("capturedBy").trim(),
    dailyCap: Math.max(1, Number(val("dailyCap")) || 100),
    searchDefaultLimit: Math.max(1, Number(val("searchDefaultLimit")) || 100),
    dedupeTtlDays: Math.max(1, Number(val("dedupeTtlDays")) || 30),
    dedupe: $<HTMLInputElement>("dedupe").checked,
    includeExperience: $<HTMLInputElement>("includeExperience").checked,
    includeEducation: $<HTMLInputElement>("includeEducation").checked,
    includeAbout: $<HTMLInputElement>("includeAbout").checked,
    customFields: parseCustom($<HTMLTextAreaElement>("customFields").value)
  });
  renderGeneral(settings);
  setStatus($("status"), "Saved.", "ok");
});

/* ---------- history ---------- */

type LogEntry = { t: number; kind: string; msg: string; data?: Record<string, unknown> };
async function loadLog(limit = 1000): Promise<LogEntry[]> {
  const r = await msg<LogEntry[]>({ type: "GET_LOG", limit });
  return Array.isArray(r) ? r : [];
}
async function renderLog() {
  const entries = await loadLog(100);
  $("logPreview").textContent = entries.map((e) => `${new Date(e.t).toISOString()}  ${e.kind.padEnd(20)} ${e.msg}${e.data ? "  " + JSON.stringify(e.data) : ""}`).join("\n") || "No activity yet.";
}
$("downloadLog").addEventListener("click", async () => {
  const entries = await loadLog(1000);
  const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), entries }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `deepline-linkedin-history-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("clearLog").addEventListener("click", async () => {
  await msg({ type: "CLEAR_LOG" });
  $("logStatus").textContent = "Cleared.";
  void renderLog();
});

/* ---------- boot ---------- */

getSettings().then((s) => {
  settings = s;
  renderDests();
  renderGeneral(s);
  if (location.hash === "#add") openEditor(undefined, "deepline_play");
  if (location.hash === "#log") document.getElementById("log")?.scrollIntoView();
});
void renderLog();
