/**
 * Live French UAS restriction zones via IGN / Géoportail WFS (data.geopf.fr),
 * layer TRANSPORTS.DRONES.RESTRICTIONS:carte_restriction_drones_lf.
 * No SIA zip download — same live query pattern as dipul.
 *
 * Attributes: `limite` (e.g. "Vol interdit *", "Hauteur maximale de vol de 50 m *"),
 * `remarque` (legal note). Official ED-269 packs remain on sia.aviation-civile.gouv.fr.
 */
import {
  zoneVisualStatus,
  type MatchedZone,
  type UasRestriction,
} from "@canifly/middleware";
import {
  filterFeaturesByBbox,
  NATIONAL_CACHE_TTL_MS,
  TimedFeatureCache,
  ViewportLayerCache,
} from "./geojson-bbox-cache";

const GEOPF_WFS = "https://data.geopf.fr/wfs/ows";
const TYPE_NAME =
  "TRANSPORTS.DRONES.RESTRICTIONS:carte_restriction_drones_lf";

/** Metropolitan France bbox for map warm-cache. */
const FR_NATIONAL_BBOX = { west: -5.2, south: 41.3, east: 9.6, north: 51.2 };
const NATIONAL_FEATURE_COUNT = 3000;

const nationalMapCache = new TimedFeatureCache(NATIONAL_CACHE_TTL_MS);
const viewportBboxCache = new ViewportLayerCache();

/** Skip continent-scale paint queries (°). */
const MAX_MAP_BBOX_DEG = 3.5;
const CLAMP_MAP_BBOX_DEG = 2.0;

export class GeopfFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GeopfFetchError";
  }
}

interface GeopfProps {
  limite?: string | null;
  remarque?: string | null;
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
      throw new GeopfFetchError(`HTTP ${response.status}`, url, response.status);
    }
    const data = (await response.json()) as GeoJSON.FeatureCollection;
    if (!data || data.type !== "FeatureCollection") {
      return { type: "FeatureCollection", features: [] };
    }
    return data;
  } catch (err) {
    if (isTimeout(err)) {
      throw new GeopfFetchError("geopf timeout", url, undefined, err);
    }
    throw err instanceof GeopfFetchError
      ? err
      : new GeopfFetchError(String(err), url, undefined, err);
  }
}

function parseHeightLimitM(limite: string): number | null {
  const m = limite.match(/(\d+)\s*m/i);
  return m ? Number(m[1]) : null;
}

function restrictionForLimite(limite: string): UasRestriction {
  const t = limite.toLowerCase();
  if (t.includes("interdit") || t.includes("prohib")) return "PROHIBITED";
  if (t.includes("hauteur") || t.includes("maximale")) return "CONDITIONAL";
  if (!t.trim() || t === "none" || t === "null") return "CONDITIONAL";
  return "REQ_AUTHORISATION";
}

function propsToMatchedZone(
  props: GeopfProps,
  featureId: string | number | undefined,
): MatchedZone | null {
  const limite = String(props.limite ?? "").trim();
  const remarque = String(props.remarque ?? "").trim();
  const identifier = String(
    featureId ?? (limite || remarque || ""),
  ).trim();
  if (!identifier) return null;

  const heightM = parseHeightLimitM(limite);
  const restriction = restrictionForLimite(limite);
  const name =
    limite.replace(/\s*\*\s*$/, "").trim() ||
    remarque.slice(0, 80) ||
    "Zone UAS France";

  return {
    identifier,
    name,
    restriction,
    reason: [
      ...(limite ? [limite] : []),
      ...(restriction === "PROHIBITED" ? ["PROHIBITED"] : []),
    ],
    source: "geopf",
    country: "FR",
    lowerLimitM: 0,
    upperLimitM: heightM != null && heightM > 0 ? heightM : 120,
    lowerRef: "AGL",
    upperRef: "AGL",
    message: remarque || limite || undefined,
  };
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
  west: number,
  south: number,
  east: number,
  north: number,
  count: number,
): string {
  const params = new URLSearchParams({
    SERVICE: "WFS",
    VERSION: "2.0.0",
    REQUEST: "GetFeature",
    TYPENAMES: TYPE_NAME,
    SRSNAME: "EPSG:4326",
    BBOX: `${west},${south},${east},${north},EPSG:4326`,
    COUNT: String(count),
    OUTPUTFORMAT: "application/json",
  });
  return `${GEOPF_WFS}?${params}`;
}

