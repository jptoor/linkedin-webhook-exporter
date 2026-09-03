import { buildSignatureHeaders, buildStandardWebhookHeaders, EVENT_ID_HEADER, VERSION_HEADER } from "../shared/signing";
import type { SendResult, Settings } from "../shared/types";

export interface SendOptions {
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  version: string;
}

export function classifyStatus(status: number): { ok: boolean; retryable: boolean } {
  if (status >= 200 && status < 300) return { ok: true, retryable: false };
  if (status === 408 || status === 425 || status === 429 || status >= 500) return { ok: false, retryable: true };
  return { ok: false, retryable: false };
}

export async function buildHeaders(settings: Settings, body: string, eventId: string, version: string, nowSec: number, dedupeKey: string = eventId): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [EVENT_ID_HEADER]: eventId,
    [VERSION_HEADER]: version,
    "Idempotency-Key": dedupeKey
  };
  if (settings.mappingPreset === "deepline") headers["x-deepline-dedupe-key"] = dedupeKey;
  if (settings.signingSecret) {
    Object.assign(headers, settings.signatureScheme === "standard" ? await buildStandardWebhookHeaders(settings.signingSecret, body, eventId, nowSec) : await buildSignatureHeaders(settings.signingSecret, body, nowSec));
  }
  if (settings.authHeaderName && settings.authHeaderValue) headers[settings.authHeaderName] = settings.authHeaderValue;
  return headers;
}

export async function sendBody(settings: Settings, body: string, eventId: string, opts: SendOptions & { dedupeKey?: string }): Promise<SendResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  const headers = await buildHeaders(settings, body, eventId, opts.version, nowSec, opts.dedupeKey ?? eventId);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetchImpl(settings.webhookUrl, { method: "POST", headers, body, signal: ctrl.signal, credentials: "omit", redirect: "error" });
    const cls = classifyStatus(res.status);
    let error: string | null = null;
    if (!cls.ok) {
      const txt = await res.text().catch(() => "");
      error = `HTTP ${res.status}${txt ? ": " + txt.slice(0, 200) : ""}`;
    }
    return { ok: cls.ok, status: res.status, retryable: cls.retryable, error };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : String(e);
    return { ok: false, status: null, retryable: true, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
