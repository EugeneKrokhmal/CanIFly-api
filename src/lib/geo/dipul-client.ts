/**
 * Live German UAS zones via dipul WFS (uas-betrieb.de),
 * the official DFS / BMDV geoservice behind uas-operations.bund.de.
 *
 * Restriction semantics follow LuftVO § 21h for the open category (c0–c4):
 * ED-318 WFS/GeoJSON often labels zones REQ_AUTHORIZATION, but airports are
 * only legal in the specific category — we surface those as PROHIBITED.
 * Sources: dipul WFS + Rechtsgrundlagen (dipul.bund.de) + ED-318 sample.
 */
import {
  buildMatchedZoneFromProvider,
  zoneVisualStatus,
  type MatchedZone,
  type UasZoneFeature,
} from "@canifly/middleware";
import { ViewportLayerCache } from "./geojson-bbox-cache";
import { ensureHeapForHeavyCache } from "./memory-guard";

const DIPUL_WFS = "https://uas-betrieb.de/geoservices/dipul/wfs";

/** Skip continent-scale paint queries (°). */
const MAX_MAP_BBOX_DEG = 3.5;
const CLAMP_MAP_BBOX_DEG = 2.0;

/**
 * Cap parallel WFS layer fetches. ~30 layers at once spikes RSS on small hosts
 * (Render free exit 134) when national GeoJSON caches are already warm.
 */
const WFS_CONCURRENCY = 4;

/** Germany AABB for national ingest tiles (middleware GERMANY_COUNTRY.bounds). */
const DE_BOUNDS = {
  minLng: 5.87,
  maxLng: 15.04,
  minLat: 47.27,
  maxLat: 55.1,
} as const;

/** Tile size for national WFS crawl (°). Keep ≤ live clamp. */
const INGEST_TILE_DEG = 2.0;
const INGEST_PAGE_SIZE = 5_000;
const INGEST_CONCURRENCY = 3;

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Status layers (point). Includes residential parcels — important in DE open category.
 * Map omits wohngrundstuecke (nationwide dense polygons).
 */
const STATUS_TYPES: readonly string[] = [
  "dipul:kontrollzonen",
  "dipul:flughaefen",
  "dipul:flugplaetze",
  "dipul:flugbeschraenkungsgebiete",
  "dipul:temporaere_betriebseinschraenkungen",
  "dipul:militaerische_anlagen",
  "dipul:krankenhaeuser",
  "dipul:polizei",
  "dipul:justizvollzugsanstalten",
  "dipul:behoerden",
  "dipul:sicherheitsbehoerden",
  "dipul:diplomatische_vertretungen",
  "dipul:internationale_organisationen",
  "dipul:labore",
  "dipul:industrieanlagen",
  "dipul:kraftwerke",
  "dipul:umspannwerke",
  "dipul:stromleitungen",
  "dipul:windkraftanlagen",
  "dipul:bahnanlagen",
  "dipul:bundesautobahnen",
  "dipul:bundesstrassen",
  "dipul:binnenwasserstrassen",
  "dipul:seewasserstrassen",
  "dipul:schifffahrtsanlagen",
  "dipul:nationalparks",
  "dipul:naturschutzgebiete",
  "dipul:ffh-gebiete",
  "dipul:vogelschutzgebiete",
  "dipul:freibaeder",
  "dipul:wohngrundstuecke",
];

const MAP_TYPES = STATUS_TYPES.filter((t) => t !== "dipul:wohngrundstuecke");

/** Map layers used for PostGIS national sync (excludes dense residential parcels). */
export const DIPUL_INGEST_TYPES = MAP_TYPES;

const viewportLayerCache = new ViewportLayerCache();

export class DipulFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DipulFetchError";
  }
}

interface DipulProps {
  name?: string | string[];
  generated_name_EN?: string;
  generated_name_DE?: string;
  external_reference?: string;
  type_code?: string;
  legal_ref?: string;
  lower_limit_altitude?: number;
  upper_limit_altitude?: number;
  lower_limit_unit?: string;
  upper_limit_unit?: string;
  lower_limit_alt_ref?: string;
  upper_limit_alt_ref?: string;
  [key: string]: unknown;
}

function isTimeout(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "TimeoutError") ||
    (err instanceof Error && /aborted due to timeout|TimeoutError/i.test(err.message))
  );
}

async function fetchGeoJson(
  url: string,
  timeoutMs = 8_000,
): Promise<GeoJSON.FeatureCollection> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new DipulFetchError(`HTTP ${response.status}`, url, response.status);
    }
    const data = (await response.json()) as GeoJSON.FeatureCollection & {
      error?: unknown;
    };
    if (!data || data.type !== "FeatureCollection") {
      return { type: "FeatureCollection", features: [] };
    }
    return data;
  } catch (err) {
    if (isTimeout(err)) {
      throw new DipulFetchError("dipul timeout", url, undefined, err);
    }
    throw err instanceof DipulFetchError
      ? err
      : new DipulFetchError(String(err), url, undefined, err);
  }
}

