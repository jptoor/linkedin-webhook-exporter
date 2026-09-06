import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSession, identityKey, isDeeplineTab, keySession, pollClaim, registerDevice, signInUrl } from "../../src/background/auth";
import { failureReportBody, fetchFlags, reportError, scrubProperties, scrubText, segmentPayload, track, type TelemetryContext } from "../../src/shared/telemetry";
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
  it("asks the session endpoint with credentials: include and no cookies API; reads the user and active org", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (u: string, i: RequestInit) => {
      init = i;
      expect(u).toBe("https://code.deepline.com/api/v2/auth/session");
      return new Response(JSON.stringify({ session: { user: { id: "u1", email: "jai@deepline.com", name: "Jai" }, activeOrgId: "org_1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await fetchSession("https://code.deepline.com/", fetchImpl);
    expect(s).toMatchObject({ signedIn: true, userId: "u1", email: "jai@deepline.com", name: "Jai", orgId: "org_1", baseUrl: "https://code.deepline.com" });
    expect(init?.credentials).toBe("include");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    const anon = await fetchSession("https://code.deepline.com", (async () => new Response(JSON.stringify({ session: null }), { status: 200 })) as unknown as typeof fetch);
    expect(anon).toMatchObject({ signedIn: false, error: null });
    const down = await fetchSession("https://code.deepline.com", (async () => new Response("", { status: 503 })) as unknown as typeof fetch);
    expect(down).toMatchObject({ signedIn: false, error: "HTTP 503" });
    const boom = await fetchSession("https://code.deepline.com", (async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch);
    expect(boom).toMatchObject({ signedIn: false, error: "Failed to fetch" });
  });
  it("identity binds user and org; Deepline tabs are recognised by exact origin; sign-in URL is on the base", () => {
    expect(identityKey({ signedIn: true, userId: "u1", orgId: "org_1" })).toBe("u1|org_1");
    expect(identityKey({ signedIn: true, userId: "u1", orgId: null })).toBe("u1|");
    expect(identityKey({ signedIn: false, userId: "u1", orgId: "org_1" })).toBeNull();
    expect(identityKey(null)).toBeNull();
    expect(isDeeplineTab("https://code.deepline.com/sign-in", "https://code.deepline.com")).toBe(true);
    expect(isDeeplineTab("https://code.deepline.com.evil.example/", "https://code.deepline.com")).toBe(false);
    expect(isDeeplineTab("http://code.deepline.com/", "https://code.deepline.com")).toBe(false);
    expect(isDeeplineTab(undefined, "https://code.deepline.com")).toBe(false);
    expect(signInUrl("https://code.deepline.com/")).toBe("https://code.deepline.com/sign-in");
  });
  it("scrubs secrets, e-mails and query strings out of free text", () => {
    const t = scrubText("Bearer dl_abcdef123 failed for jai@deepline.com at https://code.deepline.com/x?sessionId=S1 whsec_QUJD token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop");
    expect(t).not.toMatch(/dl_abcdef123|jai@|sessionId=S1|whsec_QUJD|eyJhbGci/);
    expect(t).toContain("Bearer [redacted]");
    expect(t).toContain("[email]");
    expect(t).toContain("https://code.deepline.com/x?[query]");
    expect(t).toContain("[jwt]");
    const body = failureReportBody({ where: "flush", message: "Error: 401 for rep@acme.com", stack: "at fetch (https://code.deepline.com/api?sessionId=S)", context: { url: "https://x/?sessionId=1", count: 2 } });
    expect(JSON.stringify(body)).not.toMatch(/rep@acme|sessionId=/);
    expect(body).toMatchObject({ error_body: "Error: 401 for [email]", context: { count: 2 } });
  });
});

describe("device key (Connect Deepline)", () => {
  const claim = { baseUrl: "https://code.deepline.com", claimToken: "tok_1", claimUrl: "https://code.deepline.com/api/v2/auth/cli/claim/tok_1", startedAt: 0, expiresAt: 0 };
  const reply = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("registers with the CLI's payload and client headers, never cookies, and refuses a claim URL on another origin", async () => {
    let init: RequestInit | undefined;
    const f = (async (u: string, i: RequestInit) => {
      init = i;
      expect(u).toBe("https://code.deepline.com/api/v2/auth/cli/register");
      return new Response(JSON.stringify({ claim_url: "https://code.deepline.com/api/v2/auth/cli/claim/tok_1", claim_token: "tok_1", claim_expires_at: "2026-09-07T22:12:21.406Z", rate_limit_tier: "unclaimed", cli_message: "Nice!" }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = await registerDevice("https://code.deepline.com/", "1.2.3", f);
    expect(c).toMatchObject({ baseUrl: "https://code.deepline.com", claimToken: "tok_1", claimUrl: "https://code.deepline.com/api/v2/auth/cli/claim/tok_1", expiresAt: Date.parse("2026-09-07T22:12:21.406Z") });
    // No or unparsable expiry: 24 h from now, never unbounded.
    const c2 = await registerDevice("https://code.deepline.com", "1", reply(200, { claim_url: "https://code.deepline.com/api/v2/auth/cli/claim/t", claim_token: "t" }));
    expect(c2.expiresAt).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store" });
    expect(init?.headers).toMatchObject({ "X-Deepline-Client-Family": "chrome-extension", "X-Deepline-Client-Version": "1.2.3" });
    expect(JSON.parse(String(init?.body))).toEqual({ agent_name: "Chrome extension: Deepline for LinkedIn" });
    await expect(registerDevice("https://code.deepline.com", "1", reply(200, { claim_url: "https://evil.example/claim", claim_token: "t" }))).rejects.toThrow(/no approval link/);
    await expect(registerDevice("https://code.deepline.com", "1", reply(503))).rejects.toThrow(/503/);
  });
  it("polls a claim with the CLI's status handling", async () => {
    expect(await pollClaim(claim, "1", reply(200, { status: "pending", api_key_id: "k1", user_id: null, user_email: null, org_id: null }))).toEqual({ state: "pending" });
    expect(await pollClaim(claim, "1", reply(503))).toEqual({ state: "pending" });
    expect(await pollClaim(claim, "1", reply(400))).toEqual({ state: "pending" });
    expect(await pollClaim(claim, "1", (async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch)).toEqual({ state: "pending" });
    expect(await pollClaim(claim, "1", reply(401))).toEqual({ state: "unauthorized" });
    expect(await pollClaim(claim, "1", reply(403))).toEqual({ state: "unauthorized" });
    expect(await pollClaim(claim, "1", reply(200, { status: "expired" }))).toEqual({ state: "expired" });
    expect(await pollClaim(claim, "1", reply(200, { status: "claimed" }))).toEqual({ state: "pending" }); // no key yet
    const done = await pollClaim(claim, "1", reply(200, { status: "claimed", api_key: "dl_k", api_key_id: "k1", user_id: "u1", user_email: "rep@acme.com", org_id: "o1", org_name: "Acme", org_slug: "acme" }));
    expect(done).toMatchObject({ state: "claimed", connection: { baseUrl: "https://code.deepline.com", apiKey: "dl_k", apiKeyId: "k1", userId: "u1", email: "rep@acme.com", orgId: "o1", orgName: "Acme" } });
  });
  it("checks a key with `{ api_key }` as bearer; 401/403 means revoked, other failures keep the stored identity", async () => {
    const conn = { baseUrl: "https://code.deepline.com", apiKey: "dl_k", apiKeyId: "k1", userId: "u1", email: "rep@acme.com", orgId: "o1", orgName: "Acme", connectedAt: 1 };
    let init: RequestInit | undefined;
    const ok = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response(JSON.stringify({ status: "active", api_key_id: "k1", user_id: "u1", user_email: "rep@acme.com", org_id: "o2", org_name: "Acme 2", org_slug: "acme-2" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await keySession(conn, "1", ok)).toMatchObject({ signedIn: true, userId: "u1", email: "rep@acme.com", orgId: "o2", name: "Acme 2", keyId: "k1", revoked: false, error: null });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer dl_k");
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(JSON.parse(String(init?.body))).toEqual({ api_key: "dl_k" });
    expect(await keySession(conn, "1", reply(403))).toMatchObject({ signedIn: false, revoked: true, error: "key_revoked" });
    expect(await keySession(conn, "1", reply(503))).toMatchObject({ signedIn: true, userId: "u1", orgId: "o1", revoked: false, error: "HTTP 503" });
    expect(identityKey(await keySession(conn, "1", reply(503)))).toBe("u1|o1");
  });
});
