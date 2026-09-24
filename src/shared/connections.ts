import { canonicalizeLinkedInUrl } from "./normalize";
import { validateLead } from "./validate";
import type { LeadRecord } from "./types";

export const ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_MAX_ROWS = 30_000;
export interface ConnectionSyncState {
  status: "idle" | "running" | "completed" | "stopped" | "failed";
  scanned: number;
  total: number;
  queued: number;
  skipped: number;
  destination: string;
  message: string;
}
export const IDLE_CONNECTION_SYNC: ConnectionSyncState = { status: "idle", scanned: 0, total: 0, queued: 0, skipped: 0, destination: "", message: "" };

/** RFC-style quoted CSV; newlines and commas inside quotes stay in the field. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const push = () => { row.push(field); field = ""; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === ",") push();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      push(); rows.push(row); row = [];
      if (rows.length > ARCHIVE_MAX_ROWS + 30) throw new Error("The file exceeds 30,000 connections.");
    } else if (closed || c === '"') throw new Error("Malformed CSV quoting. Use the original Connections.csv export.");
    else field += c;
  }
  if (quoted) throw new Error("The CSV ends inside a quoted field.");
  if (field || row.length || closed) { push(); rows.push(row); }
  return rows;
}
function connectionDate(value: string, row: number): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const named = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(value);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = Number(iso?.[1] ?? named?.[3]);
  const month = iso ? Number(iso[2]) : months.findIndex(m => m.toLowerCase() === named?.[2].toLowerCase()) + 1;
  const day = Number(iso?.[3] ?? named?.[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!year || !month || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getTime() > Date.now()) throw new Error(`Row ${row}: unrecognized connection date. Use an English export with dates such as 23 Sep 2026.`);
  return date.toISOString().slice(0, 10); // Date-only evidence; do not invent a time.
}
export function parseConnectionsCsv(text: string, ownerUrl: string): LeadRecord[] {
  const owner = canonicalizeLinkedInUrl(ownerUrl);
  if (!owner) throw new Error("Enter the profile URL of the person whose connections were exported.");
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > ARCHIVE_MAX_BYTES) throw new Error("Choose Connections.csv, at most 10 MB. Do not upload the full archive.");
  const required = ["First Name", "Last Name", "URL", "Company", "Position", "Connected On"];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headerLine = lines.slice(0, 21).findIndex(line => required.every(name => line.includes(name)));
  if (headerLine < 0) throw new Error("Choose the original Connections.csv from your full export.");
  const rows = csvRows(lines.slice(headerLine).join("\n"));
  const headerIndex = rows.findIndex(row => required.every(name => row.includes(name)));
  if (headerIndex < 0 || headerIndex > 20) throw new Error("This is not a supported Connections.csv export. Request the full connections archive, extract it, and choose Connections.csv.");
  const header = rows[headerIndex];
  if (new Set(header).size !== header.length) throw new Error("The CSV contains duplicate column names.");
  const data = rows.slice(headerIndex + 1).filter(row => row.some(value => value.trim()));
  if (!data.length) throw new Error("Connections.csv contains no connections.");
  if (data.length > ARCHIVE_MAX_ROWS) throw new Error("The file exceeds 30,000 connections.");
  const seen = new Set<string>();
  return data.map((row, index) => {
    const number = headerLine + headerIndex + index + 2;
    if (row.length !== header.length) throw new Error(`Row ${number}: column count does not match the export header.`);
    const get = (name: string) => row[header.indexOf(name)].trim();
    const url = canonicalizeLinkedInUrl(get("URL"));
    if (!url || !get("First Name") || !get("Last Name")) throw new Error(`Row ${number}: name or profile URL is missing. No records have been imported.`);
    if (seen.has(url.toLowerCase())) throw new Error(`Row ${number}: duplicate profile URL. Review the file before importing.`);
    seen.add(url.toLowerCase());
    const lead = validateLead({ full_name: `${get("First Name")} ${get("Last Name")}`, first_name: get("First Name"), last_name: get("Last Name"), linkedin_url: url, company_name: get("Company"), title: get("Position"), connection_degree: "1st" });
    if (!lead) throw new Error(`Row ${number}: invalid connection.`);
    // Discard email and every other CSV column. Ownership is user-declared,
    // not established through a logged-in session or a verified member URN.
    return { ...lead, connection_owner_url: owner, connection_source: "archive", connected_at: connectionDate(get("Connected On"), number) };
  });
}
