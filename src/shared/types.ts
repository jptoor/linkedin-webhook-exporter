/** Canonical lead record. Field names are stable and documented in docs/SPEC.md. */
export interface ExperienceEntry {
  title: string | null;
  company_name: string | null;
  company_linkedin_url: string | null;
  date_range: string | null;
  location: string | null;
}

export interface EducationEntry {
  school: string | null;
  degree: string | null;
  date_range: string | null;
}

export type PageType = "profile" | "people_search" | "salesnav_search" | "salesnav_list" | "salesnav_lead";
export const PAGE_TYPES: readonly PageType[] = ["profile", "people_search", "salesnav_search", "salesnav_list", "salesnav_lead"];

/** Parser confidence signals. Receivers can route low-confidence records to review. */
export type ParseWarning =
  | "name_from_title"
  | "headline_unsplit"
  | "location_missing"
  | "location_guessed"
  | "company_missing"
  | "degree_missing"
  | "experience_grouping_uncertain"
  | "sdui_layout"
  | "name_cleaned"
  | "name_fallback_key"
  /** Fields were filled from LinkedIn's own API responses observed on the page. */
  | "api_merged";

export interface LeadRecord {
  full_name: string;
  /** The name exactly as rendered, when cleaning changed it (badges, credentials, emoji). */
  full_name_raw: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  title: string | null;
  company_name: string | null;
  company_linkedin_url: string | null;
  location: string | null;
  /** Canonical public URL: https://www.linkedin.com/in/<slug> */
  linkedin_url: string | null;
  linkedin_slug: string | null;
  /** Member URN id e.g. ACwAAAxxxx when visible (Sales Navigator). */
  linkedin_member_urn: string | null;
  sales_navigator_url: string | null;
  connection_degree: "1st" | "2nd" | "3rd" | null;
  profile_image_url: string | null;
  about: string | null;
  experience: ExperienceEntry[];
  education: EducationEntry[];
  captured_at: string;
  /** Heuristic fields that could not be derived with confidence. */
  parse_warnings: ParseWarning[];
}

export interface SourceInfo {
  extension: "linkedin-webhook-exporter";
  version: string;
  page_type: PageType;
  page_url: string;
  captured_by: string | null;
}

/** Which import a lead came from: the person, the moment, and the search or
 *  list. One import id per send (a send may span several pages of a search
 *  when it comes from the basket). */
export interface ImportInfo {
  import_id: string;
  imported_by: string | null;
  imported_at: string;
  /** "manual" for a click on a page, "basket" for a multi-page basket send,
   *  "search" for a search handed to a backend provider. */
  import_kind: "manual" | "basket" | "search";
  search_url: string | null;
  /** Human label: Sales Nav keywords + filters, list id, or the page title. */
  search_name: string | null;
  list_id: string | null;
  page: number | null;
}

export const SCHEMA_VERSION = "1" as const;
export type EventName = "lead.captured" | "leads.captured" | "search.captured" | "test";
export const EVENT_NAMES: readonly EventName[] = ["lead.captured", "leads.captured", "search.captured", "test"];

export interface SinglePayload {
  schema_version: typeof SCHEMA_VERSION;
  event: "lead.captured";
  event_id: string;
  sent_at: string;
  source: SourceInfo;
  lead: LeadRecord;
  import: ImportInfo | null;
  custom: Record<string, string>;
}

export interface BatchPayload {
  schema_version: typeof SCHEMA_VERSION;
  event: "leads.captured";
  event_id: string;
  sent_at: string;
  source: SourceInfo;
  leads: LeadRecord[];
  import: ImportInfo | null;
  custom: Record<string, string>;
}

/** A search handed to a backend provider (Deepline play, WizLeads, Apify):
 *  everything needed to re-run the same Sales Navigator / LinkedIn search
 *  server-side. The extension never pages through results itself. */
