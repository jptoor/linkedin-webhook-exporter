import { describe, expect, it } from "vitest";
import { originPattern, validateWebhookUrl } from "../../src/shared/settings";

describe("validateWebhookUrl", () => {
  it("allows https and localhost http only", () => {
    expect(validateWebhookUrl("https://hooks.example.com/x").ok).toBe(true);
    expect(validateWebhookUrl("http://localhost:8787/hook").ok).toBe(true);
    expect(validateWebhookUrl("http://127.0.0.1:8787/hook").ok).toBe(true);
    expect(validateWebhookUrl("http://hooks.example.com/x").ok).toBe(false);
    expect(validateWebhookUrl("ftp://x").ok).toBe(false);
    expect(validateWebhookUrl("nope").ok).toBe(false);
  });
  it("derives an origin pattern for optional permissions", () => {
    expect(originPattern("https://hooks.example.com/a/b?c")).toBe("https://hooks.example.com/*");
    expect(originPattern("http://localhost:8787/hook")).toBe("http://localhost:8787/*");
  });
});
