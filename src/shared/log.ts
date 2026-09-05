/** Automatic activity log. Every user-visible action and every delivery
 *  outcome is appended to a bounded ring buffer in chrome.storage.local so
 *  reps and operators can see exactly what the extension did, when, and why.
 *  Entries never contain secrets or auth headers; lead identities are kept
 *  as canonical URLs / names only. Exportable as JSON from the options page. */

import { searchKey } from "./search";

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
  | "basket.added"
  | "basket.removed"
  | "basket.cleared"
  | "basket.sent"
  | "share_link.captured"
  | "plays.listed"
  | "queue.cleared"
  | "queue.retried"
  | "settings.saved"
  | "destination.changed"
  | "destination.test"
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
/** Total serialized size the log may occupy in storage. */
export const LOG_MAX_BYTES = 512 * 1024;

/** Every URL inside a string loses session/tracking query parameters and fragments. */
export function redactUrl(v: string): string {
  return v.replace(/https?:\/\/[^\s"'<>]+/gi, (m) => searchKey(m));
}

function bound(v: string): string {
  const r = redactUrl(v);
  return r.length > 300 ? r.slice(0, 299) + "…" : r;
}

/** Drop anything that looks like a secret, redact URLs, bound sizes.
 *  Recursive to depth 3 so nested objects get the same treatment. */
export function redact(data: Record<string, unknown> | undefined, depth = 0): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data).slice(0, 30)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = redactValue(v, depth);
  }
  return out;
}
function redactValue(v: unknown, depth: number): unknown {
  if (typeof v === "string") return bound(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => (typeof x === "string" ? redactUrl(x).slice(0, 200) : typeof x === "number" ? x : x && typeof x === "object" && depth < 3 ? redactValue(x, depth + 1) : String(x).slice(0, 100)));
  if (v && typeof v === "object") return depth < 3 ? redact(v as Record<string, unknown>, depth + 1) : "[nested]";
  return undefined;
}

/** Ring buffer bounded by entry count AND serialized bytes. A single entry
 *  larger than a quarter of the byte budget keeps its message but drops its
 *  details, so one huge event can never evict the whole history. */
export function append(log: LogEntry[], entry: LogEntry, max = LOG_MAX, maxBytes = LOG_MAX_BYTES): LogEntry[] {
  const next = log.length >= max ? log.slice(log.length - max + 1) : log.slice();
  let e: LogEntry = { ...entry, msg: redactUrl(entry.msg).slice(0, 300) };
  if (JSON.stringify(e).length > maxBytes / 4) e = { t: e.t, kind: e.kind, msg: e.msg, data: { truncated: true } };
  next.push(e);
  let bytes = JSON.stringify(next).length;
  while (bytes > maxBytes && next.length > 1) {
    bytes -= JSON.stringify(next.shift()).length + 1;
  }
  return next;
}

/** The log has its own tiny mutex so writes never interleave and never nest
 *  with the worker's storage lock (logEvent is called from inside it). */
let logChain: Promise<unknown> = Promise.resolve();

/** Storage-backed logger for the service worker. Writes are serialized by
 *  the caller's lock when they matter; a lost log line never blocks work. */
export function logEvent(kind: LogKind, msg: string, data?: Record<string, unknown>): Promise<void> {
  const write = async () => {
    try {
      const raw = ((await chrome.storage.local.get(LOG_KEY))[LOG_KEY] as LogEntry[] | undefined) ?? [];
      const entry: LogEntry = { t: Date.now(), kind, msg, data: redact(data) };
      await chrome.storage.local.set({ [LOG_KEY]: append(Array.isArray(raw) ? raw : [], entry) });
      if (typeof __LWE_DEBUG__ !== "undefined" && __LWE_DEBUG__) console.debug("[lwe]", kind, msg, entry.data ?? "");
    } catch {
      /* logging must never throw */
    }
  };
  logChain = logChain.then(write, write);
  return logChain as Promise<void>;
}
declare const __LWE_DEBUG__: boolean | undefined;

export async function readLog(limit = 200): Promise<LogEntry[]> {
  const raw = ((await chrome.storage.local.get(LOG_KEY))[LOG_KEY] as LogEntry[] | undefined) ?? [];
  return raw.slice(-limit).reverse();
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.set({ [LOG_KEY]: [] });
}
