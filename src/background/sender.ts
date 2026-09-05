import { runEndpoint, runIdFrom } from "../shared/deepline";
import { buildSignatureHeaders, buildStandardWebhookHeaders, EVENT_ID_HEADER, VERSION_HEADER } from "../shared/signing";
import type { Destination, PlayDestination, SendResult, WebhookDestination } from "../shared/types";

export interface SendOptions {
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  version: string;
  dedupeKey?: string;
}

export function classifyStatus(status: number): { ok: boolean; retryable: boolean } {
  if (status >= 200 && status < 300) return { ok: true, retryable: false };
  if (status === 408 || status === 425 || status === 429 || status >= 500) return { ok: false, retryable: true };
  return { ok: false, retryable: false };
}

export async function buildHeaders(dest: WebhookDestination, body: string, eventId: string, version: string, nowSec: number, dedupeKey: string = eventId): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [EVENT_ID_HEADER]: eventId,
    [VERSION_HEADER]: version,
    "Idempotency-Key": dedupeKey
  };
  if (dest.mappingPreset === "deepline") headers["x-deepline-dedupe-key"] = dedupeKey;
  if (dest.signingSecret) {
    Object.assign(headers, dest.signatureScheme === "standard" ? await buildStandardWebhookHeaders(dest.signingSecret, body, eventId, nowSec) : await buildSignatureHeaders(dest.signingSecret, body, nowSec));
  }
  if (dest.authHeaderName && dest.authHeaderValue) headers[dest.authHeaderName] = dest.authHeaderValue;
  return headers;
}

/** Headers for the Deepline run API: the API key is the credential; the
 *  idempotency key lets a retried run be deduplicated server-side. */
export function buildPlayHeaders(dest: PlayDestination, eventId: string, version: string, dedupeKey: string = eventId): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${dest.apiKey}`,
    [EVENT_ID_HEADER]: eventId,
    [VERSION_HEADER]: version,
    "Idempotency-Key": dedupeKey,
    "x-deepline-dedupe-key": dedupeKey
  };
}

async function post(url: string, headers: Record<string, string>, body: string, opts: SendOptions): Promise<SendResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetchImpl(url, { method: "POST", headers, body, signal: ctrl.signal, credentials: "omit", redirect: "error" });
    const cls = classifyStatus(res.status);
    const txt = await res.text().catch(() => "");
    let runId: string | null = null;
    let error: string | null = null;
    if (cls.ok) {
      try {
        runId = runIdFrom(JSON.parse(txt));
      } catch {
        runId = null;
      }
    } else {
      error = `HTTP ${res.status}${txt ? ": " + txt.slice(0, 200) : ""}`;
    }
    return { ok: cls.ok, status: res.status, retryable: cls.retryable, error, runId };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e);
    return { ok: false, status: null, retryable: true, error: msg, runId: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Deliver one already-serialized body to a destination. For a webhook the
 *  body is the payload; for a Deepline play the body is the full run request
 *  (`{ name, input }`) so retries re-send the identical bytes. */
export async function sendBody(dest: Destination, body: string, eventId: string, opts: SendOptions): Promise<SendResult> {
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  if (dest.kind === "webhook") {
    const headers = await buildHeaders(dest, body, eventId, opts.version, nowSec, opts.dedupeKey ?? eventId);
    return post(dest.url, headers, body, opts);
  }
  return post(runEndpoint(dest.baseUrl), buildPlayHeaders(dest, eventId, opts.version, opts.dedupeKey ?? eventId), body, opts);
}

/** Serialize a play run request. Stored on the queue item so a retry sends
 *  the same bytes the first attempt did. */
export function playRunBody(dest: PlayDestination, input: Record<string, unknown>): string {
  return JSON.stringify({ name: dest.playKey, input });
}
