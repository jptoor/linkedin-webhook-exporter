/** Telemetry, feature flags and error reporting, in the shape commercial
 *  extensions (Frontier: Sentry + Segment + LaunchDarkly) ship them, without
 *  bundling any vendor SDK:
 *
 *  - Product events: Segment-compatible `track` calls (extension version,
 *    user agent, time zone, anonymous id, Deepline user id when signed in).
 *    Sent to Segment's HTTP API when a write key is compiled in
 *    (`SEGMENT_WRITE_KEY` at build time); otherwise only kept in the local
 *    activity log. Never contains people data from LinkedIn.
 *  - Error reports: uncaught errors and rejections go to Deepline's failure
 *    reporting endpoint (`POST /api/v2/cli/report-failure`, the same channel
 *    the SDK CLI uses) when a Deepline session or API key is available.
 *  - Feature flags: local defaults, optionally overridden by a JSON document
 *    fetched from the Deepline base URL. Unknown or failed fetches keep the
 *    defaults, so the extension works offline.
 *
 *  Everything is gated by the `telemetry` setting. */
import { logEvent } from "./log";

declare const __SEGMENT_WRITE_KEY__: string;
declare const __EXTENSION_VERSION__: string;

export const VERSION = typeof __EXTENSION_VERSION__ === "string" ? __EXTENSION_VERSION__ : "dev";
const SEGMENT_KEY = typeof __SEGMENT_WRITE_KEY__ === "string" ? __SEGMENT_WRITE_KEY__ : "";
const SEGMENT_URL = "https://api.segment.io/v1/track";

export type FlagName = "intercept" | "session_auth" | "search_import" | "telemetry";
export type Flags = Record<FlagName, boolean>;
export const DEFAULT_FLAGS: Flags = { intercept: true, session_auth: true, search_import: true, telemetry: true };

export interface TelemetryContext {
  /** Whether the operator allows telemetry (settings). */
  enabled: boolean;
  anonymousId: string;
  userId: string | null;
  orgId: string | null;
  /** Where error reports go; null when neither a session nor an API key exists. */
  baseUrl: string | null;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
}

export interface TrackEvent {
  event: string;
  properties?: Record<string, unknown>;
}

const SENSITIVE = /secret|token|password|authorization|cookie|api_?key|email|linkedin_url|full_name|first_name|last_name|url|href|name/i;

/** Redact secret- and person-shaped substrings inside free text (error
 *  messages, stacks, property values): bearer/basic credentials, Deepline
 *  keys, Standard Webhooks secrets, JWT-looking blobs, e-mail addresses, and
 *  query strings (which may carry session ids). */
export function scrubText(v: string, max = 4000): string {
  return v
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 [redacted]")
    .replace(/\bdl_[A-Za-z0-9_-]{4,}/g, "dl_[redacted]")
    .replace(/\bwhsec_[A-Za-z0-9+/=_-]{4,}/g, "whsec_[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/g, "$1?[query]")
    .slice(0, max);
}

/** Drop anything that looks like a secret or a person from event properties;
 *  scrub the values that remain. */
export function scrubProperties(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (SENSITIVE.test(k)) continue;
    if (typeof v === "string") out[k] = scrubText(v, 200);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}

export function baseProperties(): Record<string, unknown> {
  return {
    extension: "deepline-for-linkedin",
    version: VERSION,
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 200) : null,
    timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : null
  };
}

/** Segment HTTP API `track` body. Exported so it can be unit-tested. */
export function segmentPayload(ctx: TelemetryContext, ev: TrackEvent, now = new Date()): Record<string, unknown> {
  return {
    event: ev.event,
    anonymousId: ctx.anonymousId,
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    properties: { ...baseProperties(), ...scrubProperties(ev.properties), ...(ctx.orgId ? { org_id: ctx.orgId } : {}) },
    context: { library: { name: "deepline-for-linkedin", version: VERSION }, userAgent: baseProperties().user_agent, timezone: baseProperties().timezone },
    timestamp: now.toISOString()
  };
}

