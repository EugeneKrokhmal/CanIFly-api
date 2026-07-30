/**
 * Swiss UAS geographical zones via FOCA open data on geo.admin.ch
 * (ch.bazl.einschraenkungen-drohnen — ED-269 / SwissUASGeozones JSON).
 * Full national file is cached and filtered for point / bbox queries.
 */
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";
import {
  toMeters,
  zoneVisualStatus,
  type MatchedZone,
  type UasRestriction,
  type UasZoneFeature,
  type UasZoneGeometry,
  type UasZonesFile,
} from "@canifly/middleware";
import {
  ensureHeapForHeavyCache,
  registerGeoCacheClearer,
} from "./memory-guard";

const FOCA_GEOJSON_4326 =
  "https://data.geo.admin.ch/ch.bazl.einschraenkungen-drohnen/einschraenkungen-drohnen/einschraenkungen-drohnen_4326.json";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MAP_BBOX_DEG = 3.5;
const CLAMP_MAP_BBOX_DEG = 2.0;

export class FocaFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FocaFetchError";
  }
}

type CacheEntry = {
  fetchedAt: number;
  zones: UasZoneFeature[];
};

let cache: CacheEntry | null = null;
let inflight: Promise<UasZoneFeature[]> | null = null;

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

function asZoneFeature(raw: unknown): UasZoneFeature | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const identifier = String(f.identifier ?? "").trim();
  if (!identifier) return null;
  const geometry = Array.isArray(f.geometry) ? (f.geometry as UasZoneGeometry[]) : [];
  if (geometry.length === 0) return null;
  const reasonRaw = f.reason;
  const reason = Array.isArray(reasonRaw)
    ? reasonRaw.map(String)
    : reasonRaw
      ? [String(reasonRaw)]
      : [];
  return {
    identifier,
    country: String(f.country ?? "CHE"),
    name: String(f.name ?? identifier),
    type: String(f.type ?? "COMMON"),
    restriction: String(f.restriction ?? "REQ_AUTHORISATION") as UasRestriction,
    reason,
    otherReasonInfo: f.otherReasonInfo ? String(f.otherReasonInfo) : undefined,
    message: f.message ? String(f.message) : undefined,
    applicability: Array.isArray(f.applicability)
      ? (f.applicability as UasZoneFeature["applicability"])
      : undefined,
    zoneAuthority: Array.isArray(f.zoneAuthority)
      ? (f.zoneAuthority as UasZoneFeature["zoneAuthority"])
      : undefined,
    geometry,
  };
}

function isZoneActive(zone: UasZoneFeature, now = new Date()): boolean {
  const apps = zone.applicability;
  if (!apps || apps.length === 0) return true;
  // Active if any applicability window covers now, or is permanent / open-ended.
  return apps.some((app) => {
    const permanent = String(app.permanent ?? "").toUpperCase();
    if (permanent === "YES" || permanent === "TRUE") return true;
    const start = app.startDateTime ? new Date(app.startDateTime) : null;
    const end = app.endDateTime ? new Date(app.endDateTime) : null;
    if (start && Number.isFinite(start.getTime()) && now < start) return false;
    if (end && Number.isFinite(end.getTime()) && now > end) return false;
    // Timed window with only future start already rejected; empty dates → keep.
    return true;
  });
}

