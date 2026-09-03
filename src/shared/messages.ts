import type { ExportJob } from "./export-job";
import type { LeadRecord, PageType, QueueItem, Settings } from "./types";

export type ContentToBackground =
  | { type: "CAPTURE"; leads: LeadRecord[]; pageType: PageType; pageUrl: string; force?: boolean; importId?: string; importKind?: "manual" | "export"; pageTitle?: string }
  | { type: "GET_STATE" }
  | { type: "GET_SETTINGS" }
  | { type: "CHECK_DEDUPE"; keys: string[] }
  | { type: "RETRY_NOW" }
  | { type: "CLEAR_QUEUE"; status?: "sent" | "failed" | "all" }
  | { type: "TEST_WEBHOOK" }
  | { type: "REQUEST_CURRENT_PAGE" }
  | { type: "SEARCH_CAPTURE"; url: string; pageType: PageType; totalHint: number | null }
  | { type: "EXPORT_START"; url: string; limit: number; tabId?: number }
  | { type: "EXPORT_PAUSE" }
  | { type: "EXPORT_RESUME" }
  | { type: "EXPORT_STOP" }
  | { type: "EXPORT_STATUS" };

/** Background -> content script on a list page. */
export type BackgroundToContent =
  | { type: "SEND_CURRENT" }
  | { type: "EXPORT_COLLECT"; jobId: string; expectedPage: number };

export interface CollectResponse {
  ok: boolean;
  pageType: PageType | null;
  pageUrl: string;
  leads: LeadRecord[];
  hasNext: boolean;
  totalHint: number | null;
  error: string | null;
}

export interface ExportStatusResponse {
  job: ExportJob | null;
  history: ExportJob[];
}

export interface CaptureResponse {
  ok: boolean;
  queued: number;
  skippedDuplicates: string[];
  rejectedReason: "no_webhook" | "daily_cap" | "invalid_url" | "nothing_to_send" | null;
  remainingToday: number;
}

export interface StateResponse {
  settings: Settings;
  queue: QueueItem[];
  exportJob: ExportJob | null;
  sentToday: number;
  remainingToday: number;
  dedupeCount: number;
}
