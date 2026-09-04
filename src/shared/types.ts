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
  | "name_fallback_key";

export interface LeadRecord {
  full_name: string;
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
 *  list. One import id per click on a list page, or per bulk-export job. */
export interface ImportInfo {
  import_id: string;
  imported_by: string | null;
  imported_at: string;
  /** "manual" for a click on a list/profile, "export" for a bulk export job. */
  import_kind: "manual" | "export";
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

/** A saved search: everything a backend provider (Deepline play, Edges, Apify)
 *  needs to re-run the same Sales Navigator / LinkedIn search server-side. */
export interface SearchRecord {
  /** Search URL without page/session/tracking params. */
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
  page: number;
  list_id: string | null;
  captured_at: string;
}

export interface SearchPayload {
  schema_version: typeof SCHEMA_VERSION;
  event: "search.captured";
  event_id: string;
  sent_at: string;
  source: SourceInfo;
  search: SearchRecord;
  custom: Record<string, string>;
}

export type Payload = SinglePayload | BatchPayload | SearchPayload;

export type MappingPreset = "generic" | "flat" | "deepline";
export const MAPPING_PRESETS: readonly MappingPreset[] = ["generic", "flat", "deepline"];

/** lwe: X-LWE-Signature over `${ts}.${body}` (hex). standard: Standard Webhooks
 *  (webhook-id / webhook-timestamp / webhook-signature, `v1,<base64>` over
 *  `${id}.${ts}.${body}`), which Deepline and Svix-style receivers verify natively. */
export type SignatureScheme = "lwe" | "standard";

export interface Settings {
  webhookUrl: string;
  /** HMAC-SHA256 secret. Empty string disables signing. */
  signingSecret: string;
  signatureScheme: SignatureScheme;
  /** Optional extra auth header, e.g. Authorization: Bearer ... */
  authHeaderName: string;
  authHeaderValue: string;
  mappingPreset: MappingPreset;
  sendMode: "single" | "batch";
  dedupe: boolean;
  dedupeTtlDays: number;
  dailyCap: number;
  capturedBy: string;
  customFields: Record<string, string>;
  includeExperience: boolean;
  includeEducation: boolean;
  includeAbout: boolean;
  /** Bulk export (paginated) settings. */
  exportDefaultLimit: number;
  exportPageDelayMinMs: number;
  exportPageDelayMaxMs: number;
}

/** The subset of settings a content script is allowed to see. Secrets never
 *  cross into a page-facing context. */
export type ContentSettings = Pick<Settings, "includeExperience" | "includeEducation" | "includeAbout" | "exportDefaultLimit" | "dedupe" | "sendMode"> & { hasWebhook: boolean };

export const DEFAULT_SETTINGS: Settings = {
  webhookUrl: "",
  signingSecret: "",
  signatureScheme: "lwe",
  authHeaderName: "",
  authHeaderValue: "",
  mappingPreset: "generic",
  sendMode: "single",
  dedupe: true,
  dedupeTtlDays: 30,
  dailyCap: 100,
  capturedBy: "",
  customFields: {},
  includeExperience: true,
  includeEducation: true,
  includeAbout: true,
  exportDefaultLimit: 500,
  exportPageDelayMinMs: 4000,
  exportPageDelayMaxMs: 9000
};

export const LIMITS = {
  dailyCapMax: 2000,
  dedupeTtlDaysMax: 365,
  exportLimitMax: 2500,
  pageDelayMaxMs: 120_000,
  pageDelayMinFloorMs: 1000,
  customFieldsMax: 20,
  customValueMax: 500,
  capturedByMax: 200
} as const;

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
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  retryable: boolean;
  error: string | null;
}
