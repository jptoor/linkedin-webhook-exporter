import type { Destination, QueueItem, QueueStatus } from "../shared/types";

export const MAX_ATTEMPTS = 6;
/** Backoff schedule in ms for attempt n (1-based). */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];
/** A `sending` claim older than this is considered abandoned (worker was
 *  suspended mid-request) and is retried. Must exceed the fetch timeout. */
export const LEASE_MS = 90_000;

export function backoffFor(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1) - 1, BACKOFF_MS.length - 1)];
}

export function newItem(id: string, body: string, leadUrls: string[], leadCount: number, now: number, dedupeKey: string, dest: Pick<Destination, "id" | "kind">, label = ""): QueueItem {
  return { id, createdAt: now, nextAttemptAt: now, attempts: 0, status: "pending", body, leadUrls, leadCount, dedupeKey, lastError: null, lastStatus: null, sendingAt: null, destinationId: dest.id, destinationKind: dest.kind, label, runId: null };
}

export function due(items: QueueItem[], now: number): QueueItem[] {
  return items.filter((i) => i.status === "pending" && i.nextAttemptAt <= now).sort((a, b) => a.createdAt - b.createdAt);
}

/** Claim an item for sending: increments attempts atomically with the lease. */
export function claim(item: QueueItem, now: number): QueueItem {
  return { ...item, status: "sending", sendingAt: now, attempts: item.attempts + 1 };
}

/** Items stuck in `sending` past the lease are returned to `pending` (or
 *  failed if they have exhausted attempts). Idempotent. */
export function recoverStaleLeases(items: QueueItem[], now: number, leaseMs = LEASE_MS): QueueItem[] {
  return items.map((i) => {
    if (i.status !== "sending") return i;
    if (i.sendingAt != null && now - i.sendingAt < leaseMs) return i;
    if (i.attempts >= MAX_ATTEMPTS) return { ...i, status: "failed", sendingAt: null, lastError: i.lastError ?? "lease_expired" };
    return { ...i, status: "pending", sendingAt: null, nextAttemptAt: now, lastError: i.lastError ?? "lease_expired" };
  });
}

/** Pure transition applied after an attempt on a claimed item. */
export function afterAttempt(item: QueueItem, result: { ok: boolean; status: number | null; retryable: boolean; error: string | null }, now: number): QueueItem {
  const attempts = Math.max(item.attempts, 1);
  if (result.ok) return { ...item, attempts, status: "sent", sendingAt: null, lastError: null, lastStatus: result.status, nextAttemptAt: now };
  if (!result.retryable || attempts >= MAX_ATTEMPTS) {
    return { ...item, attempts, status: "failed", sendingAt: null, lastError: result.error, lastStatus: result.status, nextAttemptAt: now };
  }
  return { ...item, attempts, status: "pending", sendingAt: null, lastError: result.error, lastStatus: result.status, nextAttemptAt: now + backoffFor(attempts) };
}

export function nextWake(items: QueueItem[]): number | null {
  const pending = items.filter((i) => i.status === "pending");
  const leases = items.filter((i) => i.status === "sending" && i.sendingAt != null).map((i) => i.sendingAt! + LEASE_MS);
  const times = [...pending.map((i) => i.nextAttemptAt), ...leases];
  return times.length ? Math.min(...times) : null;
}

export function prune(items: QueueItem[], now: number, keepSentMs = 24 * 3600_000, maxItems = 500): QueueItem[] {
  const kept = items.filter((i) => !(i.status === "sent" && now - i.createdAt > keepSentMs));
  return kept.length > maxItems ? kept.slice(kept.length - maxItems) : kept;
}

/** Remove finished items. `all` clears everything except requests that are
 *  in flight right now (fresh lease); those finish or expire on their own. */
export function clearQueue(items: QueueItem[], status: "sent" | "failed" | "all", now: number): QueueItem[] {
  if (status === "all") return items.filter((i) => i.status === "sending" && i.sendingAt != null && now - i.sendingAt < LEASE_MS);
  return items.filter((i) => i.status !== status);
}

export function counts(items: QueueItem[]): Record<QueueStatus, number> {
  const c: Record<QueueStatus, number> = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const i of items) c[i.status]++;
  return c;
}
