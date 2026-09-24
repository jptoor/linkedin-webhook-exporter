import { validateLead } from "./validate";
import type { LeadRecord } from "./types";

export const CONNECTIONS_PAGE_SIZE = 40;
export interface ConnectionSyncState {
  status: "idle" | "running" | "completed" | "stopped" | "failed";
  scanned: number;
  queued: number;
  skipped: number;
  destination: string;
  message: string;
}
export const IDLE_CONNECTION_SYNC: ConnectionSyncState = { status: "idle", scanned: 0, queued: 0, skipped: 0, destination: "", message: "" };
export type ConnectionRequest =
  | { type: "CONNECTIONS_READ"; runId: string; start: number; count: number }
  | { type: "CONNECTIONS_ABORT"; runId: string };
export interface ConnectionPage { leads: LeadRecord[]; nextStart: number; done: boolean }

type Obj = Record<string, unknown>;
const object = (x: unknown): Obj => x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {};
const urn = (x: unknown): x is string => typeof x === "string" && /^urn:li:(?:fsd_profile|fs_miniProfile|member):[\w-]+$/.test(x);

export function connectionOwner(raw: unknown): string {
  const root = object(raw);
  const data = object(root.data ?? root);
  const mini = object(data.miniProfile);
  if (urn(mini.entityUrn)) return mini.entityUrn;
  const included = Array.isArray(root.included) ? root.included.map(object) : [];
  const profile = included.find(x => x.entityUrn === data["*miniProfile"]);
  if (urn(profile?.entityUrn)) return profile.entityUrn;
  throw new Error("LinkedIn returned an unrecognized account response. Sync stopped.");
}

/** Resolve normalized entities by URN, never by their position in `included`.
 * Only connections explicitly referenced by the result list become leads. */
export function parseConnectionPage(raw: unknown, owner: string, start: number, count: number): ConnectionPage {
  if (!urn(owner)) throw new Error("LinkedIn account identity is missing.");
  const root = object(raw), data = object(root.data ?? root);
  const elements = data.elements ?? data["*elements"];
  const paging = object(data.paging);
  if (!Array.isArray(elements) || elements.length > count || paging.start !== start || typeof paging.count !== "number" || paging.count < elements.length) {
    throw new Error("LinkedIn changed its connections response. Sync stopped without skipping records.");
  }
  const entities = new Map((Array.isArray(root.included) ? root.included : []).map(object).map(x => [x.entityUrn, x]));
  const resolve = (x: unknown): Obj => typeof x === "string" ? entities.get(x) ?? {} : object(x);
  const leads = elements.map((element): LeadRecord => {
    const connection = resolve(element);
    const profile = resolve(connection.connectedMember ?? connection["*connectedMember"]);
    const id = profile.entityUrn;
    const slug = profile.publicIdentifier;
    const created = connection.createdAt;
    if (!urn(id) || typeof slug !== "string" || !/^[\w%-]+$/.test(slug) || typeof profile.firstName !== "string" || typeof profile.lastName !== "string" || typeof created !== "number" || !Number.isFinite(created) || created < 0 || created > Date.now()) {
      throw new Error("A LinkedIn connection is incomplete. Sync stopped without skipping records.");
    }
    const lead = validateLead({ full_name: `${profile.firstName} ${profile.lastName}`, first_name: profile.firstName, last_name: profile.lastName, headline: profile.headline, linkedin_url: `https://www.linkedin.com/in/${slug}`, linkedin_member_urn: id.split(":").at(-1), connection_degree: "1st" });
    if (!lead?.linkedin_url) throw new Error("A LinkedIn connection has an invalid profile URL.");
    return { ...lead, connection_owner_urn: owner, connected_at: new Date(created).toISOString() };
  });
  const nextStart = start + elements.length;
  const total = paging.total;
  if (total !== undefined && (!Number.isSafeInteger(total) || (total as number) < nextStart)) throw new Error("LinkedIn returned inconsistent connection counts.");
  if (!elements.length && typeof total === "number" && start < total) throw new Error("LinkedIn returned an empty page before the end of the network.");
  return { leads, nextStart, done: typeof total === "number" ? nextStart >= total : elements.length < count };
}
