/**
 * Convert UTM AVM-style FeatureCollections (Estonia EANS / Lithuania ANS)
 * into ED-269 UasZoneFeature[]. Properties already embed volumes + restriction.
 *
 * Publishers include a catch-all “Outside <country>” PROHIBITED polygon that
 * covers the whole globe (for their national UTM map). Those must be dropped —
 * otherwise CanIFly’s merged map cache paints every country red after a visit.
 */
import type {
  UasRestriction,
  UasZoneFeature,
  UasZoneGeometry,
} from "@canifly/middleware";

/** Span above this (degrees) is treated as a non-operational world mask. */
const MAX_OPERATIONAL_SPAN_DEG = 40;

function normalizeRestriction(raw: unknown): UasRestriction {
  const s = String(raw ?? "REQ_AUTHORISATION")
    .trim()
    .toUpperCase()
    .replace(/REQ_AUTHORIZATION/g, "REQ_AUTHORISATION");
  if (s === "PROHIBITED") return "PROHIBITED";
  if (s === "CONDITIONAL") return "CONDITIONAL";
  if (s === "NO_RESTRICTION") return "NO_RESTRICTION";
  if (s === "USPACE") return "USPACE";
  return "REQ_AUTHORISATION";
}

function projectionSpanDeg(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): { width: number; height: number } | null {
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
    for (const child of c) walk(child);
  };
  walk(geom.coordinates);
  if (!Number.isFinite(minX)) return null;
  return { width: maxX - minX, height: maxY - minY };
}

/** National UTM “rest of world is prohibited” masks — not real local geozones. */
export function isUtmAvmWorldMaskZone(
  identifier: string,
  name: string,
  volumes: UasZoneGeometry[],
): boolean {
  const blob = `${identifier} ${name}`.toLowerCase();
  // National UTM maps ship “Outside Lithuania/Estonia” world masks.
  if (blob.includes("outside")) return true;
  for (const vol of volumes) {
    const span = projectionSpanDeg(vol.horizontalProjection);
    if (
      span &&
      (span.width >= MAX_OPERATIONAL_SPAN_DEG ||
        span.height >= MAX_OPERATIONAL_SPAN_DEG)
    ) {
      return true;
    }
  }
  return false;
}

function asVolume(
  nested: unknown,
  fallbackGeom: GeoJSON.Polygon | GeoJSON.MultiPolygon | null,
): UasZoneGeometry | null {
  const n =
    nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)
      : null;
  const projRaw = n?.horizontalProjection;
  let proj: GeoJSON.Polygon | GeoJSON.MultiPolygon | null = null;
  if (
    projRaw &&
    typeof projRaw === "object" &&
    ((projRaw as GeoJSON.Geometry).type === "Polygon" ||
      (projRaw as GeoJSON.Geometry).type === "MultiPolygon")
  ) {
    proj = projRaw as GeoJSON.Polygon | GeoJSON.MultiPolygon;
  } else if (fallbackGeom) {
    proj = fallbackGeom;
  }
  if (!proj) return null;
  const lower = Number(n?.lowerLimit ?? 0);
  const upper = Number(n?.upperLimit ?? 120);
  return {
    lowerLimit: Number.isFinite(lower) ? lower : 0,
    upperLimit: Number.isFinite(upper) ? upper : 120,
    uomDimensions: String(n?.uomDimensions ?? "M") as UasZoneGeometry["uomDimensions"],
    lowerVerticalReference: String(
      n?.lowerVerticalReference ?? "AGL",
    ) as UasZoneGeometry["lowerVerticalReference"],
    upperVerticalReference: String(
      n?.upperVerticalReference ?? "AGL",
    ) as UasZoneGeometry["upperVerticalReference"],
    horizontalProjection: proj,
  };
}

export function utmAvmFeatureToZone(
  raw: unknown,
  fallbackCountry: string,
): UasZoneFeature | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as GeoJSON.Feature;
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const identifier = String(props.identifier ?? props.zoneId ?? "").trim();
  if (!identifier) return null;

  const featureGeom =
    f.geometry &&
    (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
      ? f.geometry
      : null;

  const nested = props.geometry;
  const volumes: UasZoneGeometry[] = [];
  if (Array.isArray(nested)) {
    for (const item of nested) {
      const vol = asVolume(item, featureGeom);
      if (vol) volumes.push(vol);
    }
  } else {
    const vol = asVolume(nested, featureGeom);
    if (vol) volumes.push(vol);
  }
  if (volumes.length === 0 && featureGeom) {
    const lower = Number(props.lowerMeters ?? 0);
    const upper = Number(props.upperMeters ?? 120);
    volumes.push({
      lowerLimit: Number.isFinite(lower) ? lower : 0,
      upperLimit: Number.isFinite(upper) ? upper : 120,
      uomDimensions: "M",
      lowerVerticalReference: "AGL",
      upperVerticalReference: "AGL",
      horizontalProjection: featureGeom,
    });
  }
  if (volumes.length === 0) return null;

  const name = String(props.name ?? identifier);
  if (isUtmAvmWorldMaskZone(identifier, name, volumes)) return null;

  const reasonRaw = props.reason;
  const reason = Array.isArray(reasonRaw)
    ? reasonRaw.map(String)
    : reasonRaw
      ? [String(reasonRaw)]
      : [];

  return {
    identifier,
    country: String(props.country ?? fallbackCountry),
    name,
    type: String(props.type ?? "COMMON"),
    restriction: normalizeRestriction(props.restriction),
    reason,
    otherReasonInfo: props.otherReasonInfo
      ? String(props.otherReasonInfo)
      : undefined,
    message: props.message ? String(props.message) : undefined,
    applicability: Array.isArray(props.applicability)
      ? (props.applicability as UasZoneFeature["applicability"])
      : undefined,
    zoneAuthority: Array.isArray(props.zoneAuthority)
      ? (props.zoneAuthority as UasZoneFeature["zoneAuthority"])
      : undefined,
    geometry: volumes,
  };
}

export function parseUtmAvmGeoJson(
  data: unknown,
  fallbackCountry: string,
): UasZoneFeature[] {
  if (!data || typeof data !== "object") return [];
  const fc = data as GeoJSON.FeatureCollection;
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
    return [];
  }
  return fc.features
    .map((f) => utmAvmFeatureToZone(f, fallbackCountry))
    .filter((z): z is UasZoneFeature => z != null);
}