/** Record a product event. Always logged locally; sent to Segment when a
 *  write key is compiled in and telemetry is enabled. Never throws. */
export async function track(ctx: TelemetryContext, ev: TrackEvent): Promise<{ sent: boolean }> {
  const props = scrubProperties(ev.properties);
  await logEvent("telemetry.event", `Event: ${ev.event}`, { event: ev.event, ...props, sent: ctx.enabled && !!SEGMENT_KEY }).catch(() => undefined);
  if (!ctx.enabled || !SEGMENT_KEY) return { sent: false };
  try {
    const f = ctx.fetchImpl ?? fetch;
    const res = await f(SEGMENT_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(SEGMENT_KEY + ":")}` }, body: JSON.stringify(segmentPayload(ctx, ev)), credentials: "omit", redirect: "error" });
    return { sent: res.ok };
  } catch {
    return { sent: false };
  }
}

export interface ErrorReport {
  where: string;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown>;
}

/** Body for Deepline's failure-reporting endpoint (shared with the SDK CLI). */
export function failureReportBody(rep: ErrorReport): Record<string, unknown> {
  const message = scrubText(rep.message, 4000);
  return {
    command: "chrome-extension",
    subcommand: scrubText(rep.where, 200),
    cli_version: VERSION,
    failure_kind: "extension_error",
    failure_code: message.slice(0, 200),
    failure_stage: scrubText(rep.where, 200),
    error_class: message.split(":")[0].slice(0, 200),
    error_body: message,
    stack_trace: rep.stack ? scrubText(rep.stack, 8000) : null,
    log_source: "chrome-extension",
    context: { ...baseProperties(), ...scrubProperties(rep.context) }
  };
}

/** Report an error to Deepline. Uses the API key when the operator configured
 *  one, otherwise the browser session (cookies). Never throws. */
export async function reportError(ctx: TelemetryContext, rep: ErrorReport): Promise<{ sent: boolean }> {
  await logEvent("error", `${rep.where}: ${rep.message}`, { where: rep.where, stack: rep.stack?.slice(0, 500) ?? null }).catch(() => undefined);
  if (!ctx.enabled || !ctx.baseUrl) return { sent: false };
  try {
    const f = ctx.fetchImpl ?? fetch;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
    const res = await f(`${ctx.baseUrl}/api/v2/cli/report-failure`, { method: "POST", headers, body: JSON.stringify(failureReportBody(rep)), credentials: ctx.apiKey ? "omit" : "include", redirect: "error" });
    return { sent: res.ok };
  } catch {
    return { sent: false };
  }
}

/** Fetch remote flags from `<base>/api/v2/extension/flags`; keep defaults on
 *  any failure. Unknown keys are ignored, values must be booleans. */
export async function fetchFlags(baseUrl: string | null, fetchImpl: typeof fetch = fetch, defaults: Flags = DEFAULT_FLAGS): Promise<Flags> {
  if (!baseUrl) return { ...defaults };
  try {
    const res = await fetchImpl(`${baseUrl}/api/v2/extension/flags?version=${encodeURIComponent(VERSION)}`, { credentials: "omit", redirect: "error" });
    if (!res.ok) return { ...defaults };
    const json = (await res.json()) as Record<string, unknown>;
    const out = { ...defaults };
    for (const k of Object.keys(defaults) as FlagName[]) if (typeof json[k] === "boolean") out[k] = json[k] as boolean;
    return out;
  } catch {
    return { ...defaults };
  }
}

/** Install global handlers in a worker or page context. */
export function installErrorHandlers(where: string, report: (rep: ErrorReport) => void): void {
  const g = globalThis as unknown as { addEventListener?: (t: string, l: (e: unknown) => void) => void };
  if (typeof g.addEventListener !== "function") return;
  g.addEventListener("error", (e) => {
    const ev = e as ErrorEvent;
    report({ where, message: String(ev.message ?? ev.error ?? "error"), stack: ev.error instanceof Error ? ev.error.stack : null });
  });
  g.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    report({ where, message: r instanceof Error ? r.message : String(r), stack: r instanceof Error ? (r.stack ?? null) : null });
  });
}
