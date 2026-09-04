import { logEvent } from "./log";
import { DEFAULT_SETTINGS, LIMITS, MAPPING_PRESETS, type ContentSettings, type Settings } from "./types";

const KEY = "settings";

/** Header names allowed for the optional extra auth header. Forbidden and
 *  transport headers are rejected so a bad setting cannot break every request. */
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "cookie", "origin", "referer", "connection", "transfer-encoding", "x-lwe-signature", "x-lwe-timestamp", "x-lwe-event-id", "webhook-id", "webhook-timestamp", "webhook-signature", "idempotency-key"]);
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const HEADER_VALUE_RE = /^[\t\x20-\x7E\x80-\xFF]{0,4096}$/; // no CR/LF/control chars

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

/** Coerce anything stored (or supplied by the options page) into a valid
 *  Settings object. Invalid values fall back to defaults; numbers are clamped. */
export function sanitizeSettings(input: unknown): Settings {
  const s = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const custom: Record<string, string> = {};
  if (s.customFields && typeof s.customFields === "object") {
    for (const [k, v] of Object.entries(s.customFields as Record<string, unknown>).slice(0, LIMITS.customFieldsMax)) {
      const key = k.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);
      if (key && typeof v === "string") custom[key] = v.slice(0, LIMITS.customValueMax);
    }
  }
  const header = validateHeader(str(s.authHeaderName, 100), str(s.authHeaderValue, 4096));
  const minDelay = clampInt(s.exportPageDelayMinMs, LIMITS.pageDelayMinFloorMs, LIMITS.pageDelayMaxMs, DEFAULT_SETTINGS.exportPageDelayMinMs);
  return {
    webhookUrl: str(s.webhookUrl, 2048).trim(),
    signingSecret: str(s.signingSecret, 4096),
    signatureScheme: s.signatureScheme === "standard" ? "standard" : "lwe",
    authHeaderName: header.ok ? str(s.authHeaderName, 100).trim() : "",
    authHeaderValue: header.ok ? str(s.authHeaderValue, 4096).trim() : "",
    mappingPreset: (MAPPING_PRESETS as readonly string[]).includes(s.mappingPreset as string) ? (s.mappingPreset as Settings["mappingPreset"]) : "generic",
    sendMode: s.sendMode === "batch" ? "batch" : "single",
    dedupe: bool(s.dedupe, DEFAULT_SETTINGS.dedupe),
    dedupeTtlDays: clampInt(s.dedupeTtlDays, 1, LIMITS.dedupeTtlDaysMax, DEFAULT_SETTINGS.dedupeTtlDays),
    dailyCap: clampInt(s.dailyCap, 1, LIMITS.dailyCapMax, DEFAULT_SETTINGS.dailyCap),
    capturedBy: str(s.capturedBy, LIMITS.capturedByMax).trim(),
    customFields: custom,
    includeExperience: bool(s.includeExperience, true),
    includeEducation: bool(s.includeEducation, true),
    includeAbout: bool(s.includeAbout, true),
    exportDefaultLimit: clampInt(s.exportDefaultLimit, 1, LIMITS.exportLimitMax, DEFAULT_SETTINGS.exportDefaultLimit),
    exportPageDelayMinMs: minDelay,
    exportPageDelayMaxMs: Math.max(minDelay, clampInt(s.exportPageDelayMaxMs, LIMITS.pageDelayMinFloorMs, LIMITS.pageDelayMaxMs, DEFAULT_SETTINGS.exportPageDelayMaxMs))
  };
}

export async function getSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(KEY);
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(res[KEY] ?? {}) });
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = sanitizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  const changed = (Object.keys(next) as Array<keyof Settings>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
  if (changed.length) await logEvent("settings.saved", `Settings changed: ${changed.join(", ")}`, { changed, webhookHost: next.webhookUrl ? new URL(next.webhookUrl).host : null, preset: next.mappingPreset, sendMode: next.sendMode, dailyCap: next.dailyCap });
  return next;
}

export function toContentSettings(s: Settings): ContentSettings {
  return { includeExperience: s.includeExperience, includeEducation: s.includeEducation, includeAbout: s.includeAbout, exportDefaultLimit: s.exportDefaultLimit, dedupe: s.dedupe, sendMode: s.sendMode, hasWebhook: !!s.webhookUrl };
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
