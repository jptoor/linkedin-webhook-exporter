import type { PlaySummary } from "./deepline";
import type { BasketItem, ContentSettings, Destination, LeadRecord, PageType, QueueItem, Settings } from "./types";

/** What a page currently shows, as reported by its content script. The side
 *  panel renders from this; nothing here is trusted beyond display until the
 *  worker re-validates the leads on send. */
export interface PageContext {
  pageType: PageType | null;
  url: string;
  title: string;
  /** Single-record pages: the parsed person (light parse, no experience). */
  lead: LeadRecord | null;
  /** List pages: rows the parser could read on this page. */
  rowsOnPage: number;
  /** List pages: rows on this page that are in the basket. */
  selectedOnPage: number;
  /** Sales Navigator search opened from a saved search: the URL only carries
   *  savedSearchId, which a backend cannot resolve. */
  savedSearchId: string | null;
  /** The shareable search URL captured from "Share search", when known. */
  shareUrl: string | null;
  searchName: string | null;
  totalHint: number | null;
}

export type ContentToBackground =
  | { type: "CAPTURE"; leads: LeadRecord[]; pageType: PageType; pageUrl: string; force?: boolean; importId?: string; importKind?: "manual" | "basket"; pageTitle?: string; destinationId?: string }
  | { type: "GET_STATE" }
  | { type: "GET_SETTINGS" }
  | { type: "GET_CONTENT_SETTINGS" }
  | { type: "CHECK_DEDUPE"; keys: string[] }
  | { type: "RETRY_NOW" }
  | { type: "CLEAR_QUEUE"; status?: "sent" | "failed" | "all" }
  | { type: "TEST_DESTINATION"; destination?: Destination; destinationId?: string }
  | { type: "LIST_PLAYS"; baseUrl?: string; apiKey?: string | null }
  | { type: "ADD_PLAY_DESTINATION"; playKey: string; playName: string; inputSchema: Record<string, unknown> | null; activate?: boolean }
  | { type: "GET_AUTH"; refresh?: boolean }
  | { type: "PANEL_ERROR"; message: string; stack?: string | null }
  | { type: "SIGN_IN" }
  | { type: "INTERCEPT_STATS"; responses: number; people: number; total: number | null; pageType: PageType | null }
  | { type: "SEARCH_CAPTURE"; url: string; pageType: PageType; totalHint: number | null; limit?: number; searchName?: string | null; savedSearchId?: string | null; force?: boolean; destinationId?: string }
  | { type: "BASKET_ADD"; leads: LeadRecord[]; pageType: PageType; pageUrl: string; pageTitle?: string }
  | { type: "BASKET_REMOVE"; keys: string[] }
  | { type: "BASKET_CLEAR" }
  | { type: "BASKET_GET" }
  | { type: "BASKET_SEND"; force?: boolean; destinationId?: string }
  | { type: "PAGE_CONTEXT"; context: PageContext }
  | { type: "SHARE_LINK"; url: string }
  | { type: "GET_PAGE_CONTEXT"; tabId: number }
  | { type: "SET_ACTIVE_DESTINATION"; destinationId: string }
  | { type: "TOGGLE_FAVORITE"; destinationId: string }
  | { type: "OPEN_SIDE_PANEL" }
  | { type: "GET_LOG"; limit?: number }
  | { type: "CLEAR_LOG" };

/** Background -> content script. */
export type BackgroundToContent =
  | { type: "SEND_CURRENT" }
  | { type: "PAGE_ACTION"; action: "add_selected" | "add_all" | "clear_page" | "refresh" | "share_search" | "send_current" }
  | { type: "BASKET_CHANGED"; keys: string[] };

/** Background -> side panel broadcast. */
export type BackgroundToPanel = { type: "CONTEXT_CHANGED"; tabId: number; context: PageContext } | { type: "BASKET_CHANGED"; keys: string[] } | { type: "STATE_CHANGED" } | { type: "AUTH_CHANGED"; auth: AuthResponse };

export interface CaptureResponse {
  ok: boolean;
  queued: number;
  skippedDuplicates: string[];
  rejectedReason: "no_destination" | "daily_cap" | "invalid_url" | "nothing_to_send" | "invalid_message" | "unsupported_by_play" | null;
  remainingToday: number;
  /** Which fields the play requires that the page cannot provide. */
  detail?: string | null;
}

export interface SearchCaptureResponse {
  ok: boolean;
  queued: boolean;
  duplicate: boolean;
  rejectedReason: CaptureResponse["rejectedReason"] | "saved_search_needs_share_link";
  detail?: string | null;
}

export interface BasketResponse {
  items: BasketItem[];
  count: number;
  pages: number;
}

export interface StateResponse {
  settings: Settings;
  queue: QueueItem[];
  sentToday: number;
  remainingToday: number;
  dedupeCount: number;
  /** Local calendar day the daily counters apply to (YYYY-MM-DD). */
  day: string;
  basketCount: number;
}

export interface ListPlaysResponse {
  ok: boolean;
  plays: PlaySummary[];
  error: string | null;
}

export interface AuthResponse {
  signedIn: boolean;
  baseUrl: string;
  email: string | null;
  name: string | null;
  orgId: string | null;
  error: string | null;
}

export type ContentSettingsResponse = ContentSettings;
