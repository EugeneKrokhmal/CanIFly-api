/**
 * In-memory cache for map zone bbox queries.
 * UAS geographical zones change infrequently — reuse responses across pans.
 */

import type { DroneProfile } from "@canifly/middleware";
import type { QueryMeta } from "../db/queries.js";

export type ZoneBboxCacheValue = {
  collection: GeoJSON.FeatureCollection;
  meta: QueryMeta;
};

type CacheEntry = { expiresAt: number; value: ZoneBboxCacheValue };

const g = globalThis as typeof globalThis & {
  __zoneBboxCache?: Map<string, CacheEntry>;
  __zoneBboxInflight?: Map<string, Promise<ZoneBboxCacheValue>>;
};

const MAX_ENTRIES = 48;
const DEFAULT_TTL_MS = 30 * 60_000;

function cacheStore(): Map<string, CacheEntry> {
  if (!g.__zoneBboxCache) g.__zoneBboxCache = new Map();
  return g.__zoneBboxCache;
}

function inflightStore(): Map<string, Promise<ZoneBboxCacheValue>> {
  if (!g.__zoneBboxInflight) g.__zoneBboxInflight = new Map();
  return g.__zoneBboxInflight;
}

export function zoneBboxCacheTtlMs(): number {
  const raw = Number(process.env.ZONE_BBOX_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/** Round bbox to ~0.1° so nearby pans share one cache entry. */
export function zoneBboxCacheKey(
  west: number,
  south: number,
  east: number,
  north: number,
  profile: Pick<DroneProfile, "weightClass">,
  altitudeAgl: number,
  limit: number,
): string {
  const r = (n: number) => (Math.round(n / 0.1) * 0.1).toFixed(2);
  return `zones:${r(west)},${r(south)},${r(east)},${r(north)}:${profile.weightClass}:${altitudeAgl}:${limit}`;
}

function trimCache(store: Map<string, CacheEntry>): void {
  if (store.size <= MAX_ENTRIES) return;
  const oldest = store.keys().next().value;
  if (oldest) store.delete(oldest);
}

export function getZoneBboxCached(key: string): ZoneBboxCacheValue | null {
  const hit = cacheStore().get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cacheStore().delete(key);
    return null;
  }
  return hit.value;
}

export function setZoneBboxCached(
  key: string,
  value: ZoneBboxCacheValue,
  ttlMs = zoneBboxCacheTtlMs(),
): void {
  const store = cacheStore();
  trimCache(store);
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export async function coalesceZoneBbox<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const store = inflightStore();
  const existing = store.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = run().finally(() => {
    store.delete(key);
  });
  store.set(key, promise as Promise<ZoneBboxCacheValue>);
  return promise;
}

/** Drop cached map tiles after admin ingest/sync. */
export function clearZoneBboxCache(): void {
  cacheStore().clear();
}
