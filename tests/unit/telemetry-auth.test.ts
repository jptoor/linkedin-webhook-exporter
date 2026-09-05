import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSession, hasSessionCookie, isSessionCookieChange, signInUrl } from "../../src/background/auth";
import { failureReportBody, fetchFlags, reportError, scrubProperties, segmentPayload, track, type TelemetryContext } from "../../src/shared/telemetry";
import { makeFakeChrome } from "./fake-chrome";

const ctx = (over: Partial<TelemetryContext> = {}): TelemetryContext => ({ enabled: true, anonymousId: "anon-1", userId: "u1", orgId: "o1", baseUrl: "https://code.deepline.com", apiKey: null, ...over });

beforeEach(() => {
  const fake = makeFakeChrome();
  (globalThis as any).chrome = fake.chrome;
});

describe("telemetry", () => {
  it("scrubs secrets and people from event properties", () => {
    expect(scrubProperties({ count: 3, api_key: "dl_x", email: "a@b.c", full_name: "Jane", page_type: "profile", nested: { x: 1 }, long: "x".repeat(500) })).toEqual({ count: 3, page_type: "profile", long: "x".repeat(200) });
  });
  it("builds a Segment track payload with extension metadata and the Deepline user id", () => {
    const p = segmentPayload(ctx(), { event: "push_queued", properties: { count: 2, destination_kind: "deepline_play" } }, new Date("2026-09-05T00:00:00Z"));
    expect(p).toMatchObject({ event: "push_queued", anonymousId: "anon-1", userId: "u1", timestamp: "2026-09-05T00:00:00.000Z" });
    expect(p.properties).toMatchObject({ extension: "deepline-for-linkedin", count: 2, org_id: "o1" });
    expect((p.properties as any).version).toBeTruthy();
    expect(segmentPayload(ctx({ userId: null }), { event: "x" }).userId).toBeUndefined();
  });
  it("without a compiled write key, track only logs locally and never fetches", async () => {
    const fetchImpl = vi.fn();
    const r = await track(ctx({ fetchImpl: fetchImpl as unknown as typeof fetch }), { event: "installed" });
    expect(r.sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    const log = ((globalThis as any).chrome.storage.local as any);
    const entries = (await log.get("activityLog")).activityLog as any[];
    expect(entries.at(-1)).toMatchObject({ kind: "telemetry.event", msg: "Event: installed" });
  });
  it("reports errors to Deepline's failure endpoint with the session or an API key, and never when disabled or signed out", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (u: string, init: RequestInit) => {
      calls.push([u, init]);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect((await reportError(ctx({ fetchImpl }), { where: "service-worker", message: "TypeError: boom", stack: "at x" })).sent).toBe(true);
    expect(calls[0][0]).toBe("https://code.deepline.com/api/v2/cli/report-failure");
    expect(calls[0][1].credentials).toBe("include");
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toMatchObject({ command: "chrome-extension", failure_kind: "extension_error", error_class: "TypeError", log_source: "chrome-extension", subcommand: "service-worker" });
    expect(body.context).toMatchObject({ extension: "deepline-for-linkedin" });
    await reportError(ctx({ fetchImpl, apiKey: "dl_k" }), { where: "panel", message: "x" });
    expect((calls[1][1].headers as Record<string, string>).Authorization).toBe("Bearer dl_k");
    expect(calls[1][1].credentials).toBe("omit");
    expect((await reportError(ctx({ fetchImpl, enabled: false }), { where: "p", message: "x" })).sent).toBe(false);
    expect((await reportError(ctx({ fetchImpl, baseUrl: null }), { where: "p", message: "x" })).sent).toBe(false);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(failureReportBody({ where: "w", message: "m", context: { api_key: "secret" } }))).not.toContain("secret");
  });
  it("feature flags keep defaults on failure and accept only known booleans", async () => {
    expect(await fetchFlags(null)).toEqual({ intercept: true, session_auth: true, search_import: true, telemetry: true });
    expect(await fetchFlags("https://code.deepline.com", (async () => new Response("", { status: 404 })) as unknown as typeof fetch)).toMatchObject({ intercept: true });
    expect(await fetchFlags("https://code.deepline.com", (async () => new Response(JSON.stringify({ intercept: false, telemetry: "no", bogus: true }), { status: 200 })) as unknown as typeof fetch)).toEqual({ intercept: false, session_auth: true, search_import: true, telemetry: true });
  });
});

describe("session auth", () => {
  const cookies = (present: boolean) => ({ get: async () => (present ? { name: "better-auth.session_token" } : null) }) as unknown as typeof chrome.cookies;
  it("is signed out without the session cookie and never calls the API then", async () => {
    const fetchImpl = vi.fn();
    const s = await fetchSession("https://code.deepline.com", fetchImpl as unknown as typeof fetch, cookies(false));
    expect(s).toMatchObject({ signedIn: false, baseUrl: "https://code.deepline.com", error: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await hasSessionCookie("https://code.deepline.com", cookies(true))).toBe(true);
  });
  it("reads the user and active org from /api/v2/auth/session using credentials: include", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (u: string, i: RequestInit) => {
      init = i;
      expect(u).toBe("https://code.deepline.com/api/v2/auth/session");
      return new Response(JSON.stringify({ session: { user: { id: "u1", email: "jai@deepline.com", name: "Jai" }, activeOrgId: "org_1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await fetchSession("https://code.deepline.com/", fetchImpl, cookies(true));
    expect(s).toMatchObject({ signedIn: true, userId: "u1", email: "jai@deepline.com", name: "Jai", orgId: "org_1" });
    expect(init?.credentials).toBe("include");
    expect(init?.redirect).toBe("error");
    const anon = await fetchSession("https://code.deepline.com", (async () => new Response(JSON.stringify({ session: null }), { status: 200 })) as unknown as typeof fetch, cookies(true));
    expect(anon.signedIn).toBe(false);
    const down = await fetchSession("https://code.deepline.com", (async () => new Response("", { status: 503 })) as unknown as typeof fetch, cookies(true));
    expect(down).toMatchObject({ signedIn: false, error: "HTTP 503" });
  });
  it("only reacts to session cookie changes on the Deepline host; sign-in URL is on the base", () => {
    expect(isSessionCookieChange({ cookie: { name: "better-auth.session_token", domain: "code.deepline.com" } }, "https://code.deepline.com")).toBe(true);
    expect(isSessionCookieChange({ cookie: { name: "__Secure-better-auth.session_token", domain: ".deepline.com" } }, "https://code.deepline.com")).toBe(true);
    expect(isSessionCookieChange({ cookie: { name: "better-auth.session_token", domain: "evil.example" } }, "https://code.deepline.com")).toBe(false);
    expect(isSessionCookieChange({ cookie: { name: "li_at", domain: "code.deepline.com" } }, "https://code.deepline.com")).toBe(false);
    expect(signInUrl("https://code.deepline.com/")).toBe("https://code.deepline.com/sign-in");
  });
});
