/**
 * In-memory Open-Meteo weather cache + 429 cooldown.
 * Render (and other cloud) egress IPs share limits; cache cuts duplicate calls.
 */

type CacheEntry<T> = {
  value: T;
  /** Fresh until this time — serve without revalidation. */
  freshUntil: number;
  /** Stale-but-usable until this time (e.g. while upstream 429). */
  staleUntil: number;
};

const g = globalThis as typeof globalThis & {
  __weatherCache?: Map<string, CacheEntry<unknown>>;
  __weatherInflight?: Map<string, Promise<unknown>>;
  __weatherCooldownUntil?: number;
};

const FRESH_MS = 15 * 60_000;
const STALE_MS = 2 * 60 * 60_000;
const MAX_ENTRIES = 500;

function cacheStore(): Map<string, CacheEntry<unknown>> {
  if (!g.__weatherCache) g.__weatherCache = new Map();
  return g.__weatherCache;
}

function inflightStore(): Map<string, Promise<unknown>> {
  if (!g.__weatherInflight) g.__weatherInflight = new Map();
  return g.__weatherInflight;
}

function trim(store: Map<string, CacheEntry<unknown>>): void {
  if (store.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.staleUntil < now) store.delete(k);
  }
  while (store.size > MAX_ENTRIES) {
    const first = store.keys().next().value;
    if (first == null) break;
    store.delete(first);
  }
}

/** ~1 km grid so nearby viewers share one upstream call. */
export function weatherCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

export function weatherCooldownActive(): boolean {
  return Date.now() < (g.__weatherCooldownUntil ?? 0);
}

export function tripWeatherCooldown(ms = 10 * 60_000): void {
  g.__weatherCooldownUntil = Date.now() + ms;
  console.warn(
    `[weather] Open-Meteo cooldown ${Math.round(ms / 1000)}s after rate limit`,
  );
}

export function getWeatherCached<T>(
  key: string,
): { value: T; fresh: boolean } | null {
  const hit = cacheStore().get(key);
  if (!hit) return null;
  const now = Date.now();
  if (now > hit.staleUntil) {
    cacheStore().delete(key);
    return null;
  }
  return { value: hit.value as T, fresh: now <= hit.freshUntil };
}

export function setWeatherCached<T>(key: string, value: T): void {
  const now = Date.now();
  const store = cacheStore();
  store.set(key, {
    value,
    freshUntil: now + FRESH_MS,
    staleUntil: now + STALE_MS,
  });
  trim(store);
}

/** Coalesce concurrent fetches for the same cell. */
export async function withWeatherInflight<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const inflight = inflightStore();
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}
