/**
 * Preference engine: pick the "best" search result based on what the customer
 * has bought before (order history) and an explicit preferred-brands list.
 *
 * Matching order:
 *   1. Exact product id seen in a previous order.
 *   2. Brand seen in a previous order.
 *   3. Brand in the explicit preferred-brands list.
 *   4. Fall back to the first (top-ranked) result.
 */

import type { PreferenceItem, SearchProduct } from '../types.js';

const normalize = (s: string): string =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenSet = (s: string): Set<string> =>
  new Set(normalize(s).split(' ').filter(Boolean));

/** Jaccard similarity over word tokens (0..1). */
export function jaccard(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const uni = new Set([...A, ...B]).size;
  return inter / uni;
}

/** Loose "is this title about the same thing as the query" check. */
export function isSimilar(query: string, title: string): boolean {
  const nq = normalize(query);
  const nt = normalize(title);
  if (!nq || !nt) return false;
  if (nt.includes(nq) || nq.includes(nt)) return true;
  return jaccard(nq, nt) >= 0.35;
}

export interface PreferenceMatch {
  product: SearchProduct;
  reason: 'order-history-product' | 'order-history-brand' | 'preferred-brand' | 'top-result';
}

export function findPreferredProduct(
  products: SearchProduct[],
  history: PreferenceItem[],
  preferredBrands: string[],
): PreferenceMatch | null {
  if (!products.length) return null;

  // 1) Exact product id from order history.
  const prevIds = new Set(history.map((p) => p.productId));
  const exact = products.find((p) => prevIds.has(p.productId));
  if (exact) return { product: exact, reason: 'order-history-product' };

  // 2) Brand from order history.
  const prevBrands = new Set(
    history.map((p) => p.brand?.toLowerCase()).filter((b): b is string => Boolean(b)),
  );
  if (prevBrands.size) {
    const match = products.find((p) => p.brand && prevBrands.has(p.brand.toLowerCase()));
    if (match) return { product: match, reason: 'order-history-brand' };
  }

  // 3) Explicit preferred-brands list.
  if (preferredBrands.length) {
    const set = new Set(preferredBrands.map((b) => b.toLowerCase()));
    const match = products.find((p) => p.brand && set.has(p.brand.toLowerCase()));
    if (match) return { product: match, reason: 'preferred-brand' };
  }

  // 4) Top result.
  return { product: products[0]!, reason: 'top-result' };
}

/** Merge freshly-fetched order items into an existing preference cache (never drops old entries). */
export function mergePreferences(
  existing: PreferenceItem[],
  fresh: PreferenceItem[],
): { merged: PreferenceItem[]; added: number } {
  const seen = new Set<number>();
  const merged: PreferenceItem[] = [];
  for (const item of [...existing, ...fresh]) {
    if (item.productId && !seen.has(item.productId)) {
      seen.add(item.productId);
      merged.push(item);
    }
  }
  return { merged, added: merged.length - existing.filter((e) => e.productId).length };
}
