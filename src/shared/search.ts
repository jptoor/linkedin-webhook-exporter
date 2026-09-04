import type { PageType, SearchRecord } from "./types";

/** Query parameters that identify a browsing session or tracking context and
 *  must never be sent downstream. */
const SENSITIVE_PARAMS = new Set(["sessionid", "_ntb", "trk", "trkinfo", "lici", "licu", "midtoken", "midsig", "trkemail", "otptoken", "eid", "refid", "trackingid", "origin", "originalsubdomain", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);

export function isSensitiveParam(key: string): boolean {
  return SENSITIVE_PARAMS.has(key.toLowerCase());
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** Split a query string textually so LinkedIn's encoding survives, then
 *  decode values. Repeated keys keep every value (`key` -> last, `key[]` -> all)
 *  so nothing is silently overwritten. Sensitive keys are dropped. */
export function decodeParams(url: string, opts: { redact?: boolean } = { redact: true }): Record<string, string> {
  const out: Record<string, string> = {};
  const q = url.indexOf("?");
  if (q < 0) return out;
  const raw = url.slice(q + 1).split("#")[0];
  const seen: Record<string, string[]> = {};
  for (const kv of raw.split("&")) {
    if (!kv) continue;
    const i = kv.indexOf("=");
    const k = safeDecode(i < 0 ? kv : kv.slice(0, i)).slice(0, 100);
    if (!k) continue;
    if (opts.redact !== false && isSensitiveParam(k)) continue;
    const v = (i < 0 ? "" : safeDecode(kv.slice(i + 1))).slice(0, 4000);
    (seen[k] ??= []).push(v);
  }
  for (const [k, vs] of Object.entries(seen)) {
    out[k] = vs[vs.length - 1];
    if (vs.length > 1) out[`${k}[]`] = JSON.stringify(vs);
  }
  return out;
}

/* ---------------- Sales Navigator query expression grammar ----------------
 * (spellCorrectionEnabled:true,filters:List((type:CURRENT_TITLE,values:List((id:x,text:CRO,selectionType:INCLUDED)))),keywords:foo)
 * A tiny recursive parser: `(` key:value `,` ... `)`; values are scalars,
 * nested groups, or `List(...)`. Text values may contain percent escapes.
 */
type Node = string | Node[] | { [k: string]: Node };

function parseExpr(src: string): Node {
  let i = 0;
  const n = src.length;
  const peek = () => src[i];
  const readScalar = (): string => {
    const start = i;
    while (i < n && src[i] !== "," && src[i] !== ")" && src[i] !== "(") i++;
    return src.slice(start, i);
  };
  const readKey = (): string => {
    const start = i;
    while (i < n && src[i] !== ":" && src[i] !== "," && src[i] !== ")" && src[i] !== "(") i++;
    return src.slice(start, i);
  };
  const parseValue = (): Node => {
    if (src.startsWith("List(", i)) {
      i += 5;
      const items: Node[] = [];
      while (i < n && peek() !== ")") {
        items.push(parseValue());
        if (peek() === ",") i++;
      }
      i++; // )
      return items;
    }
    if (peek() === "(") {
      i++;
      const obj: { [k: string]: Node } = {};
      let guard = 0;
      while (i < n && peek() !== ")" && guard++ < 10_000) {
        const key = readKey();
        if (peek() === ":") {
          i++;
          obj[key] = parseValue();
        } else obj[key] = "";
        if (peek() === ",") i++;
      }
      i++; // )
      return obj;
    }
    return readScalar();
  };
  const v = parseValue();
  return v;
}

export function parseSalesNavQuery(expr: string | null): { filters: Record<string, string[]>; keywords: string | null } {
  const filters: Record<string, string[]> = {};
  if (!expr || typeof expr !== "string" || expr.length > 20_000) return { filters, keywords: null };
  if (!expr.startsWith("(")) return { filters, keywords: safeDecode(expr).trim() || null };
  let tree: Node;
  try {
    tree = parseExpr(expr);
  } catch {
    return { filters, keywords: null };
  }
  if (typeof tree !== "object" || Array.isArray(tree)) return { filters, keywords: null };
  const root = tree as { [k: string]: Node };
  const list = Array.isArray(root.filters) ? (root.filters as Node[]) : [];
  for (const f of list) {
    if (typeof f !== "object" || Array.isArray(f)) continue;
    const type = typeof f.type === "string" ? f.type : null;
    if (!type || !/^[A-Z][A-Z0-9_]{0,60}$/.test(type)) continue;
    const values = Array.isArray(f.values) ? (f.values as Node[]) : [];
    for (const v of values) {
      if (typeof v !== "object" || Array.isArray(v)) continue;
      const text = typeof v.text === "string" ? safeDecode(v.text).trim() : typeof v.id === "string" ? safeDecode(v.id).trim() : "";
      if (!text) continue;
      const excluded = v.selectionType === "EXCLUDED";
      (filters[excluded ? `${type}_EXCLUDED` : type] ??= []).push(text.slice(0, 200));
    }
  }
  const kw = typeof root.keywords === "string" ? safeDecode(root.keywords).trim() : null;
  return { filters, keywords: kw || null };
}

export function buildSearchRecord(url: string, pageType: PageType, totalHint: number | null, now: string): SearchRecord {
  const params = decodeParams(url);
  const surface = pageType.startsWith("salesnav") ? "sales_navigator" : "linkedin";
  const queryExpression = params.query ?? null;
  const parsed = surface === "sales_navigator" ? parseSalesNavQuery(queryExpression) : { filters: {}, keywords: params.keywords ?? null };
  const list = url.match(/\/sales\/lists\/people\/([^/?#]+)/);
  const page = Number(params.page ?? params.Page ?? "1");
  return {
    search_url: searchKey(url),
    page_type: pageType,
    surface,
    params,
    query_expression: queryExpression,
    keywords: parsed.keywords,
    filters: parsed.filters,
    total_hint: totalHint,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    list_id: list ? list[1].slice(0, 64) : null,
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
  return pageTitle?.trim().slice(0, 200) || null;
}

/** Stable identity for dedupe and the value sent as `search_url`: the URL
 *  without the page param and without session/tracking parameters. */
export function searchKey(url: string): string {
  const hashIdx = url.indexOf("#");
  const noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const q = noHash.indexOf("?");
  if (q < 0) return noHash;
  const parts = noHash
    .slice(q + 1)
    .split("&")
    .filter((kv) => {
      if (!kv) return false;
      const k = safeDecode(kv.split("=")[0]).toLowerCase();
      return k !== "page" && !isSensitiveParam(k);
    });
  return noHash.slice(0, q) + (parts.length ? "?" + parts.join("&") : "");
}
