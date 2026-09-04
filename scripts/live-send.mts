/**
 * Live pipeline check: take records parsed from real LinkedIn pages (JSON
 * files) and push them through the SAME code the extension uses
 * (buildBodies / buildSearchBody / sendBody) into a receiver.
 *
 *   npx tsx scripts/live-send.mts <receiverUrl> <secret> <preset> file.json [file.json …]
 * Each file: { pageUrl, leads?: LeadRecord[], lead?: LeadRecord, pageType?: PageType, search?: true }
 */
import { readFileSync } from "node:fs";
import { buildBodies, buildSearchBody } from "../src/shared/mapping";
import { buildSearchRecord, searchKey, searchName } from "../src/shared/search";
import { detectPageType } from "../src/content/parsers";
import { sendBody } from "../src/background/sender";
import { dedupeKey } from "../src/shared/normalize";
import { DEFAULT_SETTINGS, type ImportInfo, type LeadRecord, type SourceInfo } from "../src/shared/types";

const [receiverUrl, secret, preset, ...files] = process.argv.slice(2);
const settings = { ...DEFAULT_SETTINGS, webhookUrl: receiverUrl, signingSecret: secret, mappingPreset: preset as "generic" | "flat" | "deepline", capturedBy: "jai@getaero.io (live test)" };
let sent = 0, failed = 0;
for (const f of files) {
  const data = JSON.parse(readFileSync(f, "utf8")) as { pageUrl: string; leads?: LeadRecord[]; lead?: LeadRecord; search?: boolean; totalHint?: number | null };
  const pageType = detectPageType(new URL(data.pageUrl).pathname)!;
  const source: SourceInfo = { extension: "linkedin-webhook-exporter", version: "live", page_type: pageType, page_url: data.pageUrl, captured_by: settings.capturedBy };
  const sentAt = new Date().toISOString();
  if (data.search) {
    const id = crypto.randomUUID();
    const body = JSON.stringify(buildSearchBody(buildSearchRecord(data.pageUrl, pageType, data.totalHint ?? null, sentAt), settings.mappingPreset, source, {}, id, sentAt));
    const r = await sendBody(settings, body, id, { version: "live", dedupeKey: `search:${data.pageUrl}` });
    console.log(`search.captured ${pageType} -> ${r.status} ${r.ok ? "ok" : r.error}`);
    if (r.ok) sent++;
    else failed++;
  }
  const leads = data.leads ?? (data.lead ? [data.lead] : []);
  const isList = pageType === "salesnav_search" || pageType === "salesnav_list" || pageType === "people_search";
  const rec = isList ? buildSearchRecord(data.pageUrl, pageType, data.totalHint ?? null, sentAt) : null;
  const imp: ImportInfo = { import_id: crypto.randomUUID(), imported_by: settings.capturedBy, imported_at: sentAt, import_kind: "manual", search_url: isList ? searchKey(data.pageUrl) : null, search_name: isList ? searchName(data.pageUrl, pageType) : null, list_id: rec?.list_id ?? null, page: rec?.page ?? null };
  for (const b of buildBodies(leads, { preset: settings.mappingPreset, mode: "single", source, custom: { run: "live-test" }, eventId: () => crypto.randomUUID(), sentAt, import: imp })) {
    const r = await sendBody(settings, JSON.stringify(b.body), b.eventId, { version: "live", dedupeKey: dedupeKey(b.leads[0]) });
    console.log(`lead.captured ${pageType} ${b.leads[0].full_name.padEnd(28)} -> ${r.status} ${r.ok ? "ok" : r.error}`);
    if (r.ok) sent++;
    else failed++;
  }
}
console.log(`\nsent=${sent} failed=${failed}`);
process.exit(failed ? 1 : 0);