function propsToMatchedZone(props: DipulProps): MatchedZone | null {
  return buildMatchedZoneFromProvider({
    source: "dipul",
    rawAttributes: props,
  });
}

function clampMapBbox(
  west: number,
  south: number,
  east: number,
  north: number,
): { west: number; south: number; east: number; north: number } | null {
  const spanLng = east - west;
  const spanLat = north - south;
  if (spanLng <= 0 || spanLat <= 0) return null;
  if (spanLng > MAX_MAP_BBOX_DEG * 2 || spanLat > MAX_MAP_BBOX_DEG * 2) {
    return null;
  }
  if (spanLng <= MAX_MAP_BBOX_DEG && spanLat <= MAX_MAP_BBOX_DEG) {
    return { west, south, east, north };
  }
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const half = CLAMP_MAP_BBOX_DEG / 2;
  return {
    west: cx - half,
    east: cx + half,
    south: cy - half,
    north: cy + half,
  };
}

function buildBboxUrl(
  typeName: string,
  west: number,
  south: number,
  east: number,
  north: number,
  count: number,
): string {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    srsName: "EPSG:4326",
    // dipul expects minLon,minLat,maxLon,maxLat,EPSG:4326
    bbox: `${west},${south},${east},${north},EPSG:4326`,
    count: String(count),
    outputFormat: "application/json",
  });
  return `${DIPUL_WFS}?${params}`;
}

/**
 * Live point query — tiny envelope around the pin (WFS has no native point op).
 */
