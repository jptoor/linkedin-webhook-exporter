/** Automatic activity log. Every user-visible action and every delivery
 *  outcome is appended to a bounded ring buffer in chrome.storage.local so
 *  reps and operators can see exactly what the extension did, when, and why.
 *  Entries never contain secrets or auth headers; lead identities are kept
 *  as canonical URLs / names only. Exportable as JSON from the options page. */

export type LogKind =
  | "capture.requested"
  | "capture.queued"
  | "capture.rejected"
  | "capture.duplicate"
  | "search.saved"
  | "send.attempt"
  | "send.ok"
  | "send.retry"
  | "send.failed"
  | "export.started"
  | "export.page"
  | "export.paused"
  | "export.resumed"
  | "export.stopped"
  | "export.finished"
  | "export.failed"
  | "queue.cleared"
  | "queue.retried"
  | "settings.saved"
  | "webhook.test"
  | "lease.recovered"
  | "error";

export interface LogEntry {
  t: number;
  kind: LogKind;
  /** Short human summary. */
  msg: string;
  /** Structured, redacted details (counts, ids, statuses, page urls). */
  data?: Record<string, unknown>;
}

export const LOG_KEY = "activityLog";
export const LOG_MAX = 1000;

const SECRET_KEYS = /secret|token|password|authorization|authheadervalue|signature|cookie/i;

/** Drop anything that looks like a secret, bound sizes. */
export function redact(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data).slice(0, 30)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string") out[k] = v.length > 300 ? v.slice(0, 299) + "…" : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 50).map((x) => (typeof x === "string" ? x.slice(0, 200) : typeof x === "number" ? x : String(x).slice(0, 100)));
    else if (v && typeof v === "object") out[k] = JSON.stringify(v).slice(0, 300);
  }
  return out;
}

export function append(log: LogEntry[], entry: LogEntry, max = LOG_MAX): LogEntry[] {
  const next = log.length >= max ? log.slice(log.length - max + 1) : log.slice();
  next.push(entry);
  return next;
}

/** Storage-backed logger for the service worker. Writes are serialized by
 *  the caller's lock when they matter; a lost log line never blocks work. */
export async function logEvent(kind: LogKind, msg: string, data?: Record<string, unknown>): Promise<void> {
  try {
    const raw = ((await chrome.storage.local.get(LOG_KEY))[LOG_KEY] as LogEntry[] | undefined) ?? [];
    const entry: LogEntry = { t: Date.now(), kind, msg, data: redact(data) };
    await chrome.storage.local.set({ [LOG_KEY]: append(Array.isArray(raw) ? raw : [], entry) });
    if (typeof __LWE_DEBUG__ !== "undefined" && __LWE_DEBUG__) console.debug("[lwe]", kind, msg, entry.data ?? "");
  } catch {
    /* logging must never throw */
  }
}
declare const __LWE_DEBUG__: boolean | undefined;

export async function readLog(limit = 200): Promise<LogEntry[]> {
  const raw = ((await chrome.storage.local.get(LOG_KEY))[LOG_KEY] as LogEntry[] | undefined) ?? [];
  return raw.slice(-limit).reverse();
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}