async function fetchNationalZones(): Promise<UasZoneFeature[]> {
  try {
    const response = await fetch(FOCA_GEOJSON_4326, {
      headers: { Accept: "application/json", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new FocaFetchError(`HTTP ${response.status}`, FOCA_GEOJSON_4326, response.status);
    }
    const data = (await response.json()) as UasZonesFile;
    if (!data || !Array.isArray(data.features)) return [];
    return data.features.map(asZoneFeature).filter((z): z is UasZoneFeature => z != null);
  } catch (err) {
    if (isTimeout(err)) {
      throw new FocaFetchError("foca timeout", FOCA_GEOJSON_4326, undefined, err);
    }
    throw err instanceof FocaFetchError
      ? err
      : new FocaFetchError(String(err), FOCA_GEOJSON_4326, undefined, err);
  }
}

async function getZones(): Promise<UasZoneFeature[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.zones;
  }
  const stale = cache;
  if (!ensureHeapForHeavyCache("foca:CH")) {
    if (stale) {
      cache = stale;
      return stale.zones;
    }
    throw new FocaFetchError(
      "heap limit — cannot load FOCA national zones",
      FOCA_GEOJSON_4326,
    );
  }
  if (!inflight) {
    inflight = fetchNationalZones()
      .then((zones) => {
        cache = { fetchedAt: Date.now(), zones };
        return zones;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function volumeBbox(
  geom: UasZoneGeometry["horizontalProjection"],
): [number, number, number, number] | null {
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
  walk(geom.coordinates);
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function pointInVolume(lat: number, lng: number, vol: UasZoneGeometry): boolean {
  const proj = vol.horizontalProjection;
  if (!proj || (proj.type !== "Polygon" && proj.type !== "MultiPolygon")) {
    return false;
  }
  try {
    return booleanPointInPolygon(
      turfPoint([lng, lat]),
      { type: "Feature", properties: {}, geometry: proj },
    );
  } catch {
    return false;
  }
}

function bboxIntersectsVolume(
  west: number,
  south: number,
  east: number,
  north: number,
  vol: UasZoneGeometry,
): boolean {
  const b = volumeBbox(vol.horizontalProjection);
  if (!b) return false;
  const [minX, minY, maxX, maxY] = b;
  return !(maxX < west || minX > east || maxY < south || minY > north);
}

function conditionsText(zone: UasZoneFeature): string {
  const raw = (zone as UasZoneFeature & { restrictionConditions?: unknown })
    .restrictionConditions;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean).join(" — ");
  if (typeof raw === "string") return raw;
  return "";
}

function zoneToMatched(zone: UasZoneFeature, vol: UasZoneGeometry): MatchedZone {
  const uom = vol.uomDimensions ?? "M";
  const lower = toMeters(Number(vol.lowerLimit) || 0, uom);
  const upperRaw = Number(vol.upperLimit);
  const upper =
    Number.isFinite(upperRaw) && upperRaw > 0
      ? toMeters(upperRaw, uom)
      : 120;
  const auth = zone.zoneAuthority?.[0];
  const contact = auth?.email || auth?.phone || undefined;
  const message = [zone.message, conditionsText(zone), zone.otherReasonInfo]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join(" — ");

  return {
    identifier: zone.identifier,
    name: zone.name,
    restriction: zone.restriction,
    reason: zone.reason ?? [],
    source: "foca",
    country: "CH",
    lowerLimitM: lower,
    upperLimitM: upper,
    lowerRef: vol.lowerVerticalReference ?? "AGL",
    upperRef: vol.upperVerticalReference ?? "AGL",
    contact: contact ? String(contact) : undefined,
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

function featureForMap(zone: MatchedZone, vol: UasZoneGeometry): GeoJSON.Feature | null {
  const geom = vol.horizontalProjection;
  if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) {
    return null;
  }
  return {
    type: "Feature",
    id: zone.identifier,
    geometry: geom,
    properties: {
      ...zone,
      mapStatus: zoneVisualStatus(zone),
      identifier: zone.identifier,
      name: zone.name,
      restriction: zone.restriction,
      source: zone.source,
      country: "CH",
    },
  };
}

export async function queryFocaPoint(
  lat: number,
  lng: number,
): Promise<MatchedZone[]> {
  const zones = await getZones();
  const out: MatchedZone[] = [];
  const seen = new Set<string>();
  for (const zone of zones) {
    if (!isZoneActive(zone)) continue;
    for (const vol of zone.geometry) {
      if (!pointInVolume(lat, lng, vol)) continue;
      const matched = zoneToMatched(zone, vol);
      if (seen.has(matched.identifier)) continue;
      seen.add(matched.identifier);
      out.push(matched);
      break;
    }
  }
  return out;
}

export async function queryFocaBbox(
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
  const zones = await getZones();
  const out: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const zone of zones) {
    if (!isZoneActive(zone)) continue;
    for (const vol of zone.geometry) {
      if (
        !bboxIntersectsVolume(
          clamped.west,
          clamped.south,
          clamped.east,
          clamped.north,
          vol,
        )
      ) {
        continue;
      }
      if (seen.has(zone.identifier)) break;
      const matched = zoneToMatched(zone, vol);
      const mapped = featureForMap(matched, vol);
      if (!mapped) continue;
      seen.add(zone.identifier);
      out.push(mapped);
      break;
    }
    if (out.length >= limit) break;
  }
  return { type: "FeatureCollection", features: out };
}
