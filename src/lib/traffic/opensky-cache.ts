/**
 * Shared OpenSky client helpers: cache, cooldown, auth headers, in-flight coalesce.
 * Goal: hit OpenSky as rarely as possible while still serving traffic to the map.
 */

import {
  getOpenskyAccessToken,
  invalidateOpenskyToken,
  openskyCredentialsConfigured,
} from "./opensky-auth.js";

type CacheEntry<T> = { expiresAt: number; value: T };

const g = globalThis as typeof globalThis & {
  __openskyCache?: Map<string, CacheEntry<unknown>>;
  __openskyCooldownUntil?: number;
  __openskyInflight?: Map<string, Promise<unknown>>;
};

function cacheStore(): Map<string, CacheEntry<unknown>> {
  if (!g.__openskyCache) g.__openskyCache = new Map();
  return g.__openskyCache;
}

function inflightStore(): Map<string, Promise<unknown>> {
  if (!g.__openskyInflight) g.__openskyInflight = new Map();
  return g.__openskyInflight;
}

export function openskyCooldownActive(): boolean {
  return Date.now() < (g.__openskyCooldownUntil ?? 0);
}

export function openskyCooldownRemainingMs(): number {
  return Math.max(0, (g.__openskyCooldownUntil ?? 0) - Date.now());
}

/** Back off after rate limit. Authenticated: 2 min; anonymous: 10 min. */
export function tripOpenskyCooldown(ms?: number): void {
  const fallback = openskyCredentialsConfigured()
    ? 2 * 60_000
    : 10 * 60_000;
  g.__openskyCooldownUntil = Date.now() + (ms ?? fallback);
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

/**
 * Round bbox to ~0.15° so pans share one cache entry and fewer upstream calls.
 */
export function openskyBboxCacheKey(
  west: number,
  south: number,
  east: number,
  north: number,
): string {
  const r = (n: number) => (Math.round(n / 0.15) * 0.15).toFixed(2);
  return `states:${r(west)},${r(south)},${r(east)},${r(north)}`;
}

/** Share one OpenSky fetch across concurrent identical cache keys. */
export async function coalesceOpensky<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const store = inflightStore();
  const existing = store.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = run().finally(() => {
    store.delete(key);
  });
  store.set(key, promise);
  return promise;
}

export async function fetchOpensky(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (openskyCooldownActive()) {
    return new Response(null, { status: 429, statusText: "Cooldown" });
  }

  const token = await getOpenskyAccessToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res = await fetch(url, { ...init, headers });

  if (res.status === 401 && token) {
    invalidateOpenskyToken();
    const fresh = await getOpenskyAccessToken();
    if (fresh) {
      headers.Authorization = `Bearer ${fresh}`;
      res = await fetch(url, { ...init, headers });
    }
  }

  if (res.status === 429) {
    tripOpenskyCooldown();
  }
  return res;
}
