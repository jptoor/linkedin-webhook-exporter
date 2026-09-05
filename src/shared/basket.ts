/** Pure helpers for the cross-page selection basket. Storage lives in the
 *  worker (chrome.storage.session); these functions never touch chrome.*. */
import { dedupeKey } from "./normalize";
import { searchKey } from "./search";
import { LIMITS, type BasketItem, type LeadRecord, type PageType } from "./types";

export type Basket = Record<string, BasketItem>;

export function addToBasket(basket: Basket, leads: LeadRecord[], pageType: PageType, pageUrl: string, pageTitle: string | null, now: number, max: number = LIMITS.basketMax): { basket: Basket; added: string[]; full: boolean } {
  const next: Basket = { ...basket };
  const added: string[] = [];
  let full = false;
  for (const lead of leads) {
    const key = dedupeKey(lead);
    if (next[key]) continue;
    if (Object.keys(next).length >= max) {
      full = true;
      break;
    }
    next[key] = { key, lead, pageType, pageUrl, pageTitle, addedAt: now };
    added.push(key);
  }
  return { basket: next, added, full };
}

export function removeFromBasket(basket: Basket, keys: string[]): Basket {
  const next = { ...basket };
  for (const k of keys) delete next[k];
  return next;
}

export function basketItems(basket: Basket): BasketItem[] {
  return Object.values(basket).sort((a, b) => a.addedAt - b.addedAt);
}

/** Distinct source pages (search URL without page/session params). */
export function basketPages(basket: Basket): number {
  return new Set(Object.values(basket).map((i) => pageGroupKey(i))).size;
}

function pageNumber(url: string): string {
  try {
    return new URL(url).searchParams.get("page") ?? "1";
  } catch {
    return "1";
  }
}

export function pageGroupKey(item: BasketItem): string {
  try {
    return searchKey(item.pageUrl);
  } catch {
    return item.pageUrl;
  }
}

/** Group basket items by the page they came from so each group can carry its
 *  own search name / list id in the import record. */
export function groupByPage(items: BasketItem[]): Array<{ pageType: PageType; pageUrl: string; pageTitle: string | null; leads: LeadRecord[]; keys: string[] }> {
  const groups = new Map<string, { pageType: PageType; pageUrl: string; pageTitle: string | null; leads: LeadRecord[]; keys: string[] }>();
  for (const it of items) {
    // Same search, different result page: separate groups so each lead keeps its page number.
    const k = `${it.pageType}|${pageGroupKey(it)}|${pageNumber(it.pageUrl)}`;
    const g = groups.get(k) ?? { pageType: it.pageType, pageUrl: it.pageUrl, pageTitle: it.pageTitle, leads: [], keys: [] };
    g.leads.push(it.lead);
    g.keys.push(it.key);
    groups.set(k, g);
  }
  return Array.from(groups.values());
}
