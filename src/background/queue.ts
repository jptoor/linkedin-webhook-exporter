import type { QueueItem, QueueStatus } from "../shared/types";

export const MAX_ATTEMPTS = 6;
/** Backoff schedule in ms for attempt n (1-based). */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];

export function backoffFor(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
}

export function newItem(id: string, body: string, leadUrls: string[], leadCount: number, now: number, dedupeKey: string = id): QueueItem {
  return { id, createdAt: now, nextAttemptAt: now, attempts: 0, status: "pending", body, leadUrls, leadCount, dedupeKey, lastError: null, lastStatus: null };
}

export function due(items: QueueItem[], now: number): QueueItem[] {
  return items.filter((i) => i.status === "pending" && i.nextAttemptAt <= now).sort((a, b) => a.createdAt - b.createdAt);
}

/** Pure transition applied after an attempt. */
export function afterAttempt(item: QueueItem, result: { ok: boolean; status: number | null; retryable: boolean; error: string | null }, now: number): QueueItem {
  const attempts = item.attempts + 1;
  if (result.ok) return { ...item, attempts, status: "sent", lastError: null, lastStatus: result.status, nextAttemptAt: now };
  if (!result.retryable || attempts >= MAX_ATTEMPTS) {
    return { ...item, attempts, status: "failed", lastError: result.error, lastStatus: result.status, nextAttemptAt: now };
  }
  return { ...item, attempts, status: "pending", lastError: result.error, lastStatus: result.status, nextAttemptAt: now + backoffFor(attempts) };
}

export function nextWake(items: QueueItem[]): number | null {
  const pending = items.filter((i) => i.status === "pending");
  if (!pending.length) return null;
  return Math.min(...pending.map((i) => i.nextAttemptAt));
}

export function prune(items: QueueItem[], now: number, keepSentMs = 24 * 3600_000, maxItems = 500): QueueItem[] {
  const kept = items.filter((i) => !(i.status === "sent" && now - i.createdAt > keepSentMs));
  return kept.length > maxItems ? kept.slice(kept.length - maxItems) : kept;
}

export function filterByStatus(items: QueueItem[], status: "sent" | "failed" | "all"): QueueItem[] {
  if (status === "all") return items.filter((i) => i.status === "sending");
  return items.filter((i) => i.status !== status);
}

export function counts(items: QueueItem[]): Record<QueueStatus, number> {
  const c: Record<QueueStatus, number> = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const i of items) c[i.status]++;
  return c;
}
