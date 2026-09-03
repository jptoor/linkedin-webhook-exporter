import { describe, expect, it } from "vitest";
import { afterAttempt, backoffFor, due, MAX_ATTEMPTS, newItem, nextWake, prune } from "../../src/background/queue";
import { classifyStatus } from "../../src/background/sender";

const T = 1_000_000;

describe("queue transitions", () => {
  it("marks sent on success", () => {
    const i = afterAttempt(newItem("a", "{}", ["u"], 1, T, "u"), { ok: true, status: 200, retryable: false, error: null }, T + 1);
    expect(i.status).toBe("sent");
    expect(i.dedupeKey).toBe("u");
    expect(newItem("b", "{}", [], 2, T).dedupeKey).toBe("b");
    expect(i.attempts).toBe(1);
  });
  it("schedules retry with backoff on retryable failure", () => {
    let i = newItem("a", "{}", ["u"], 1, T);
    i = afterAttempt(i, { ok: false, status: 503, retryable: true, error: "HTTP 503" }, T);
    expect(i.status).toBe("pending");
    expect(i.nextAttemptAt).toBe(T + backoffFor(1));
    i = afterAttempt(i, { ok: false, status: null, retryable: true, error: "timeout" }, T);
    expect(i.nextAttemptAt).toBe(T + backoffFor(2));
    expect(backoffFor(2)).toBeGreaterThan(backoffFor(1));
  });
  it("fails permanently on non-retryable status", () => {
    const i = afterAttempt(newItem("a", "{}", ["u"], 1, T), { ok: false, status: 401, retryable: false, error: "HTTP 401" }, T);
    expect(i.status).toBe("failed");
  });
  it("fails after MAX_ATTEMPTS retryable failures", () => {
    let i = newItem("a", "{}", ["u"], 1, T);
    for (let k = 0; k < MAX_ATTEMPTS; k++) i = afterAttempt(i, { ok: false, status: 500, retryable: true, error: "x" }, T);
    expect(i.status).toBe("failed");
    expect(i.attempts).toBe(MAX_ATTEMPTS);
  });
  it("due() returns only pending items whose time has come, oldest first", () => {
    const a = { ...newItem("a", "{}", [], 1, T + 5), nextAttemptAt: T + 5 };
    const b = { ...newItem("b", "{}", [], 1, T), nextAttemptAt: T + 999 };
    const c = { ...newItem("c", "{}", [], 1, T + 1), status: "sent" as const };
    const d = { ...newItem("d", "{}", [], 1, T + 2) };
    expect(due([a, b, c, d], T + 10).map((i) => i.id)).toEqual(["d", "a"]);
    expect(nextWake([a, b])).toBe(T + 5);
    expect(nextWake([c])).toBeNull();
  });
  it("prune drops old sent items and caps size", () => {
    const old = { ...newItem("old", "{}", [], 1, 0), status: "sent" as const };
    const fresh = newItem("fresh", "{}", [], 1, T);
    expect(prune([old, fresh], T + 2 * 86_400_000).map((i) => i.id)).toEqual(["fresh"]);
    const many = Array.from({ length: 600 }, (_, k) => newItem(String(k), "{}", [], 1, k));
    expect(prune(many, 0, 1e12, 500)).toHaveLength(500);
  });
});

describe("classifyStatus", () => {
  it("2xx ok, 5xx/429/408 retryable, other 4xx permanent", () => {
    expect(classifyStatus(200)).toEqual({ ok: true, retryable: false });
    expect(classifyStatus(204)).toEqual({ ok: true, retryable: false });
    expect(classifyStatus(429)).toEqual({ ok: false, retryable: true });
    expect(classifyStatus(503)).toEqual({ ok: false, retryable: true });
    expect(classifyStatus(408)).toEqual({ ok: false, retryable: true });
    expect(classifyStatus(400)).toEqual({ ok: false, retryable: false });
    expect(classifyStatus(401)).toEqual({ ok: false, retryable: false });
    expect(classifyStatus(404)).toEqual({ ok: false, retryable: false });
  });
});
