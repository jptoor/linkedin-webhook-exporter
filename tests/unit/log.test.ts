import { describe, expect, it } from "vitest";
import { append, redact } from "../../src/shared/log";

describe("activity log", () => {
  it("redacts secret-looking keys and bounds values", () => {
    const r = redact({ signingSecret: "S", authHeaderValue: "Bearer x", Authorization: "y", cookie: "c", ok: "v".repeat(500), n: 1, b: true, nul: null, arr: Array.from({ length: 100 }, () => "a".repeat(300)), obj: { deep: "x".repeat(500) } })!;
    expect(r.signingSecret).toBe("[redacted]");
    expect(r.authHeaderValue).toBe("[redacted]");
    expect(r.Authorization).toBe("[redacted]");
    expect(r.cookie).toBe("[redacted]");
    expect((r.ok as string).length).toBe(300);
    expect(r.n).toBe(1);
    expect(r.nul).toBeNull();
    expect((r.arr as string[]).length).toBe(50);
    expect((r.arr as string[])[0].length).toBe(200);
    expect(((r.obj as Record<string, unknown>).deep as string).length).toBe(300); // nested objects are redacted recursively, not stringified
    expect(redact(undefined)).toBeUndefined();
  });
  it("append keeps a bounded ring buffer", () => {
    let log: ReturnType<typeof append> = [];
    for (let i = 0; i < 12; i++) log = append(log, { t: i, kind: "error", msg: String(i) }, 10);
    expect(log).toHaveLength(10);
    expect(log[0].msg).toBe("2");
    expect(log[9].msg).toBe("11");
  });
});
