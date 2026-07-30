/**
 * Shared helpers for national GeoJSON caches (map bbox queries).
 * Point/status queries stay on live upstream APIs.
 */
import {
  ensureHeapForHeavyCache,
  registerGeoCacheClearer,
} from "./memory-guard";

export const NATIONAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function featureEnvelope(
  geometry: GeoJSON.Geometry,
): { minLng: number; maxLng: number; minLat: number; maxLat: number } | null {
  const coords: number[][] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c) || c.length === 0) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      coords.push([c[0], c[1]]);
      return;
    }
    for (const item of c) walk(item);
  };
  walk(
    geometry.type === "GeometryCollection"
      ? geometry.geometries
      : (geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | GeoJSON.Point).coordinates,
  );
  if (coords.length === 0) return null;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLng, maxLng, minLat, maxLat };
}

export function geometryIntersectsBbox(
  geometry: GeoJSON.Geometry,
  west: number,
  south: number,
  east: number,
  north: number,
): boolean {
  const e = featureEnvelope(geometry);
  if (!e) return false;
  return !(east < e.minLng || west > e.maxLng || north < e.minLat || south > e.maxLat);
}

export function filterFeaturesByBbox(
  features: GeoJSON.Feature[],
  west: number,
  south: number,
  east: number,
  north: number,
  limit: number,
): GeoJSON.Feature[] {
  const out: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    if (!f.geometry || !geometryIntersectsBbox(f.geometry, west, south, east, north)) {
      continue;
    }
    const p = (f.properties ?? {}) as { identifier?: string; name?: string };
    const key = `${p.identifier ?? ""}:${p.name ?? ""}`;
    if (key !== ":" && seen.has(key)) continue;
    if (key !== ":") seen.add(key);
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

export class TimedFeatureCache {
  private entry: { fetchedAt: number; features: GeoJSON.Feature[] } | null = null;
  private inflight: Promise<GeoJSON.Feature[]> | null = null;

  constructor(private readonly ttlMs: number) {
    registerGeoCacheClearer(() => this.clear());
  }

  async get(
    fetchFeatures: () => Promise<GeoJSON.Feature[]>,
  ): Promise<GeoJSON.Feature[]> {
    const now = Date.now();
    if (this.entry && now - this.entry.fetchedAt < this.ttlMs) {
      return this.entry.features;
    }
    if (!ensureHeapForHeavyCache("TimedFeatureCache")) {
      throw new Error("heap soft limit — skip national map cache");
    }
    if (!this.inflight) {
      this.inflight = fetchFeatures()
        .then((features) => {
          this.entry = { fetchedAt: Date.now(), features };
          return features;
        })
        .catch((err) => {
          this.inflight = null;
          throw err;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  clear(): void {
    this.entry = null;
    this.inflight = null;
  }

  isWarm(): boolean {
    return (
      this.entry != null &&
      Date.now() - this.entry.fetchedAt < this.ttlMs
    );
  }
}

const VIEWPORT_CACHE_TTL_MS = 30 * 60 * 1000;
const VIEWPORT_CACHE_MAX = 24;

export function roundedBboxKey(
  west: number,
  south: number,
  east: number,
  north: number,
  precision = 1,
): string {
  return `${west.toFixed(precision)}:${south.toFixed(precision)}:${east.toFixed(precision)}:${north.toFixed(precision)}`;
}

/** Per-layer viewport cache — fast repeat pans without national warm-up. */
export class ViewportLayerCache {
  private entries = new Map<
    string,
    { fetchedAt: number; features: GeoJSON.Feature[] }
  >();
  private inflight = new Map<string, Promise<GeoJSON.Feature[]>>();

  constructor(
    private readonly ttlMs = VIEWPORT_CACHE_TTL_MS,
    private readonly maxEntries = VIEWPORT_CACHE_MAX,
  ) {
    registerGeoCacheClearer(() => this.clear());
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  async get(
    layerKey: string,
    west: number,
    south: number,
    east: number,
    north: number,
    fetchFeatures: () => Promise<GeoJSON.Feature[]>,
  ): Promise<GeoJSON.Feature[]> {
    const key = `${layerKey}:${roundedBboxKey(west, south, east, north)}`;
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) {
      return hit.features;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = fetchFeatures()
      .then((features) => {
        this.entries.set(key, { fetchedAt: Date.now(), features });
        if (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest) this.entries.delete(oldest);
        }
        return features;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }
}
