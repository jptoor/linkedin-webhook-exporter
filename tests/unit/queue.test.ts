import { describe, expect, it } from "vitest";
import { afterAttempt, backoffFor, claim, clearQueue, due, LEASE_MS, MAX_ATTEMPTS, newItem, nextWake, prune, recoverStaleLeases } from "../../src/background/queue";
import { classifyStatus } from "../../src/background/sender";

const T = 1_000_000;
const D = { id: "d1", kind: "webhook" as const };
const ni = (id: string, body: string, urls: string[], count: number, now: number, key: string = id) => newItem(id, body, urls, count, now, key, D);

describe("queue transitions", () => {
  it("claim increments attempts and leases; sent on success", () => {
    const c = claim(ni("a", "{}", ["u"], 1, T, "u"), T);
    expect(c).toMatchObject({ status: "sending", sendingAt: T, attempts: 1, dedupeKey: "u" });
    const i = afterAttempt(c, { ok: true, status: 200, retryable: false, error: null }, T + 1);
    expect(i).toMatchObject({ status: "sent", attempts: 1, sendingAt: null });
    expect(ni("b", "{}", [], 2, T).dedupeKey).toBe("b");
  });
  it("schedules retry with growing backoff on retryable failure", () => {
    let i = claim(ni("a", "{}", ["u"], 1, T), T);
    i = afterAttempt(i, { ok: false, status: 503, retryable: true, error: "HTTP 503" }, T);
    expect(i.status).toBe("pending");
    expect(i.nextAttemptAt).toBe(T + backoffFor(1));
    i = afterAttempt(claim(i, T), { ok: false, status: null, retryable: true, error: "timeout" }, T);
    expect(i.nextAttemptAt).toBe(T + backoffFor(2));
    expect(backoffFor(2)).toBeGreaterThan(backoffFor(1));
    expect(backoffFor(99)).toBe(backoffFor(5));
    expect(backoffFor(0)).toBe(backoffFor(1));
  });
  it("fails permanently on non-retryable status and after MAX_ATTEMPTS", () => {
    expect(afterAttempt(claim(ni("a", "{}", ["u"], 1, T), T), { ok: false, status: 401, retryable: false, error: "HTTP 401" }, T).status).toBe("failed");
    let i = ni("a", "{}", ["u"], 1, T);
    for (let k = 0; k < MAX_ATTEMPTS; k++) i = afterAttempt(claim(i, T), { ok: false, status: 500, retryable: true, error: "x" }, T);
    expect(i).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
  });
  it("recovers stale leases (worker suspended mid-request) but not fresh ones", () => {
    const stale = claim(ni("s", "{}", ["u"], 1, T), T);
    const fresh = claim(ni("f", "{}", ["u"], 1, T), T + LEASE_MS - 1000);
    const exhausted = { ...claim(ni("x", "{}", ["u"], 1, T), T), attempts: MAX_ATTEMPTS };
    const legacy = { ...claim(ni("l", "{}", ["u"], 1, T), T), sendingAt: null }; // pre-lease schema
    const out = recoverStaleLeases([stale, fresh, exhausted, legacy], T + LEASE_MS + 1);
    expect(out.find((i) => i.id === "s")).toMatchObject({ status: "pending", sendingAt: null, lastError: "lease_expired" });
    expect(out.find((i) => i.id === "f")!.status).toBe("sending");
    expect(out.find((i) => i.id === "x")!.status).toBe("failed");
    expect(out.find((i) => i.id === "l")!.status).toBe("pending");
    expect(recoverStaleLeases(out, T + LEASE_MS + 1)).toEqual(out); // idempotent
  });
  it("due() returns only pending items whose time has come, oldest first; nextWake includes leases", () => {
    const a = { ...ni("a", "{}", [], 1, T + 5), nextAttemptAt: T + 5 };
    const b = { ...ni("b", "{}", [], 1, T), nextAttemptAt: T + 999 };
    const c = { ...ni("c", "{}", [], 1, T + 1), status: "sent" as const };
    const d = { ...ni("d", "{}", [], 1, T + 2) };
    expect(due([a, b, c, d], T + 10).map((i) => i.id)).toEqual(["d", "a"]);
    expect(nextWake([a, b])).toBe(T + 5);
    expect(nextWake([c])).toBeNull();
    expect(nextWake([claim(ni("s", "{}", [], 1, T), T)])).toBe(T + LEASE_MS);
  });
  it("prune drops old sent items and caps size", () => {
    const old = { ...ni("old", "{}", [], 1, 0), status: "sent" as const };
    const fresh = ni("fresh", "{}", [], 1, T);
    expect(prune([old, fresh], T + 2 * 86_400_000).map((i) => i.id)).toEqual(["fresh"]);
    const many = Array.from({ length: 600 }, (_, k) => ni(String(k), "{}", [], 1, k));
    expect(prune(many, 0, 1e12, 500)).toHaveLength(500);
  });
  it("clearQueue: sent/failed remove that status; all keeps only in-flight fresh leases", () => {
    const items = [ni("p", "{}", [], 1, T), { ...ni("s", "{}", [], 1, T), status: "sent" as const }, { ...ni("f", "{}", [], 1, T), status: "failed" as const }, claim(ni("live", "{}", [], 1, T), T), { ...claim(ni("stale", "{}", [], 1, T), T - LEASE_MS * 2) }];
    expect(clearQueue(items, "sent", T).map((i) => i.id)).toEqual(["p", "f", "live", "stale"]);
    expect(clearQueue(items, "failed", T).map((i) => i.id)).toEqual(["p", "s", "live", "stale"]);
    expect(clearQueue(items, "all", T).map((i) => i.id)).toEqual(["live"]);
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
