import { describe, expect, it } from "vitest";
import { withLock } from "../../src/background/lock";

describe("withLock", () => {
  it("serializes async critical sections in order and survives rejections", async () => {
    const order: string[] = [];
    let shared = 0;
    const task = (name: string, delay: number) =>
      withLock(async () => {
        const v = shared;
        await new Promise((r) => setTimeout(r, delay));
        shared = v + 1; // read-modify-write would lose updates without the lock
        order.push(name);
      });
    const failing = () =>
      withLock(async () => {
        throw new Error("boom");
      }).catch(() => order.push("err"));
    await Promise.all([task("a", 20), task("b", 5), failing(), task("c", 1)]);
    expect(shared).toBe(3);
    expect(order).toEqual(["a", "b", "err", "c"]);
    expect(await withLock(async () => 42)).toBe(42);
  });
});
