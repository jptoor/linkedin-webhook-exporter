import { inferPlayInput, normalizeBaseUrl } from "./deepline";
import { logEvent } from "./log";
import { DEFAULT_SETTINGS, LIMITS, MAPPING_PRESETS, type ContentSettings, type Destination, type PlayDestination, type PlayInputSpec, type Settings, type WebhookDestination } from "./types";

const KEY = "settings";

/** Header names allowed for the optional extra auth header. Forbidden and
 *  transport headers are rejected so a bad setting cannot break every request. */
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "cookie", "origin", "referer", "connection", "transfer-encoding", "x-lwe-signature", "x-lwe-timestamp", "x-lwe-event-id", "webhook-id", "webhook-timestamp", "webhook-signature", "idempotency-key"]);
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const HEADER_VALUE_RE = /^[\t\x20-\x7E\x80-\xFF]{0,4096}$/; // no CR/LF/control chars
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateHeader(name: string, value: string): { ok: boolean; reason: string | null } {
  if (!name && !value) return { ok: true, reason: null };
  if (!HEADER_NAME_RE.test(name)) return { ok: false, reason: "Header name contains invalid characters" };
  if (FORBIDDEN_HEADERS.has(name.toLowerCase())) return { ok: false, reason: `Header ${name} is reserved` };
  if (!HEADER_VALUE_RE.test(value)) return { ok: false, reason: "Header value contains control characters" };
  try {
    new Headers({ [name]: value });
  } catch {
    return { ok: false, reason: "Header is not accepted by the browser" };
  }
  return { ok: true, reason: null };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function str(v: unknown, max: number, fallback = ""): string {
  return typeof v === "string" ? v.slice(0, max) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function strList(v: unknown, max = 100): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((s) => s.slice(0, 100)) : [];
}

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "").slice(0, 20) : `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizePlayInput(v: unknown): PlayInputSpec {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const mode = o.mode === "batch" || o.mode === "lead" ? o.mode : "mapped";
  const fields = strList(o.fields);
  return { mode, fields, required: strList(o.required).filter((r) => !fields.length || fields.includes(r)), acceptsSearch: bool(o.acceptsSearch, !fields.length), acceptsLeads: bool(o.acceptsLeads, true) };
}

/** Coerce one stored/submitted destination. Returns null when it cannot be
 *  made valid (unknown kind, missing URL/key). */
export function sanitizeDestination(input: unknown): Destination | null {
  const d = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = ID_RE.test(str(d.id, 64)) ? str(d.id, 64) : newId();
  if (d.kind === "deepline_play") {
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(str(d.baseUrl, 2048));
    } catch {
      return null;
    }
    const playKey = str(d.playKey, 300).trim();
    if (!playKey) return null;
    const out: PlayDestination = {
      id,
      kind: "deepline_play",
      name: str(d.name, 100).trim() || str(d.playName, 100).trim() || playKey,
      favorite: bool(d.favorite, false),
      baseUrl,
      apiKey: str(d.apiKey, 4096).trim(),
      playKey,
      playName: str(d.playName, 200).trim() || playKey,
      input: d.input ? sanitizePlayInput(d.input) : inferPlayInput(null)
    };
    return out;
  }
  if (d.kind === "webhook" || typeof d.url === "string" || typeof d.webhookUrl === "string") {
    const url = str(d.url ?? d.webhookUrl, 2048).trim();
    if (!url || !validateWebhookUrl(url).ok) return null;
    const header = validateHeader(str(d.authHeaderName, 100).trim(), str(d.authHeaderValue, 4096).trim());
    const out: WebhookDestination = {
      id,
      kind: "webhook",
      name: str(d.name, 100).trim() || safeHost(url),
      favorite: bool(d.favorite, false),
      url,
      signingSecret: str(d.signingSecret, 4096),
      signatureScheme: d.signatureScheme === "standard" ? "standard" : "lwe",
      authHeaderName: header.ok ? str(d.authHeaderName, 100).trim() : "",
      authHeaderValue: header.ok ? str(d.authHeaderValue, 4096).trim() : "",
      mappingPreset: (MAPPING_PRESETS as readonly string[]).includes(d.mappingPreset as string) ? (d.mappingPreset as WebhookDestination["mappingPreset"]) : "generic",
      sendMode: d.sendMode === "batch" ? "batch" : "single"
    };
    return out;
  }
  return null;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "webhook";
  }
}

/** Coerce anything stored (or supplied by the options page) into a valid
 *  Settings object. Invalid values fall back to defaults; numbers are clamped.
 *  A v1 single-webhook configuration (webhookUrl + signing fields at the top
 *  level) is migrated into the first destination. */
export function sanitizeSettings(input: unknown): Settings {
  const s = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const custom: Record<string, string> = {};
  if (s.customFields && typeof s.customFields === "object") {
    for (const [k, v] of Object.entries(s.customFields as Record<string, unknown>).slice(0, LIMITS.customFieldsMax)) {
      const key = k.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);
      if (key && typeof v === "string") custom[key] = v.slice(0, LIMITS.customValueMax);
    }
  }
  const destinations: Destination[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(s.destinations) ? s.destinations.slice(0, LIMITS.destinationsMax) : []) {
    const d = sanitizeDestination(raw);
    if (d && !seen.has(d.id)) {
      seen.add(d.id);
      destinations.push(d);
    }
  }
  // v1 migration: a top-level webhookUrl becomes a destination once.
  if (!destinations.length && typeof s.webhookUrl === "string" && s.webhookUrl.trim()) {
    const legacy = sanitizeDestination({ kind: "webhook", id: "legacy-webhook", name: "Webhook", url: s.webhookUrl, signingSecret: s.signingSecret, signatureScheme: s.signatureScheme, authHeaderName: s.authHeaderName, authHeaderValue: s.authHeaderValue, mappingPreset: s.mappingPreset, sendMode: s.sendMode });
    if (legacy) destinations.push(legacy);
  }
  const wanted = str(s.activeDestinationId, 64);
  const activeDestinationId = destinations.some((d) => d.id === wanted) ? wanted : (destinations[0]?.id ?? null);
  return {
    destinations,
    activeDestinationId,
    dedupe: bool(s.dedupe, DEFAULT_SETTINGS.dedupe),
    dedupeTtlDays: clampInt(s.dedupeTtlDays, 1, LIMITS.dedupeTtlDaysMax, DEFAULT_SETTINGS.dedupeTtlDays),
    dailyCap: clampInt(s.dailyCap, 1, LIMITS.dailyCapMax, DEFAULT_SETTINGS.dailyCap),
    capturedBy: str(s.capturedBy, LIMITS.capturedByMax).trim(),
    customFields: custom,
    includeExperience: bool(s.includeExperience, true),
    includeEducation: bool(s.includeEducation, true),
    includeAbout: bool(s.includeAbout, true),
    searchDefaultLimit: clampInt(s.searchDefaultLimit, 1, LIMITS.searchLimitMax, DEFAULT_SETTINGS.searchDefaultLimit)
  };
}

export async function getSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(KEY);
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(res[KEY] ?? {}) });
}

export function describeDestination(d: Destination | null | undefined): string {
  if (!d) return "no destination";
  return d.kind === "webhook" ? `${d.name} (${safeHost(d.url)})` : `${d.name} (${d.playKey} @ ${safeHost(d.baseUrl)})`;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = sanitizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  const changed = (Object.keys(next) as Array<keyof Settings>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
  if (changed.length) {
    await logEvent("settings.saved", `Settings changed: ${changed.join(", ")}`, {
      changed,
      destinations: next.destinations.map((d) => ({ id: d.id, kind: d.kind, name: d.name, host: safeHost(d.kind === "webhook" ? d.url : d.baseUrl), play: d.kind === "deepline_play" ? d.playKey : null })),
      active: next.activeDestinationId,
      dailyCap: next.dailyCap
    });
  }
  return next;
}

export function activeDestination(s: Settings): Destination | null {
  return s.destinations.find((d) => d.id === s.activeDestinationId) ?? null;
}

export function toContentSettings(s: Settings): ContentSettings {
  const d = activeDestination(s);
  return { includeExperience: s.includeExperience, includeEducation: s.includeEducation, includeAbout: s.includeAbout, dedupe: s.dedupe, searchDefaultLimit: s.searchDefaultLimit, hasDestination: !!d, destinationName: d?.name ?? null, destinationKind: d?.kind ?? null };
}

/** Destinations with secrets blanked, for extension pages that only need to
 *  pick one (the side panel). The options page reads full settings. */
export function redactDestination(d: Destination): Destination {
  return d.kind === "webhook" ? { ...d, signingSecret: d.signingSecret ? "•••" : "", authHeaderValue: d.authHeaderValue ? "•••" : "" } : { ...d, apiKey: d.apiKey ? "•••" : "" };
}

/** Validate a webhook URL: must be https, or http on localhost/127.0.0.1 for development. */
export function validateWebhookUrl(url: string): { ok: boolean; reason: string | null } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (u.username || u.password) return { ok: false, reason: "Webhook URL must not contain credentials" };
  if (u.protocol === "https:") return { ok: true, reason: null };
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return { ok: true, reason: null };
  return { ok: false, reason: "Webhook URL must use https:// (http:// is only allowed for localhost)" };
}

/** Origin pattern for an optional host permission request. */
export function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}/*`;
}
