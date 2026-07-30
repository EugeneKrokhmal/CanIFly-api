/**
 * Danish UAS zones via Trafikstyrelsen Dronezoner open GeoJSON
 * (https://dronezoner.eu/API/). Full national file is cached in memory and
 * filtered for point / bbox queries — same live-planning role as dipul/geopf.
 *
 * Farve codes in the dataset: 1 = Rød (flyvesikring), 5 = Orange (opmærksomhed),
 * 4 = Blå (sikring). Point features carry Bufferzone / Buffer_Zone radii.
 */
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";
import {
  zoneVisualStatus,
  type MatchedZone,
  type UasRestriction,
} from "@canifly/middleware";
import {
  ensureHeapForHeavyCache,
  registerGeoCacheClearer,
} from "./memory-guard";

const DRONEZONER_GEOJSON =
  "https://trafikstyrelsen.maps.arcgis.com/sharing/rest/content/items/980697acd04d4a9bb1fd34bbefab924a/data";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MAP_BBOX_DEG = 3.5;
const CLAMP_MAP_BBOX_DEG = 2.0;

export class DronezonerFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DronezonerFetchError";
  }
}

interface DronezonerProps {
  OBJECTID?: number | string | null;
  title?: string | null;
  Farve?: string | number | null;
  Type?: string | number | null;
  typeId?: string | null;
  Bufferzone?: string | number | null;
  Buffer_Zone?: string | number | null;
  Elevation_meter?: string | number | null;
  MaxFlyveHoejde?: string | number | null;
  Lovkrav?: string | null;
  Kommentar?: string | null;
  InfoTekst?: string | null;
  kontaktMail?: string | null;
  ICAO?: string | null;
  [key: string]: unknown;
}

type CacheEntry = {
  fetchedAt: number;
  features: GeoJSON.Feature[];
};

let cache: CacheEntry | null = null;
let inflight: Promise<GeoJSON.Feature[]> | null = null;

registerGeoCacheClearer(() => {
  cache = null;
  inflight = null;
});

function isTimeout(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "TimeoutError") ||
    (err instanceof Error && /aborted due to timeout|TimeoutError/i.test(err.message))
  );
}