export interface SearchRecord {
  /** Search URL without page/session/tracking params. For a Sales Navigator
   *  saved search this is the shareable URL with the full query expression,
   *  not the `savedSearchId` deep link (which only resolves for its owner). */
  search_url: string;
  page_type: PageType;
  surface: "sales_navigator" | "linkedin";
  /** Decoded query parameters with session/tracking keys removed. */
  params: Record<string, string>;
  /** Sales Navigator's decoded `query` expression when present. */
  query_expression: string | null;
  keywords: string | null;
  /** Filters parsed out of the Sales Navigator query expression, e.g. {"CURRENT_TITLE": ["CRO"]}. */
  filters: Record<string, string[]>;
  total_hint: number | null;
  /** How many results the operator asked the backend to fetch. */
  limit: number | null;
  page: number;
  list_id: string | null;
  /** Sales Navigator saved-search id when the search was opened from one. */
  saved_search_id: string | null;
  captured_at: string;
}

export interface SearchPayload {
  schema_version: typeof SCHEMA_VERSION;
  event: "search.captured";
  event_id: string;
  sent_at: string;
  source: SourceInfo;
  search: SearchRecord;
  import: ImportInfo | null;
  custom: Record<string, string>;
}

export type Payload = SinglePayload | BatchPayload | SearchPayload;

export type MappingPreset = "generic" | "flat" | "deepline";
export const MAPPING_PRESETS: readonly MappingPreset[] = ["generic", "flat", "deepline"];

/** lwe: X-LWE-Signature over `${ts}.${body}` (hex). standard: Standard Webhooks
 *  (webhook-id / webhook-timestamp / webhook-signature, `v1,<base64>` over
 *  `${id}.${ts}.${body}`), which Deepline and Svix-style receivers verify natively. */
export type SignatureScheme = "lwe" | "standard";

/* ------------------------------------------------------------ destinations */

export type DestinationKind = "webhook" | "deepline_play";

/** A plain HTTPS webhook (any receiver, Deepline inbound webhook, Clay, Zapier…). */
export interface WebhookDestination {
  id: string;
  kind: "webhook";
  name: string;
  /** Pinned to the top of the picker. */
  favorite: boolean;
  url: string;
  /** HMAC-SHA256 secret. Empty string disables signing. */
  signingSecret: string;
  signatureScheme: SignatureScheme;
  /** Optional extra auth header, e.g. Authorization: Bearer ... */
  authHeaderName: string;
  authHeaderValue: string;
  mappingPreset: MappingPreset;
  sendMode: "single" | "batch";
}

/** How the extension turns leads into a play's `input`, inferred from the
 *  play's input schema when it is selected (see shared/deepline.ts). */
export type PlayInputMode =
  /** Schema has `leads: array` -> one run per send with all rows. */
  | "batch"
  /** Schema has `lead: object` -> one run per lead with the flat row under `lead`. */
  | "lead"
  /** Field-name mapping (linkedin_url, first_name, company_name…) -> one run per lead. */
  | "mapped";

export interface PlayInputSpec {
  mode: PlayInputMode;
  /** Top-level input property names declared by the play (empty = unknown/any). */
  fields: string[];
  required: string[];
  /** True when the play declares a search URL field (search_url / sales_navigator_url / url). */
  acceptsSearch: boolean;
  /** True when at least one lead field can be filled from a LinkedIn page. */
  acceptsLeads: boolean;
}

/** A Deepline play run directly through the API (`POST /api/v2/plays/run`)
 *  with the org's API key. No webhook token or signing secret is involved:
 *  the API key is the credential. */
export interface PlayDestination {
  id: string;
  kind: "deepline_play";
  name: string;
  /** Pinned to the top of the picker. */
  favorite: boolean;
  /** https://code.deepline.com by default; self-hosted / local dev allowed. */
  baseUrl: string;
  /** Empty means "use my Deepline sign-in" (the browser session cookie). */
  apiKey: string;
  /** Play reference as accepted by the run API (`name`): e.g. "linkedin-capture" or "prebuilt/person-linkedin-to-email". */
  playKey: string;
  playName: string;
  input: PlayInputSpec;
}

