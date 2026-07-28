/**
 * Shared OpenSky client helpers: process-level cache + global cooldown after 429.
 * Anonymous OpenSky is extremely limited; we must coalesce and back off hard.
 */

type CacheEntry<T> = { expiresAt: number; value: T };

const g = globalThis as typeof globalThis & {
  __openskyCache?: Map<string, CacheEntry<unknown>>;
  __openskyCooldownUntil?: number;
};

function cacheStore(): Map<string, CacheEntry<unknown>> {
  if (!g.__openskyCache) g.__openskyCache = new Map();
  return g.__openskyCache;
}

export function openskyCooldownActive(): boolean {
  return Date.now() < (g.__openskyCooldownUntil ?? 0);
}

export function openskyCooldownRemainingMs(): number {
  return Math.max(0, (g.__openskyCooldownUntil ?? 0) - Date.now());
}

/** Back off after rate limit (default 10 minutes). */
export function tripOpenskyCooldown(ms = 10 * 60_000): void {
  g.__openskyCooldownUntil = Date.now() + ms;
}

export function getOpenskyCached<T>(key: string): T | null {
  const hit = cacheStore().get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cacheStore().delete(key);
    return null;
  }
  return hit.value as T;
}

export function setOpenskyCached<T>(key: string, value: T, ttlMs: number): void {
  cacheStore().set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Round bbox to ~0.05° so nearby pans share one cache entry. */
export function openskyBboxCacheKey(
  west: number,
  south: number,
  east: number,
  north: number,
): string {
  const r = (n: number) => (Math.round(n * 20) / 20).toFixed(2);
  return `states:${r(west)},${r(south)},${r(east)},${r(north)}`;
}

export async function fetchOpensky(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (openskyCooldownActive()) {
    return new Response(null, { status: 429, statusText: "Cooldown" });
  }
  const res = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 429) {
    tripOpenskyCooldown();
  }
  return res;
}