async function fetchNationalGeoJson(): Promise<GeoJSON.Feature[]> {
  try {
    const response = await fetch(DRONEZONER_GEOJSON, {
      headers: { Accept: "application/json", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      throw new DronezonerFetchError(
        `HTTP ${response.status}`,
        DRONEZONER_GEOJSON,
        response.status,
      );
    }
    const data = (await response.json()) as GeoJSON.FeatureCollection;
    if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      return [];
    }
    return data.features;
  } catch (err) {
    if (isTimeout(err)) {
      throw new DronezonerFetchError("dronezoner timeout", DRONEZONER_GEOJSON, undefined, err);
    }
    throw err instanceof DronezonerFetchError
      ? err
      : new DronezonerFetchError(String(err), DRONEZONER_GEOJSON, undefined, err);
  }
}

async function getFeatures(): Promise<GeoJSON.Feature[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.features;
  }
  const stale = cache;
  if (!ensureHeapForHeavyCache("dronezoner:DK")) {
    if (stale) {
      cache = stale;
      return stale.features;
    }
    throw new DronezonerFetchError(
      "heap limit — cannot load Dronezoner national GeoJSON",
      DRONEZONER_GEOJSON,
    );
  }
  if (!inflight) {
    inflight = fetchNationalGeoJson()
      .then((features) => {
        cache = { fetchedAt: Date.now(), features };
        return features;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Parse "150", "150 m", "3 km", "1 km" → metres. */
export function parseBufferMeters(raw: unknown): number {
  if (raw == null) return 0;
  const s = String(raw).trim().toLowerCase().replace(",", ".");
  if (!s || s === "none" || s === "null") return 0;
  const m = s.match(/([\d.]+)\s*(km|m|meter|metre|metres|meters)?/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = m[2] ?? "";
  if (unit.startsWith("km")) return n * 1000;
  // Bare small integers next to airfield names are often km (3, 1, 2, 5).
  if (!unit && n > 0 && n <= 10 && Number.isInteger(n)) return n * 1000;
  return n;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function featureBbox(geom: GeoJSON.Geometry): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (c: unknown): void => {
    if (!Array.isArray(c) || c.length === 0) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      minX = Math.min(minX, c[0]);
      maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]);
      maxY = Math.max(maxY, c[1]);
      return;
    }
    for (const item of c) walk(item);
  };
  if (geom.type === "GeometryCollection") {
    for (const g of geom.geometries) {
      const b = featureBbox(g);
      if (!b) continue;
      minX = Math.min(minX, b[0]);
      minY = Math.min(minY, b[1]);
      maxX = Math.max(maxX, b[2]);
      maxY = Math.max(maxY, b[3]);
    }
  } else {
    walk((geom as GeoJSON.Geometry & { coordinates: unknown }).coordinates);
  }
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function pointHitsFeature(
  lat: number,
  lng: number,
  feature: GeoJSON.Feature,
): boolean {
  const geom = feature.geometry;
  if (!geom) return false;
  const props = (feature.properties ?? {}) as DronezonerProps;
  const bufferM = parseBufferMeters(props.Bufferzone ?? props.Buffer_Zone);

  if (geom.type === "Point") {
    const [x, y] = geom.coordinates;
    const dist = haversineM(lat, lng, y, x);
    const radius = bufferM > 0 ? bufferM : 150;
    return dist <= radius;
  }

  if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
    try {
      return booleanPointInPolygon(
        turfPoint([lng, lat]),
        feature as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
      );
    } catch {
      return false;
    }
  }
  return false;
}

function bboxIntersectsFeature(
  west: number,
  south: number,
  east: number,
  north: number,
  feature: GeoJSON.Feature,
): boolean {
  const geom = feature.geometry;
  if (!geom) return false;
  const props = (feature.properties ?? {}) as DronezonerProps;
  const bufferM = parseBufferMeters(props.Bufferzone ?? props.Buffer_Zone);
  const padDeg = (bufferM > 0 ? bufferM : geom.type === "Point" ? 150 : 0) / 111_320;

  if (geom.type === "Point") {
    const [x, y] = geom.coordinates;
    return (
      x >= west - padDeg &&
      x <= east + padDeg &&
      y >= south - padDeg &&
      y <= north + padDeg
    );
  }

  const b = featureBbox(geom);
  if (!b) return false;
  const [minX, minY, maxX, maxY] = b;
  return !(
    maxX < west - padDeg ||
    minX > east + padDeg ||
    maxY < south - padDeg ||
    minY > north + padDeg
  );
}

function restrictionForFarve(farve: string): UasRestriction {
  if (farve === "1") return "PROHIBITED"; // Rød
  if (farve === "5") return "CONDITIONAL"; // Orange
  if (farve === "4") return "REQ_AUTHORISATION"; // Blå
  return "REQ_AUTHORISATION";
}

function propsToMatchedZone(
  props: DronezonerProps,
  featureId: string | number | undefined,
): MatchedZone | null {
  const farve = String(props.Farve ?? "").trim();
  const typeId = String(props.typeId ?? props.Type ?? "").trim();
  const title = String(props.title ?? "").trim();
  const identifier = String(
    props.OBJECTID ?? featureId ?? (title || typeId || ""),
  ).trim();
  if (!identifier) return null;

  const restriction = restrictionForFarve(farve);
  const elev = Number(props.Elevation_meter);
  const maxH = Number(props.MaxFlyveHoejde);
  const upper =
    Number.isFinite(maxH) && maxH > 0
      ? maxH
      : Number.isFinite(elev) && elev > 0
        ? elev
        : 120;

  const reasons = [
    farve ? `FARVE:${farve}` : "",
    typeId,
    farve === "1" ? "RØD" : farve === "5" ? "ORANGE" : farve === "4" ? "BLÅ" : "",
  ].filter(Boolean);

  const message = [
    props.Lovkrav,
    props.Kommentar,
    props.InfoTekst,
  ]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join(" — ");

  return {
    identifier: `DK-${identifier}`,
    name: title || typeId || "Dronezone Danmark",
    restriction,
    reason: reasons,
    source: "dronezoner",
    country: "DK",
    lowerLimitM: 0,
    upperLimitM: upper,
    lowerRef: "AGL",
    upperRef: "AGL",
    contact: props.kontaktMail ? String(props.kontaktMail) : undefined,
    message: message || undefined,
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

function circlePolygon(
  lng: number,
  lat: number,
  radiusM: number,
  steps = 32,
): GeoJSON.Polygon {
  const coords: [number, number][] = [];
  const latRad = (lat * Math.PI) / 180;
  const metersPerDegLat = 111_320;
  const metersPerDegLng = Math.max(1e-6, 111_320 * Math.cos(latRad));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([
      lng + (radiusM * Math.cos(a)) / metersPerDegLng,
      lat + (radiusM * Math.sin(a)) / metersPerDegLat,
    ]);
  }
  return { type: "Polygon", coordinates: [coords] };
}

function featureForMap(feature: GeoJSON.Feature, zone: MatchedZone): GeoJSON.Feature | null {
  const geom = feature.geometry;
  if (!geom) return null;
  const props = (feature.properties ?? {}) as DronezonerProps;
  let mapGeom: GeoJSON.Geometry = geom;
  if (geom.type === "Point") {
    const [x, y] = geom.coordinates;
    const bufferM = parseBufferMeters(props.Bufferzone ?? props.Buffer_Zone) || 150;
    mapGeom = circlePolygon(x, y, bufferM);
  }
  return {
    type: "Feature",
    id: zone.identifier,
    geometry: mapGeom,
    properties: {
      ...zone,
      mapStatus: zoneVisualStatus(zone),
      identifier: zone.identifier,
      name: zone.name,
      restriction: zone.restriction,
      source: zone.source,
      country: "DK",
    },
  };
}

export async function queryDronezonerPoint(
  lat: number,
  lng: number,
): Promise<MatchedZone[]> {
  const features = await getFeatures();
  const out: MatchedZone[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (!pointHitsFeature(lat, lng, feature)) continue;
    const zone = propsToMatchedZone(
      (feature.properties ?? {}) as DronezonerProps,
      feature.id,
    );
    if (!zone) continue;
    const dedupe = `${zone.name}|${zone.restriction}|${zone.reason.join(",")}`;
    if (seen.has(dedupe) || seen.has(zone.identifier)) continue;
    seen.add(dedupe);
    seen.add(zone.identifier);
    out.push(zone);
  }
  return out;
}

export async function queryDronezonerBbox(
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
  const features = await getFeatures();
  const out: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (
      !bboxIntersectsFeature(
        clamped.west,
        clamped.south,
        clamped.east,
        clamped.north,
        feature,
      )
    ) {
      continue;
    }
    const zone = propsToMatchedZone(
      (feature.properties ?? {}) as DronezonerProps,
      feature.id,
    );
    if (!zone || seen.has(zone.identifier)) continue;
    seen.add(zone.identifier);
    const mapped = featureForMap(feature, zone);
    if (mapped) out.push(mapped);
    if (out.length >= limit) break;
  }
  return { type: "FeatureCollection", features: out };
}