export type Destination = WebhookDestination | PlayDestination;

export interface Settings {
  destinations: Destination[];
  /** Which destination the side panel sends to. */
  activeDestinationId: string | null;
  dedupe: boolean;
  dedupeTtlDays: number;
  dailyCap: number;
  capturedBy: string;
  customFields: Record<string, string>;
  includeExperience: boolean;
  includeEducation: boolean;
  includeAbout: boolean;
  /** Default `limit` offered when sending a search to a backend. */
  searchDefaultLimit: number;
  /** Deepline address the sign-in and play picker use. */
  deeplineBaseUrl: string;
  /** Anonymous usage events and error reports to Deepline (see PRIVACY.md). */
  telemetry: boolean;
  /** Read LinkedIn API responses the page loads to fill in what the DOM lacks. */
  intercept: boolean;
}

/** The subset of settings a content script is allowed to see. Secrets never
 *  cross into a page-facing context. */
export type ContentSettings = Pick<Settings, "includeExperience" | "includeEducation" | "includeAbout" | "dedupe" | "searchDefaultLimit" | "intercept"> & {
  hasDestination: boolean;
  destinationName: string | null;
  destinationKind: DestinationKind | null;
};

export const DEFAULT_SETTINGS: Settings = {
  destinations: [],
  activeDestinationId: null,
  dedupe: true,
  dedupeTtlDays: 30,
  dailyCap: 100,
  capturedBy: "",
  customFields: {},
  includeExperience: true,
  includeEducation: true,
  includeAbout: true,
  searchDefaultLimit: 100,
  deeplineBaseUrl: "https://code.deepline.com",
  telemetry: true,
  intercept: true
};

export const LIMITS = {
  dailyCapMax: 2000,
  dedupeTtlDaysMax: 365,
  searchLimitMax: 2500,
  customFieldsMax: 20,
  customValueMax: 500,
  capturedByMax: 200,
  destinationsMax: 25,
  basketMax: 500
} as const;

/* ------------------------------------------------------------ basket */

/** A lead the operator picked on some page and has not sent yet. Lives in
 *  session storage (cleared when the browser closes) so a selection can span
 *  many result pages before one send. */
export interface BasketItem {
  key: string;
  lead: LeadRecord;
  pageType: PageType;
  pageUrl: string;
  pageTitle: string | null;
  addedAt: number;
}

/* ------------------------------------------------------------ queue */

export type QueueStatus = "pending" | "sending" | "sent" | "failed";

export interface QueueItem {
  id: string;
  createdAt: number;
  nextAttemptAt: number;
  attempts: number;
  status: QueueStatus;
  /** Serialized request body (already mapped). Stored as string so the
   *  signature is computed over the exact bytes sent on every retry. */
  body: string;
  leadUrls: string[];
  leadCount: number;
  /** Value for Idempotency-Key / x-deepline-dedupe-key. */
  dedupeKey: string;
  lastError: string | null;
  lastStatus: number | null;
  /** When the item was claimed for sending; a stale lease is recovered. */
  sendingAt: number | null;
  /** Which destination the item is bound to. An item outlives destination
   *  edits: if its destination is deleted the item fails permanently. */
  destinationId: string;
  destinationKind: DestinationKind;
  /** Human label for the activity feed: a name, "12 leads", or a search name. */
  label: string;
  /** Deepline workflow/run id returned by the run API, once accepted. */
  runId: string | null;
  /** For play runs authorized by the rep's Deepline sign-in: the identity
   *  (`user|org`) that queued the item. The item is never sent under another. */
  sessionIdentity?: string | null;
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  retryable: boolean;
  error: string | null;
  /** Run id when the receiver is the Deepline run API. */
  runId?: string | null;
}
