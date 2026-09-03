import { DEFAULT_SETTINGS, type Settings } from "./types";

const KEY = "settings";

export async function getSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(res[KEY] ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Validate a webhook URL: must be https, or http on localhost/127.0.0.1 for development. */
export function validateWebhookUrl(url: string): { ok: boolean; reason: string | null } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (u.protocol === "https:") return { ok: true, reason: null };
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return { ok: true, reason: null };
  return { ok: false, reason: "Webhook URL must use https:// (http:// is only allowed for localhost)" };
}

/** Origin pattern for an optional host permission request. */
export function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}/*`;
}