export async function queryDipulPoint(
  lat: number,
  lng: number,
): Promise<MatchedZone[]> {
  // Free stacked nationals if near soft/RSS limit before ~30 layer fan-out.
  ensureHeapForHeavyCache("dipul-point");

  const pad = 0.0004; // ~40 m
  const matches: MatchedZone[] = [];
  const seen = new Set<string>();

  await mapConcurrent(STATUS_TYPES, WFS_CONCURRENCY, async (typeName) => {
    const url = buildBboxUrl(
      typeName,
      lng - pad,
      lat - pad,
      lng + pad,
      lat + pad,
      30,
    );
    try {
      const fc = await fetchGeoJson(url, 6_000);
      for (const feature of fc.features ?? []) {
        const zone = propsToMatchedZone(
          (feature.properties ?? {}) as DipulProps,
        );
        if (!zone) continue;
        const key = `${zone.identifier}:${zone.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(zone);
      }
    } catch (err) {
      if (
        isTimeout(err) ||
        (err instanceof DipulFetchError && isTimeout(err.cause))
      ) {
        console.warn(`[dipul] ${typeName} point timeout`);
      } else {
        console.warn(`[dipul] ${typeName} point failed`, err);
      }
    }
  });

  return matches;
}

/**
 * Map bbox — live WFS per layer with viewport cache (30 min). Point stays live WFS.
 */
export async function queryDipulBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  limit = 500,
): Promise<GeoJSON.FeatureCollection> {
  const clamped = clampMapBbox(west, south, east, north);
  if (!clamped) {
    return { type: "FeatureCollection", features: [] };
  }

  ensureHeapForHeavyCache("dipul-bbox");

  const perLayer = Math.max(15, Math.floor(limit / MAP_TYPES.length));
  const merged: GeoJSON.Feature[] = [];
  const seen = new Set<string>();

  await mapConcurrent(MAP_TYPES, WFS_CONCURRENCY, async (typeName) => {
    let layerFeatures: GeoJSON.Feature[] = [];
    try {
      layerFeatures = await viewportLayerCache.get(
        typeName,
        clamped.west,
        clamped.south,
        clamped.east,
        clamped.north,
        async () => {
          const url = buildBboxUrl(
            typeName,
            clamped.west,
            clamped.south,
            clamped.east,
            clamped.north,
            perLayer,
          );
          const fc = await fetchGeoJson(url, 8_000);
          const out: GeoJSON.Feature[] = [];
          const layerSeen = new Set<string>();
          for (const feature of fc.features ?? []) {
            const zone = propsToMatchedZone(
              (feature.properties ?? {}) as DipulProps,
            );
            if (!zone || !feature.geometry) continue;
            const key = `${zone.identifier}:${zone.name}`;
            if (layerSeen.has(key)) continue;
            layerSeen.add(key);
            out.push({
              type: "Feature",
              id: zone.identifier,
              geometry: feature.geometry,
              properties: {
                identifier: zone.identifier,
                name: zone.name,
                restriction: zone.restriction,
                reason: zone.reason,
                source: zone.source,
                country: "DE",
                lowerLimitM: zone.lowerLimitM,
                upperLimitM: zone.upperLimitM,
                lowerRef: zone.lowerRef,
                upperRef: zone.upperRef,
                message: zone.message,
                mapStatus: zoneVisualStatus(zone),
              },
            });
          }
          return out;
        },
      );
    } catch (err) {
      if (
        isTimeout(err) ||
        (err instanceof DipulFetchError && isTimeout(err.cause))
      ) {
        console.warn(`[dipul] ${typeName} bbox timeout`);
      } else {
        console.warn(`[dipul] ${typeName} bbox failed`, err);
      }
      return;
    }
    for (const f of layerFeatures) {
      const p = (f.properties ?? {}) as { identifier?: string; name?: string };
      const key = `${p.identifier ?? ""}:${p.name ?? ""}`;
      if (key !== ":" && seen.has(key)) continue;
      if (key !== ":") seen.add(key);
      merged.push(f);
    }
  });

  return {
    type: "FeatureCollection",
    features: merged.slice(0, limit),
  };
}

/** Convert a dipul WFS feature into an ED-318-shaped zone for PostGIS ingest. */
export function dipulFeatureToUasZone(
  feature: GeoJSON.Feature,
): UasZoneFeature | null {
  const geom = feature.geometry;
  if (
    !geom ||
    (geom.type !== "Polygon" && geom.type !== "MultiPolygon")
  ) {
    return null;
  }
  const zone = propsToMatchedZone((feature.properties ?? {}) as DipulProps);
  if (!zone) return null;
  const typeCode = String(
    (feature.properties as DipulProps | null)?.type_code ?? "COMMON",
  );
  return {
    identifier: zone.identifier,
    country: "DEU",
    name: zone.name,
    type: typeCode,
    restriction: zone.restriction,
    reason: zone.reason,
    message: zone.message,
    geometry: [
      {
        upperLimit: zone.upperLimitM,
        lowerLimit: zone.lowerLimitM,
        uomDimensions: "M",
        upperVerticalReference: zone.upperRef,
        lowerVerticalReference: zone.lowerRef,
        horizontalProjection: geom,
      },
    ],
  };
}

function buildIngestTiles(): Array<{
  west: number;
  south: number;
  east: number;
  north: number;
}> {
  const tiles: Array<{
    west: number;
    south: number;
    east: number;
    north: number;
  }> = [];
  for (
    let west = DE_BOUNDS.minLng;
    west < DE_BOUNDS.maxLng;
    west += INGEST_TILE_DEG
  ) {
    for (
      let south = DE_BOUNDS.minLat;
      south < DE_BOUNDS.maxLat;
      south += INGEST_TILE_DEG
    ) {
      tiles.push({
        west,
        south,
        east: Math.min(west + INGEST_TILE_DEG, DE_BOUNDS.maxLng),
        north: Math.min(south + INGEST_TILE_DEG, DE_BOUNDS.maxLat),
      });
    }
  }
  return tiles;
}

async function fetchDipulTileLayer(
  typeName: string,
  west: number,
  south: number,
  east: number,
  north: number,
): Promise<GeoJSON.Feature[]> {
  const out: GeoJSON.Feature[] = [];
  let startIndex = 0;
  for (;;) {
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: typeName,
      srsName: "EPSG:4326",
      bbox: `${west},${south},${east},${north},EPSG:4326`,
      count: String(INGEST_PAGE_SIZE),
      startIndex: String(startIndex),
      outputFormat: "application/json",
    });
    const url = `${DIPUL_WFS}?${params}`;
    const fc = await fetchGeoJson(url, 45_000);
    const batch = fc.features ?? [];
    out.push(...batch);
    if (batch.length < INGEST_PAGE_SIZE) break;
    startIndex += batch.length;
    // Safety: avoid runaway pagination on broken servers.
    if (startIndex > 50_000) break;
  }
  return out;
}

export type DipulIngestProgress = {
  done: number;
  total: number;
  typeName: string;
  zones: number;
};

/**
 * Crawl Germany dipul MAP layers into deduped UasZoneFeatures for PostGIS.
 * Skips wohngrundstuecke (too dense for national store / map).
 */
export async function fetchDipulNationalZones(
  onProgress?: (p: DipulIngestProgress) => void,
): Promise<UasZoneFeature[]> {
  const tiles = buildIngestTiles();
  const jobs: Array<{ typeName: string; tile: (typeof tiles)[number] }> = [];
  for (const typeName of DIPUL_INGEST_TYPES) {
    for (const tile of tiles) {
      jobs.push({ typeName, tile });
    }
  }

  const byId = new Map<string, UasZoneFeature>();
  let done = 0;

  await mapConcurrent(jobs, INGEST_CONCURRENCY, async (job) => {
    try {
      const features = await fetchDipulTileLayer(
        job.typeName,
        job.tile.west,
        job.tile.south,
        job.tile.east,
        job.tile.north,
      );
      for (const f of features) {
        const zone = dipulFeatureToUasZone(f);
        if (!zone) continue;
        if (!byId.has(zone.identifier)) {
          byId.set(zone.identifier, zone);
        }
      }
    } catch (err) {
      console.warn(
        `[dipul-ingest] ${job.typeName} ${job.tile.west},${job.tile.south} failed`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      done += 1;
      onProgress?.({
        done,
        total: jobs.length,
        typeName: job.typeName,
        zones: byId.size,
      });
    }
  });

  return [...byId.values()];
}
