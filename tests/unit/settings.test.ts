import { describe, expect, it } from "vitest";
import { activeDestination, originPattern, redactDestination, sanitizeDestination, sanitizeSettings, toContentSettings, validateHeader, validateWebhookUrl } from "../../src/shared/settings";
import { DEFAULT_SETTINGS } from "../../src/shared/types";

describe("validateWebhookUrl", () => {
  it("allows https and localhost http only, no credentials", () => {
    expect(validateWebhookUrl("https://hooks.example.com/x").ok).toBe(true);
    expect(validateWebhookUrl("http://localhost:8787/hook").ok).toBe(true);
    expect(validateWebhookUrl("http://127.0.0.1:8787/hook").ok).toBe(true);
    expect(validateWebhookUrl("http://hooks.example.com/x").ok).toBe(false);
    expect(validateWebhookUrl("https://user:pw@hooks.example.com/x").ok).toBe(false);
    expect(validateWebhookUrl("ftp://x").ok).toBe(false);
    expect(validateWebhookUrl("nope").ok).toBe(false);
  });
  it("derives an origin pattern for optional permissions", () => {
    expect(originPattern("https://hooks.example.com/a/b?c")).toBe("https://hooks.example.com/*");
    expect(originPattern("http://localhost:8787/hook")).toBe("http://localhost:8787/*");
  });
});

describe("validateHeader", () => {
  it("accepts normal headers and rejects reserved/invalid ones", () => {
    expect(validateHeader("Authorization", "Bearer abc").ok).toBe(true);
    expect(validateHeader("x-deepline-webhook-secret", "s3cr3t").ok).toBe(true);
    expect(validateHeader("", "").ok).toBe(true);
    expect(validateHeader("Host", "evil").ok).toBe(false);
    expect(validateHeader("X-LWE-Signature", "forged").ok).toBe(false);
    expect(validateHeader("Content-Type", "text/plain").ok).toBe(false);
    expect(validateHeader("Bad Header", "x").ok).toBe(false);
    expect(validateHeader("X-Ok", "line1\r\nX-Injected: 1").ok).toBe(false);
    expect(validateHeader("X-Ok", "tab\tok").ok).toBe(true);
    expect(validateHeader("X-Ok", "x".repeat(5000)).ok).toBe(false);
  });
});

