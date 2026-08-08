/**
 * Shared in-memory ED-269 / ED-318 national zone cache + point/bbox queries.
 * Used by FOCA-style publishers (ANAC PT, Austro Control AT, etc.).
 */
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";
import { inflateRawSync } from "node:zlib";
import {
  toMeters,
  zoneVisualStatus,
  type CountryId,
  type MatchedZone,
  type UasRestriction,
  type UasZoneFeature,
  type UasZoneGeometry,
  type ZoneSource,
} from "@canifly/middleware";
import {
  ensureHeapForHeavyCache,
  registerGeoCacheClearer,
} from "./memory-guard";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MAP_BBOX_DEG = 3.5;
const CLAMP_MAP_BBOX_DEG = 2.0;
/** Small national GeoJSON sets (EE/LT/SK/SI/…) — allow full-country viewport without clamp. */
const SMALL_NATIONAL_ZONE_CAP = 800;
const SMALL_NATIONAL_MAX_SPAN_DEG = 12;

export function isTimeout(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "TimeoutError") ||
    (err instanceof Error && /aborted due to timeout|TimeoutError/i.test(err.message))
  );
}

export function asZoneFeature(
  raw: unknown,
  fallbackCountry: string,
): UasZoneFeature | null {
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
    country: String(f.country ?? fallbackCountry),
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

/** Accept FeatureCollection `{ features: [...] }` or a bare zone array. */
export function parseEd269Payload(
  data: unknown,
  fallbackCountry: string,
): UasZoneFeature[] {
  const list = Array.isArray(data)
    ? data
    : data &&
        typeof data === "object" &&
        Array.isArray((data as { features?: unknown }).features)
      ? ((data as { features: unknown[] }).features)
      : [];
  return list
    .map((z) => asZoneFeature(z, fallbackCountry))
    .filter((z): z is UasZoneFeature => z != null);
}

export function isZoneActive(zone: UasZoneFeature, now = new Date()): boolean {
  const apps = zone.applicability;
  if (!apps || apps.length === 0) return true;
  return apps.some((app) => {
    const permanent = String(app.permanent ?? "").toUpperCase();
    if (permanent === "YES" || permanent === "TRUE") return true;
    const start = app.startDateTime ? new Date(app.startDateTime) : null;
    const end = app.endDateTime ? new Date(app.endDateTime) : null;
    if (start && Number.isFinite(start.getTime()) && now < start) return false;
    if (end && Number.isFinite(end.getTime()) && now > end) return false;
    return true;
  });
}

/** Extract the first `.json` entry from a (store/deflate) ZIP buffer. */
export function unzipFirstJson(buf: Buffer): string {
  return unzipFirstMatching(buf, /\.json$/i);
}

/**
 * Locate the start of the ZIP central directory via the End of Central
 * Directory record. Prefer this over walking local headers: many publishers
 * (NSAT, CAA SI) set bit 3 / data descriptors so local compressed sizes are 0.
 */
function zipCentralDirectoryOffset(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65_536 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    return buf.readUInt32LE(i + 16);
  }
  throw new Error("zip EOCD not found");
}

type ZipEntry = {
  name: string;
  method: number;
  compSize: number;
  localHeaderOffset: number;
};

function* zipCentralEntries(buf: Buffer): Generator<ZipEntry> {
  let offset = zipCentralDirectoryOffset(buf);
  while (offset + 46 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf
      .subarray(offset + 46, offset + 46 + nameLen)
      .toString("utf8");
    yield { name, method, compSize, localHeaderOffset };
    offset += 46 + nameLen + extraLen + commentLen;
  }
}

