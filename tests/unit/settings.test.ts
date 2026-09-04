import { describe, expect, it } from "vitest";
import { originPattern, sanitizeSettings, toContentSettings, validateHeader, validateWebhookUrl } from "../../src/shared/settings";
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

describe("sanitizeSettings", () => {
  it("coerces garbage into valid settings with defaults and clamps", () => {
    const s = sanitizeSettings({ dailyCap: "-5", dedupeTtlDays: NaN, mappingPreset: "evil", sendMode: "batchy", signatureScheme: 42, exportDefaultLimit: 99999, exportPageDelayMinMs: 0, exportPageDelayMaxMs: 10, customFields: { "bad key!": "v", ok: 1, ["x".repeat(100)]: "y" }, authHeaderName: "Host", authHeaderValue: "x", includeAbout: "yes" });
    expect(s.dailyCap).toBe(1);
    expect(s.dedupeTtlDays).toBe(DEFAULT_SETTINGS.dedupeTtlDays);
    expect(s.mappingPreset).toBe("generic");
    expect(s.sendMode).toBe("single");
    expect(s.signatureScheme).toBe("lwe");
    expect(s.exportDefaultLimit).toBe(2500);
    expect(s.exportPageDelayMinMs).toBe(1000);
    expect(s.exportPageDelayMaxMs).toBe(1000);
    expect(s.customFields).toEqual({ bad_key_: "v", ["x".repeat(60)]: "y" });
    expect(s.authHeaderName).toBe(""); // reserved header dropped
    expect(s.includeAbout).toBe(true);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("string")).toEqual(DEFAULT_SETTINGS);
  });
  it("bounds custom fields count and values", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(1000)]));
    const s = sanitizeSettings({ customFields: many });
    expect(Object.keys(s.customFields)).toHaveLength(20);
    expect(s.customFields.k0.length).toBe(500);
  });
  it("content settings never include secrets", () => {
    const c = toContentSettings({ ...DEFAULT_SETTINGS, webhookUrl: "https://x/y", signingSecret: "S", authHeaderValue: "Bearer T" });
    expect(JSON.stringify(c)).not.toMatch(/S"|Bearer/);
    expect(c.hasWebhook).toBe(true);
    expect(Object.keys(c).sort()).toEqual(["dedupe", "exportDefaultLimit", "hasWebhook", "includeAbout", "includeEducation", "includeExperience", "sendMode"]);
  });
});