describe("sanitizeDestination", () => {
  it("coerces a webhook, drops reserved headers, rejects bad URLs", () => {
    const d = sanitizeDestination({ kind: "webhook", url: " https://hooks.example.com/x ", mappingPreset: "evil", sendMode: "batchy", signatureScheme: 42, authHeaderName: "Host", authHeaderValue: "x", favorite: "yes" });
    expect(d).toMatchObject({ kind: "webhook", url: "https://hooks.example.com/x", name: "hooks.example.com", mappingPreset: "generic", sendMode: "single", signatureScheme: "lwe", authHeaderName: "", favorite: false });
    expect(d!.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(sanitizeDestination({ kind: "webhook", url: "http://hooks.example.com/x" })).toBeNull();
    expect(sanitizeDestination({ kind: "bogus" })).toBeNull();
  });
  it("coerces a play destination and infers a permissive input spec when none is stored", () => {
    const d = sanitizeDestination({ kind: "deepline_play", id: "p-1", playKey: " linkedin-capture ", apiKey: "k", baseUrl: "https://code.deepline.com/" });
    expect(d).toMatchObject({ id: "p-1", kind: "deepline_play", name: "linkedin-capture", baseUrl: "https://code.deepline.com", playKey: "linkedin-capture", input: { mode: "mapped", fields: [], acceptsLeads: true, acceptsSearch: true } });
    expect(sanitizeDestination({ kind: "deepline_play", playKey: "x", baseUrl: "http://evil.example" })).toBeNull();
    expect(sanitizeDestination({ kind: "deepline_play", playKey: "", baseUrl: "https://code.deepline.com" })).toBeNull();
    const local = sanitizeDestination({ kind: "deepline_play", playKey: "x", baseUrl: "http://localhost:3000", input: { mode: "batch", fields: ["leads"], required: ["leads", "nope"] } });
    expect(local!.kind === "deepline_play" && local!.input).toMatchObject({ mode: "batch", required: ["leads"] });
  });
});

describe("sanitizeSettings", () => {
  it("coerces garbage into valid settings with defaults and clamps", () => {
    const s = sanitizeSettings({ dailyCap: "-5", dedupeTtlDays: NaN, searchDefaultLimit: 99999, customFields: { "bad key!": "v", ok: 1, ["x".repeat(100)]: "y" }, includeAbout: "yes", destinations: "nope", activeDestinationId: 5 });
    expect(s.dailyCap).toBe(1);
    expect(s.dedupeTtlDays).toBe(DEFAULT_SETTINGS.dedupeTtlDays);
    expect(s.searchDefaultLimit).toBe(2500);
    expect(s.customFields).toEqual({ bad_key_: "v", ["x".repeat(60)]: "y" });
    expect(s.includeAbout).toBe(true);
    expect(s.destinations).toEqual([]);
    expect(s.activeDestinationId).toBeNull();
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("string")).toEqual(DEFAULT_SETTINGS);
  });
  it("migrates a v1 single-webhook configuration into the first destination", () => {
    const s = sanitizeSettings({ webhookUrl: "https://hooks.example.com/x", signingSecret: "S", signatureScheme: "standard", mappingPreset: "deepline", sendMode: "batch", authHeaderName: "Authorization", authHeaderValue: "Bearer T" });
    expect(s.destinations).toHaveLength(1);
    expect(s.destinations[0]).toMatchObject({ id: "legacy-webhook", kind: "webhook", url: "https://hooks.example.com/x", signingSecret: "S", signatureScheme: "standard", mappingPreset: "deepline", sendMode: "batch", authHeaderValue: "Bearer T" });
    expect(s.activeDestinationId).toBe("legacy-webhook");
    // Once destinations exist the legacy fields are ignored.
    const s2 = sanitizeSettings({ webhookUrl: "https://other.example/x", destinations: s.destinations });
    expect(s2.destinations).toHaveLength(1);
    expect(s2.destinations[0].kind === "webhook" && s2.destinations[0].url).toBe("https://hooks.example.com/x");
  });
  it("drops duplicate ids, keeps the active id only when it exists, bounds the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: "webhook", id: `d${i}`, url: `https://h${i}.example/x` }));
    const s = sanitizeSettings({ destinations: [...many, { kind: "webhook", id: "d1", url: "https://dup.example/x" }], activeDestinationId: "missing" });
    expect(s.destinations).toHaveLength(25);
    expect(s.destinations.filter((d) => d.id === "d1")).toHaveLength(1);
    expect(s.activeDestinationId).toBe("d0");
    expect(activeDestination(s)?.id).toBe("d0");
  });
  it("bounds custom fields count and values", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(1000)]));
    const s = sanitizeSettings({ customFields: many });
    expect(Object.keys(s.customFields)).toHaveLength(20);
    expect(s.customFields.k0.length).toBe(500);
  });
  it("content settings and redacted destinations never include secrets", () => {
    const s = sanitizeSettings({ destinations: [{ kind: "webhook", id: "w", name: "Hook", url: "https://x/y", signingSecret: "SECRET1", authHeaderName: "Authorization", authHeaderValue: "Bearer TOKEN1" }, { kind: "deepline_play", id: "p", playKey: "k", baseUrl: "https://code.deepline.com", apiKey: "dl_SECRET2" }], activeDestinationId: "p" });
    const c = toContentSettings(s);
    expect(JSON.stringify(c)).not.toMatch(/SECRET|TOKEN/);
    expect(c).toMatchObject({ hasDestination: true, destinationKind: "deepline_play", destinationName: "k" });
    expect(Object.keys(c).sort()).toEqual(["dedupe", "destinationKind", "destinationName", "hasDestination", "includeAbout", "includeEducation", "includeExperience", "intercept", "searchDefaultLimit"]);
    const red = s.destinations.map(redactDestination);
    expect(JSON.stringify(red)).not.toMatch(/SECRET|TOKEN/);
  });
});