function zipEntryPayload(buf: Buffer, entry: ZipEntry): Buffer {
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
    throw new Error(`invalid local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compSize;
  if (dataEnd > buf.length) {
    throw new Error(`truncated zip entry ${entry.name}`);
  }
  const payload = buf.subarray(dataStart, dataEnd);
  if (entry.method === 0) return Buffer.from(payload);
  if (entry.method === 8) return inflateRawSync(payload);
  throw new Error(`unsupported zip method ${entry.method} for ${entry.name}`);
}

/** Extract the first entry whose name matches `pattern` from a ZIP buffer. */
export function unzipFirstMatching(buf: Buffer, pattern: RegExp): string {
  for (const entry of zipCentralEntries(buf)) {
    if (!pattern.test(entry.name) || entry.name.includes("__MACOSX")) continue;
    return zipEntryPayload(buf, entry).toString("utf8");
  }
  throw new Error(`no zip entry matching ${pattern}`);
}

/** Extract first `.kml` from a ZIP or nested KMZ (zip-in-zip). */
export function unzipFirstKml(buf: Buffer): string {
  try {
    return unzipFirstMatching(buf, /\.kml$/i);
  } catch {
    // Outer zip may wrap a .kmz (itself a zip).
    const kmz = unzipFirstMatchingBinary(buf, /\.kmz$/i);
    return unzipFirstMatching(kmz, /\.kml$/i);
  }
}

function unzipFirstMatchingBinary(buf: Buffer, pattern: RegExp): Buffer {
  for (const entry of zipCentralEntries(buf)) {
    if (!pattern.test(entry.name) || entry.name.includes("__MACOSX")) continue;
    return zipEntryPayload(buf, entry);
  }
  throw new Error(`no zip entry matching ${pattern}`);
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

export type Ed269NationalClient = {
  queryPoint(lat: number, lng: number): Promise<MatchedZone[]>;
  queryBbox(
    west: number,
    south: number,
    east: number,
    north: number,
    limit?: number,
  ): Promise<GeoJSON.FeatureCollection>;
};

export function createEd269NationalClient(opts: {
  source: ZoneSource;
  country: CountryId;
  fetchZones: () => Promise<UasZoneFeature[]>;
}): Ed269NationalClient {
  let cache: { fetchedAt: number; zones: UasZoneFeature[] } | null = null;
  let inflight: Promise<UasZoneFeature[]> | null = null;

  registerGeoCacheClearer(() => {
    cache = null;
    inflight = null;
  });

  async function getZones(): Promise<UasZoneFeature[]> {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.zones;
    const stale = cache;
    if (!ensureHeapForHeavyCache(`${opts.source}:${opts.country}`)) {
      if (stale) {
        cache = stale;
        return stale.zones;
      }
      throw new Error(
        `heap limit — cannot load ${opts.country} national zones`,
      );
    }
    if (!inflight) {
      inflight = opts
        .fetchZones()
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

  function zoneToMatched(zone: UasZoneFeature, vol: UasZoneGeometry): MatchedZone {
    const uom = vol.uomDimensions ?? "M";
    const lower = toMeters(Number(vol.lowerLimit) || 0, uom);
    const upperRaw = Number(vol.upperLimit);
    const upper =
      Number.isFinite(upperRaw) && upperRaw > 0 ? toMeters(upperRaw, uom) : 120;
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
      source: opts.source,
      country: opts.country,
      lowerLimitM: lower,
      upperLimitM: upper,
      lowerRef: vol.lowerVerticalReference ?? "AGL",
      upperRef: vol.upperVerticalReference ?? "AGL",
      contact: contact ? String(contact) : undefined,
      message: message || undefined,
    };
  }

  function featureForMap(
    zone: MatchedZone,
    vol: UasZoneGeometry,
  ): GeoJSON.Feature | null {
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
        country: opts.country,
      },
    };
  }

  return {
    async queryPoint(lat, lng) {
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
    },
    async queryBbox(west, south, east, north, limit = 500) {
      const zones = await getZones();
      const spanLng = east - west;
      const spanLat = north - south;
      if (spanLng <= 0 || spanLat <= 0) {
        return { type: "FeatureCollection", features: [] };
      }

      // Compact national feeds: keep the full viewport so country zoom shows all
      // geozones (EE/LT were truncated to a 2° clamp and looked nearly empty).
      let box: { west: number; south: number; east: number; north: number } | null;
      if (
        zones.length <= SMALL_NATIONAL_ZONE_CAP &&
        spanLng <= SMALL_NATIONAL_MAX_SPAN_DEG &&
        spanLat <= SMALL_NATIONAL_MAX_SPAN_DEG
      ) {
        box = { west, south, east, north };
      } else {
        box = clampMapBbox(west, south, east, north);
      }
      if (!box) return { type: "FeatureCollection", features: [] };

      const out: GeoJSON.Feature[] = [];
      const seen = new Set<string>();
      for (const zone of zones) {
        if (!isZoneActive(zone)) continue;
        for (const vol of zone.geometry) {
          if (
            !bboxIntersectsVolume(
              box.west,
              box.south,
              box.east,
              box.north,
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
    },
  };
}
