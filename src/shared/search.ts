import type { PageType, SearchRecord } from "./types";

/** Split a query string textually so LinkedIn's encoding survives, then decode values. */
export function decodeParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = url.indexOf("?");
  if (q < 0) return out;
  const raw = url.slice(q + 1).split("#")[0];
  for (const kv of raw.split("&")) {
    if (!kv) continue;
    const i = kv.indexOf("=");
    const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
    const v = i < 0 ? "" : safeDecode(kv.slice(i + 1));
    out[k] = v;
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** Sales Navigator query expressions look like
 *  (spellCorrectionEnabled:true,filters:List((type:CURRENT_TITLE,values:List((id:x,text:CRO,selectionType:INCLUDED))),(type:REGION,values:List((id:y,text:United States,selectionType:INCLUDED)))),keywords:foo)
 *  We extract filter type -> [text...] and keywords. */
export function parseSalesNavQuery(expr: string | null): { filters: Record<string, string[]>; keywords: string | null } {
  const filters: Record<string, string[]> = {};
  if (!expr) return { filters, keywords: null };
  const typeRe = /\(type:([A-Z_]+),values:List\((.*?)\)\)(?=,\(type:|\)\)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(expr))) {
    const type = m[1];
    const texts: string[] = [];
    const textRe = /text:([^,)]+)(?:,|\))/g;
    let t: RegExpExecArray | null;
    while ((t = textRe.exec(m[2]))) texts.push(safeDecode(t[1]).trim()); // values are percent-encoded inside the expression
    const excluded = /selectionType:EXCLUDED/.test(m[2]);
    filters[excluded ? `${type}_EXCLUDED` : type] = texts;
  }
  const kw = expr.match(/(?:^|[(,])keywords:([^,)]+)/);
  return { filters, keywords: kw ? safeDecode(kw[1]).trim() : null };
}

export function buildSearchRecord(url: string, pageType: PageType, totalHint: number | null, now: string): SearchRecord {
  const params = decodeParams(url);
  const surface = pageType.startsWith("salesnav") ? "sales_navigator" : "linkedin";
  const queryExpression = params.query ?? null;
  // A bare `query=foo` (no parenthesised expression) is a plain keyword search.
  const parsed = surface === "sales_navigator" ? (queryExpression && !queryExpression.startsWith("(") ? { filters: {}, keywords: queryExpression } : parseSalesNavQuery(queryExpression)) : { filters: {}, keywords: params.keywords ?? null };
  const list = url.match(/\/sales\/lists\/people\/([^/?#]+)/);
  return {
    search_url: url,
    page_type: pageType,
    surface,
    params,
    query_expression: queryExpression,
    keywords: parsed.keywords,
    filters: parsed.filters,
    total_hint: totalHint,
    page: Number(params.page ?? "1") || 1,
    list_id: list ? list[1] : null,
    captured_at: now
  };
}

/** Human label for an import: keywords + filters for Sales Navigator searches,
 *  the list id for lead lists, keywords for LinkedIn search. */
export function searchName(url: string, pageType: PageType, pageTitle?: string | null): string | null {
  const r = buildSearchRecord(url, pageType, null, "");
  if (r.list_id) return pageTitle && !/sales navigator/i.test(pageTitle) ? `${pageTitle} (list ${r.list_id})` : `Sales Navigator list ${r.list_id}`;
  const parts: string[] = [];
  if (r.keywords) parts.push(r.keywords);
  for (const [k, v] of Object.entries(r.filters)) if (v.length) parts.push(`${k.toLowerCase().replace(/_/g, " ")}: ${v.join(", ")}`);
  if (parts.length) return parts.join(" · ").slice(0, 200);
  return pageTitle?.trim() || null;
}

/** Stable identity for dedupe: URL without the page param. */
export function searchKey(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const parts = url.slice(q + 1).split("#")[0].split("&").filter((kv) => kv && !/^page=/.test(kv));
  return url.slice(0, q) + (parts.length ? "?" + parts.join("&") : "");
}