/** Live point query — tiny envelope around the pin. */
export async function queryGeopfPoint(
  lat: number,
  lng: number,
): Promise<MatchedZone[]> {
  const pad = 0.0004;
  const url = buildBboxUrl(lng - pad, lat - pad, lng + pad, lat + pad, 40);
  const matches: MatchedZone[] = [];
  const seen = new Set<string>();

  try {
    const fc = await fetchGeoJson(url, 6_000);
    for (const feature of fc.features ?? []) {
      const zone = propsToMatchedZone(
        (feature.properties ?? {}) as GeopfProps,
        feature.id,
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
      (err instanceof GeopfFetchError && isTimeout(err.cause))
    ) {
      console.warn("[geopf] point timeout");
    } else {
      console.warn("[geopf] point failed", err);
    }
  }

  return matches;
}

async function fetchNationalMapFeatures(): Promise<GeoJSON.Feature[]> {
  const url = buildBboxUrl(
    FR_NATIONAL_BBOX.west,
    FR_NATIONAL_BBOX.south,
    FR_NATIONAL_BBOX.east,
    FR_NATIONAL_BBOX.north,
    NATIONAL_FEATURE_COUNT,
  );
  const fc = await fetchGeoJson(url, 30_000);
  const out: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const feature of fc.features ?? []) {
    const zone = propsToMatchedZone(
      (feature.properties ?? {}) as GeopfProps,
      feature.id,
    );
    if (!zone || !feature.geometry) continue;
    const key = `${zone.identifier}:${zone.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
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
        country: "FR",
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
}

async function fetchViewportMapFeatures(
  clamped: { west: number; south: number; east: number; north: number },
  limit: number,
): Promise<GeoJSON.Feature[]> {
  const url = buildBboxUrl(
    clamped.west,
    clamped.south,
    clamped.east,
    clamped.north,
    limit,
  );
  const fc = await fetchGeoJson(url, 8_000);
  const out: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const feature of fc.features ?? []) {
    const zone = propsToMatchedZone(
      (feature.properties ?? {}) as GeopfProps,
      feature.id,
    );
    if (!zone || !feature.geometry) continue;
    const key = `${zone.identifier}:${zone.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
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
        country: "FR",
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
}

/** Map bbox — national cache when warm, else live viewport cache. Point stays live WFS. */
export async function queryGeopfBbox(
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

  try {
    if (nationalMapCache.isWarm()) {
      const national = await nationalMapCache.get(fetchNationalMapFeatures);
      const fromNational = filterFeaturesByBbox(
        national,
        clamped.west,
        clamped.south,
        clamped.east,
        clamped.north,
        limit,
      );
      if (fromNational.length > 0) {
        return { type: "FeatureCollection", features: fromNational };
      }
    }
  } catch (err) {
    console.warn("[geopf] national map cache unavailable", err);
  }

  try {
    const features = await viewportBboxCache.get(
      "geopf",
      clamped.west,
      clamped.south,
      clamped.east,
      clamped.north,
      () => fetchViewportMapFeatures(clamped, limit),
    );
    void nationalMapCache.get(fetchNationalMapFeatures).catch(() => undefined);
    return { type: "FeatureCollection", features: features.slice(0, limit) };
  } catch (err) {
    if (
      isTimeout(err) ||
      (err instanceof GeopfFetchError && isTimeout(err.cause))
    ) {
      console.warn("[geopf] bbox timeout");
    } else {
      console.warn("[geopf] bbox failed", err);
    }
    return { type: "FeatureCollection", features: [] };
  }
}
