import type { LeadRecord, PageType } from "../../shared/types";
import { isProfilePath, parseProfile, type ProfileParseOptions } from "./profile";
import { isSalesNavLeadPath, isSalesNavListPath, isSalesNavSearchPath, parseSalesNavLead, parseSalesNavPage, parseSalesNavRow, salesNavRows } from "./salesnav";
import { isPeopleSearchPath, parsePeopleSearchPage, peopleSearchRows } from "./search";

export function detectPageType(pathname: string): PageType | null {
  if (isProfilePath(pathname)) return "profile";
  if (isSalesNavSearchPath(pathname)) return "salesnav_search";
  if (isSalesNavListPath(pathname)) return "salesnav_list";
  if (isSalesNavLeadPath(pathname)) return "salesnav_lead";
  if (isPeopleSearchPath(pathname)) return "people_search";
  return null;
}

export function isListPage(t: PageType | null): boolean {
  return t === "salesnav_search" || t === "salesnav_list" || t === "people_search";
}

export function parsePage(doc: Document, pageUrl: string, opts: ProfileParseOptions = {}): { pageType: PageType | null; leads: LeadRecord[] } {
  const pathname = new URL(pageUrl).pathname;
  const pageType = detectPageType(pathname);
  switch (pageType) {
    case "profile":
      return { pageType, leads: [parseProfile(doc, pageUrl, opts)] };
    case "salesnav_search":
    case "salesnav_list":
      return { pageType, leads: parseSalesNavPage(doc, opts.now) };
    case "salesnav_lead":
      return { pageType, leads: [parseSalesNavLead(doc, pageUrl, opts.now)] };
    case "people_search":
      return { pageType, leads: parsePeopleSearchPage(doc, opts.now) };
    default:
      return { pageType: null, leads: [] };
  }
}

export function listRows(doc: Document, pageType: PageType): HTMLElement[] {
  if (pageType === "people_search") return peopleSearchRows(doc);
  if (pageType === "salesnav_search" || pageType === "salesnav_list") return salesNavRows(doc);
  return [];
}

export { parseProfile, parseSalesNavRow, parseSalesNavPage, parseSalesNavLead, parsePeopleSearchPage, salesNavRows, peopleSearchRows };
export { parsePeopleSearchRow } from "./search";
