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
  toMeters,
  zoneVisualStatus,
  type MatchedZone,
  type UasRestriction,
} from "@canifly/middleware";
import { ViewportLayerCache } from "./geojson-bbox-cache";

const DIPUL_WFS = "https://uas-betrieb.de/geoservices/dipul/wfs";

/** Skip continent-scale paint queries (°). */
const MAX_MAP_BBOX_DEG = 3.5;
const CLAMP_MAP_BBOX_DEG = 2.0;

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

const viewportLayerCache = new ViewportLayerCache();

/** Open-category hard no-fly / consent-required facility types (§ 21h Abs. 3). */
const PROHIBITED_TYPES = new Set([
  "FLUGHAFEN", // Nr. 2 — open category not permitted (specific only)
  "FLUGPLATZ", // Nr. 1 — needs operator consent; treat as no-fly without it
  "FLUGBESCHRAENKUNGSGEBIET", // ED-R (§ 17 LuftVO)
  "MILITAERISCHE_ANLAGE", // Nr. 3
  "JUSTIZVOLLZUGSANSTALT", // Nr. 3
  "KRANKENHAUS", // Nr. 10
  "POLIZEI", // Nr. 4
  "SICHERHEITSBEHOERDE", // Nr. 4
  "BEHOERDE", // Nr. 4
  "DIPLOMATISCHE_VERTRETUNG", // Nr. 4
  "INTERNATIONALE_ORGANISATION", // Nr. 4
  "INDUSTRIEANLAGE", // Nr. 3
  "KRAFTWERK", // Nr. 3
  "UMSPANNWERK", // Nr. 3
  "BSL-4-LABOR", // Nr. 3
  "LABOR", // Nr. 3 (BSL-4 labs layer)
]);

const CONDITIONAL_TYPES = new Set([
  "WOHNGRUNDSTUECK", // Nr. 7 — owner consent / micro-drone exceptions
  "FREIBAD", // Nr. 8 — outside bathing hours
  "NATIONALPARK", // Nr. 6
  "NATURSCHUTZGEBIET", // Nr. 6
  "FFH-GEBIET", // Nr. 6
  "VOGELSCHUTZGEBIET", // Nr. 6
  "BUNDESAUTOBAHN", // Nr. 5 — distance / specific-category rules
  "BUNDESSTRASSE",
  "BAHNANLAGE",
  "BINNENWASSERSTRASSE",
  "SEEWASSERSTRASSE",
  "SCHIFFFAHRTSANLAGE",
  "STROMLEITUNG",
  "WINDKRAFTANLAGE",
]);

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

function pickDipulName(props: DipulProps): string {
  const raw =
    props.generated_name_EN ?? props.name ?? props.generated_name_DE ?? "";
  if (Array.isArray(raw)) {
    return String(raw[0] ?? "").trim();
  }
  return String(raw).trim();
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

/**
 * Map dipul type_code → ED-318-like restriction for open-category UX.
 * Cross-checked against LuftVO § 21h Abs. 3 + dipul Rechtsgrundlagen.
 */
function restrictionForType(
  typeCode: string | undefined,
  legalRef?: string,
): UasRestriction {
  const t = (typeCode ?? "").toUpperCase().trim();
  const legal = (legalRef ?? "").toUpperCase();

  if (
    PROHIBITED_TYPES.has(t) ||
    t.includes("FLUGBESCHRAENK") ||
    t.includes("MILITAER") ||
    legal.includes("§ 17") ||
    /ABS\.\s*3\s*\([12]\.?\)/.test(legal)
  ) {
    return "PROHIBITED";
  }
  // Temporary operational restrictions (§ 21h Abs. 4) — treat as no-fly until cleared
  if (t.includes("TEMPORAER") || legal.includes("ABS. 4")) {
    return "PROHIBITED";
  }
  // CTR — Flugverkehrskontrollfreigabe (§ 21h Abs. 3 Nr. 9)
  if (t === "KONTROLLZONE" || t.includes("KONTROLL")) {
    return "REQ_AUTHORISATION";
  }
  if (CONDITIONAL_TYPES.has(t) || t.includes("WOHN") || t.includes("FREIBAD")) {
    return "CONDITIONAL";
  }
  return "REQ_AUTHORISATION";
}

function propsToMatchedZone(props: DipulProps): MatchedZone | null {
  const nameFromProps = pickDipulName(props);
  const identifier = String(
    props.external_reference ?? nameFromProps ?? "",
  ).trim();
  if (!identifier) return null;

  const name = nameFromProps || identifier;

  const lowerUnit = String(props.lower_limit_unit ?? "m");
  const upperUnit = String(props.upper_limit_unit ?? lowerUnit);
  const lowerRaw = Number(props.lower_limit_altitude ?? 0);
  const upperRaw =
    props.upper_limit_altitude != null
      ? Number(props.upper_limit_altitude)
      : 120;

  const lowerRef = String(props.lower_limit_alt_ref ?? "AGL").toUpperCase();
  const upperRef = String(
    props.upper_limit_alt_ref ?? props.lower_limit_alt_ref ?? "AGL",
  ).toUpperCase();

  return {
    identifier,
    name,
    restriction: restrictionForType(props.type_code, props.legal_ref),
    reason: [
      ...(props.type_code ? [String(props.type_code)] : []),
      ...(props.legal_ref ? [String(props.legal_ref)] : []),
    ],
    source: "dipul",
    country: "DE",
    lowerLimitM: toMeters(lowerRaw, lowerUnit),
    upperLimitM: toMeters(upperRaw, upperUnit),
    lowerRef: lowerRef === "MSL" || lowerRef === "AMSL" ? "AMSL" : "AGL",
    upperRef: upperRef === "MSL" || upperRef === "AMSL" ? "AMSL" : "AGL",
    message: props.legal_ref ? String(props.legal_ref) : undefined,
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
  const pad = 0.0004; // ~40 m
  const matches: MatchedZone[] = [];
  const seen = new Set<string>();

  await Promise.all(
    STATUS_TYPES.map(async (typeName) => {
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
    }),
  );

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

  const perLayer = Math.max(15, Math.floor(limit / MAP_TYPES.length));
  const merged: GeoJSON.Feature[] = [];
  const seen = new Set<string>();

  await Promise.all(
    MAP_TYPES.map(async (typeName) => {
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
    }),
  );

  return {
    type: "FeatureCollection",
    features: merged.slice(0, limit),
  };
}
