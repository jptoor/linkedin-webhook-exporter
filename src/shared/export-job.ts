/** Pure state for a paginated bulk export ("submit a Sales Navigator URL, get
 *  every result up to a limit"). No chrome APIs here so it is unit-testable. */
import type { PageType } from "./types";

export const PAGE_SIZE = 25;
/** LinkedIn never shows more than 100 pages x 25 rows for one search. */
export const LINKEDIN_MAX_RESULTS = 2500;

export type ExportStatus = "running" | "paused" | "done" | "stopped" | "error";
export type ExportStopReason = "limit" | "no_more_pages" | "daily_cap" | "user" | "error" | "empty_page" | null;

export interface ExportJob {
  id: string;
  sourceUrl: string;
  pageType: PageType;
  tabId: number | null;
  status: ExportStatus;
  stopReason: ExportStopReason;
  limit: number;
  page: number; // next page to collect (1-based)
  pagesDone: number;
  collected: number; // leads seen on pages
  sent: number; // leads accepted into the queue
  skipped: number; // duplicates skipped
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  lastError: string | null;
  totalHint: number | null; // LinkedIn's "1.5K+ results" if we could read it
  /** Revision counter for compare-and-swap commits: every persisted change bumps it. */
  rev: number;
}

export type ExportablePageType = Extract<PageType, "salesnav_search" | "salesnav_list" | "people_search">;

export function exportablePageType(url: string): ExportablePageType | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const p = u.pathname;
  if (/^\/sales\/search\/people/.test(p)) return "salesnav_search";
  if (/^\/sales\/lists\/people\//.test(p)) return "salesnav_list";
  if (/^\/search\/results\/(people|all)/.test(p)) return "people_search";
  return null;
}

/** Same URL with the page query param set. LinkedIn and Sales Navigator both
 *  paginate search results and lead lists with `?page=N`. The query string is
 *  edited textually so LinkedIn's own encoding (parentheses, %3A) is preserved
 *  byte for byte; Sales Navigator rejects re-encoded filter queries. */
export function urlForPage(sourceUrl: string, page: number): string {
  const hashIdx = sourceUrl.indexOf("#");
  const hash = hashIdx >= 0 ? sourceUrl.slice(hashIdx) : "";
  const noHash = hashIdx >= 0 ? sourceUrl.slice(0, hashIdx) : sourceUrl;
  const qIdx = noHash.indexOf("?");
  const base = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  const parts = (qIdx >= 0 ? noHash.slice(qIdx + 1) : "").split("&").filter((kv) => kv.length && !/^page=/.test(kv));
  if (page > 1) parts.push(`page=${page}`);
  return base + (parts.length ? "?" + parts.join("&") : "") + hash;
}

export function pageFromUrl(url: string): number {
  try {
    const p = Number(new URL(url).searchParams.get("page") ?? "1");
    return Number.isFinite(p) && p >= 1 ? p : 1;
  } catch {
    return 1;
  }
}

export function newJob(id: string, sourceUrl: string, pageType: ExportablePageType, limit: number, now: number): ExportJob {
  const start = pageFromUrl(sourceUrl);
  return {
    id,
    sourceUrl: urlForPage(sourceUrl, 1),
    pageType,
    tabId: null,
    status: "running",
    stopReason: null,
    limit: Math.max(1, Math.min(limit, LINKEDIN_MAX_RESULTS)),
    page: start,
    pagesDone: 0,
    collected: 0,
    sent: 0,
    skipped: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    lastError: null,
    totalHint: null,
    rev: 0
  };
}

export interface PageResult {
  rows: number; // rows parsed on the page
  queued: number; // accepted into the send queue
  skipped: number; // duplicates
  hasNext: boolean;
  totalHint: number | null;
  capReached: boolean;
}

/** How many more results this job may still collect. The limit counts
 *  results seen (like the competitors' "number of contacts"), not sends, so
 *  a search full of already-sent people still terminates predictably. */
export function remaining(job: ExportJob): number {
  return Math.max(0, job.limit - job.collected);
}

/** Apply one collected page. Returns the next job state, including a
 *  terminal status when a stop condition is met. */
export function afterPage(job: ExportJob, r: PageResult, now: number): ExportJob {
  const next: ExportJob = {
    ...job,
    pagesDone: job.pagesDone + 1,
    collected: job.collected + r.rows,
    sent: job.sent + r.queued,
    skipped: job.skipped + r.skipped,
    totalHint: r.totalHint ?? job.totalHint,
    updatedAt: now,
    page: job.page + 1
  };
  const finish = (reason: ExportStopReason, status: ExportStatus = "done"): ExportJob => ({ ...next, status, stopReason: reason, finishedAt: now });
  if (r.capReached) return finish("daily_cap", "stopped");
  if (r.rows === 0) return finish("empty_page");
  if (next.collected >= next.limit) return finish("limit");
  if (!r.hasNext || next.page > 100) return finish("no_more_pages");
  return next;
}

export function pause(job: ExportJob, now: number): ExportJob {
  return job.status === "running" ? { ...job, status: "paused", updatedAt: now } : job;
}
export function resume(job: ExportJob, now: number): ExportJob {
  return job.status === "paused" ? { ...job, status: "running", updatedAt: now } : job;
}
export function stop(job: ExportJob, now: number, reason: ExportStopReason = "user"): ExportJob {
  return job.status === "running" || job.status === "paused" ? { ...job, status: "stopped", stopReason: reason, finishedAt: now, updatedAt: now } : job;
}
export function fail(job: ExportJob, error: string, now: number): ExportJob {
  return { ...job, status: "error", stopReason: "error", lastError: error, finishedAt: now, updatedAt: now };
}

export function isActive(job: ExportJob | null | undefined): job is ExportJob {
  return !!job && (job.status === "running" || job.status === "paused");
}

/** Human-like jitter between pages. */
export function pageDelayMs(minMs: number, maxMs: number, rand: () => number = Math.random): number {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(minMs, maxMs);
  return Math.round(lo + (hi - lo) * rand());
}

/** Parse "1.5K+ results", "2,431 results", "10M+ results" into a number. */
export function parseTotalHint(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, "").match(/([\d.]+)\s*([KkMm])?\+?\s*results?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2]?.toLowerCase() === "k" ? 1000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return Math.round(n * mult);
}
