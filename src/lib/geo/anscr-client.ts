/**
 * Live Czech UAS zones via ANS CR ArcGIS REST (aimgis.rlp.cz),
 * the same backend DroneMap uses — no zip downloads / PostGIS ingest.
 *
 * Restriction semantics follow CAA / LKR310–320 + LKP (zakázané) for open
 * category: inner AD zones (LKR314B/D/F) are hard no-fly without DroneMap
 * coordination; military ODOS / LKP → PROHIBITED; grids/HOP/nature → CONDITIONAL.
 */
import {
  zoneVisualStatus,
  type MatchedZone,
  type UasRestriction,
} from "@canifly/middleware";

const AIMGIS_BASE = "https://aimgis.rlp.cz/server/rest/services";

/** Skip aimgis geometry queries when the map viewport is this large (°). */
const MAX_MAP_BBOX_DEG = 3.5;
/** Soft-clamp oversized bboxes to this span around the viewport centre. */
const CLAMP_MAP_BBOX_DEG = 2.0;

/** Per-layer schemas differ — wildcard is required for aimgis. */
const OUT_FIELDS = "*";

export class AnscrFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AnscrFetchError";
  }
}

/** Point status layers (no geometry payload). */
const STATUS_LAYERS: readonly { service: string; layerId: number }[] = [
  { service: "zony", layerId: 0 },
  { service: "HOPs", layerId: 2 },
  { service: "chranena_uzemi", layerId: 0 },
  { service: "chranena_uzemi", layerId: 1 },
  { service: "chranena_uzemi", layerId: 2 },
  { service: "silnicni_sit", layerId: 0 },
  { service: "silnicni_sit", layerId: 1 },
  { service: "silnicni_sit", layerId: 2 },
  { service: "Zeleznice", layerId: 0 },
  { service: "Zeleznice", layerId: 1 },
  { service: "ODOS", layerId: 0 },
  { service: "energeticka_sit", layerId: 0 },
  { service: "energeticka_sit", layerId: 1 },
  { service: "zdroje_vody", layerId: 0 },
  { service: "Gridy", layerId: 0 },
  { service: "Gridy", layerId: 1 },
];

/** Map layers — light enough for live geometry at regional zoom. */
const MAP_LAYERS: readonly { service: string; layerId: number }[] = [
  { service: "zony", layerId: 0 },
  { service: "ODOS", layerId: 0 },
  { service: "HOPs", layerId: 2 },
  { service: "chranena_uzemi", layerId: 0 },
  { service: "chranena_uzemi", layerId: 1 },
  { service: "chranena_uzemi", layerId: 2 },
  { service: "energeticka_sit", layerId: 0 },
  { service: "energeticka_sit", layerId: 1 },
  { service: "zdroje_vody", layerId: 0 },
];

interface ArcGisFeature {
  attributes?: Record<string, unknown>;
  geometry?: { rings?: number[][][] };
}

interface ArcGisQueryResponse {
  features?: ArcGisFeature[];
  error?: { message?: string; code?: number };
}

function lonLatToWebMercator(lon: number, lat: number): { x: number; y: number } {
  const x = (lon * 20037508.34) / 180;
  let y =
    Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
  y = (y * 20037508.34) / 180;
  return { x, y };
}

function isTimeout(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "TimeoutError") ||
    (err instanceof Error &&
      /aborted due to timeout|TimeoutError|aimgis timeout/i.test(err.message))
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(
  url: string,
  options: { retries?: number; timeoutMs?: number } = {},
): Promise<ArcGisQueryResponse> {
  const retries = options.retries ?? 1;
  const timeoutMs = options.timeoutMs ?? 8_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "CanIFly/0.3",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new AnscrFetchError(`HTTP ${response.status}`, url, response.status);
      }
      return (await response.json()) as ArcGisQueryResponse;
    } catch (err) {
      lastError = err;
      if (isTimeout(err)) break; // don't retry timeouts
      if (attempt < retries) await sleep(200 * 2 ** attempt);
    }
  }
  throw new AnscrFetchError(
    isTimeout(lastError)
      ? "aimgis timeout"
      : `aimgis request failed: ${String(lastError)}`,
    url,
    undefined,
    lastError,
  );
}

function parseVyska(
  raw: unknown,
  aglLimit?: unknown,
): {
  lowerLimitM: number;
  upperLimitM: number;
  lowerRef: string;
  upperRef: string;
  message?: string;
} {
  // Grid CTR/ATZ: numeric AGL_limit is authoritative (0 = no free band).
  if (aglLimit != null && aglLimit !== "" && Number.isFinite(Number(aglLimit))) {
    const limit = Number(aglLimit);
    return {
      lowerLimitM: 0,
      upperLimitM: limit > 0 ? limit : 120,
      lowerRef: "AGL",
      upperRef: "AGL",
      message:
        limit > 0
          ? `Do výšky gridu ${limit} m AGL`
          : String(raw ?? "Grid AGL 0 — koordinace nutná"),
    };
  }

  const text = String(raw ?? "").trim();
  if (!text) {
    return { lowerLimitM: 0, upperLimitM: 120, lowerRef: "AGL", upperRef: "AGL" };
  }

  const band = text.match(
    /(?:GND|0)\s*[-–]\s*(?:FL\s*(\d+)|(\d+(?:\.\d+)?)\s*m\s*(AGL|AMSL)?)/i,
  );
  if (band?.[1]) {
    return {
      lowerLimitM: 0,
      upperLimitM: Math.round(Number(band[1]) * 100 * 0.3048),
      lowerRef: "AGL",
      upperRef: "AMSL",
      message: text,
    };
  }
  if (band?.[2]) {
    const uom = (band[3] ?? "AGL").toUpperCase() === "AMSL" ? "AMSL" : "AGL";
    return {
      lowerLimitM: 0,
      upperLimitM: Number(band[2]),
      lowerRef: "AGL",
      upperRef: uom,
      message: text,
    };
  }

  const agl = text.match(/(\d+)\s*m\s*AGL/i);
  if (agl) {
    return {
      lowerLimitM: 0,
      upperLimitM: Number(agl[1]),
      lowerRef: "AGL",
      upperRef: "AGL",
      message: text,
    };
  }

  return {
    lowerLimitM: 0,
    upperLimitM: 120,
    lowerRef: "AGL",
    upperRef: "AGL",
    message: text,
  };
}

/**
 * Map aimgis attrs → ED-318-like restriction for open-category UX.
 * Sources: CAA LKR/LKP overview + DroneMap / letejtezodpovedne CTR rules.
 */
function restrictionForAttrs(attrs: Record<string, unknown>): UasRestriction {
  const type = String(attrs.type ?? "").toUpperCase();
  const zone = String(attrs.zone ?? "").toUpperCase();
  const oop = String(attrs.OOP ?? "").toUpperCase();
  const kat = String(attrs.KAT ?? "").toUpperCase();
  const nazev = String(attrs.nazev ?? "").toUpperCase();
  const nazev2 = String(attrs.nazev2 ?? "").toUpperCase();
  const blob = `${type} ${zone} ${oop} ${kat} ${nazev} ${nazev2}`;

  // AIP prohibited areas (zakázané prostory LKP*)
  if (/\bLKP\d/.test(oop) || nazev.includes("ZAKÁZ") || nazev2.includes("ZAKÁZ")) {
    return "PROHIBITED";
  }

  // Inner aerodrome / CTR / MCTR zones (LKR314B/D/F) — airport hard core
  if (
    type.includes("AD_PERIMETER") ||
    zone.includes("INNER_AD") ||
    /\bLKR314[BDF]\b/.test(oop) ||
    nazev.includes("VNITŘNÍ ZÓNA") ||
    nazev.includes("VNITRNI ZONA")
  ) {
    return "PROHIBITED";
  }

  // Military objects (ODOS / LKR319)
  if (
    /\bLKR319\b/.test(oop) ||
    nazev.includes("VOJENSK") ||
    nazev2.includes("VOJENSK") ||
    blob.includes("MILITARY")
  ) {
    return "PROHIBITED";
  }

  // National parks — typically consent / no recreational
  if (kat === "NP" || /\bLKR318A\b/.test(oop)) {
    return "PROHIBITED";
  }

  // Grid CTR/ATZ with AGL_limit 0 → no free band at surface
  if (type.includes("GRID")) {
    const limit =
      attrs.AGL_limit != null && attrs.AGL_limit !== ""
        ? Number(attrs.AGL_limit)
        : NaN;
    if (Number.isFinite(limit) && limit <= 0) return "PROHIBITED";
    return "CONDITIONAL";
  }

  // Densely populated (HOP), nature, roads, rail, energy, water — conditions
  if (
    type.includes("PERIMETER") || // outer AD buffers if present
    /\bLKR314[ACE]\b/.test(oop) || // outer CTR / MCTR
    /\bLKR315/.test(oop) || // ATZ / SLZ / HEL
    /\bLKR316\b/.test(oop) || // HOP
    /\bLKR318/.test(oop) || // protected nature
    /\bLKR31[1237]\b/.test(oop) || // rail / energy / water / roads
    kat === "CHKO" ||
    kat === "PR" ||
    kat === "PP" ||
    kat === "NPR" ||
    nazev.includes("HUSTĚ OSÍDL") ||
    nazev.includes("HUSTE OSIDL")
  ) {
    return "CONDITIONAL";
  }

  return "REQ_AUTHORISATION";
}

function attrsToMatchedZone(
  attrs: Record<string, unknown>,
): MatchedZone | null {
  const identifier = String(
    attrs.IDENT ?? attrs.OBJECTID ?? attrs.OBJECT_ID ?? "",
  ).trim();
  if (!identifier) return null;

  const name = String(
    attrs.nazev2 ?? attrs.nazev ?? attrs.type ?? identifier,
  ).trim();
  const vertical = parseVyska(attrs.vyska, attrs.AGL_limit);
  const restriction = restrictionForAttrs(attrs);

  const reason: string[] = [];
  if (attrs.type) reason.push(String(attrs.type));
  if (attrs.zone) reason.push(String(attrs.zone));
  if (attrs.OOP) reason.push(String(attrs.OOP));
  if (attrs.KAT) reason.push(String(attrs.KAT));
  const nazev = String(attrs.nazev ?? "");
  if (/vojensk/i.test(nazev)) reason.push("MILITARY");

  // Surface grid with AGL 0: keep full band so status still matches at pin altitude
  let upperLimitM = vertical.upperLimitM;
  if (
    String(attrs.type ?? "").toUpperCase().includes("GRID") &&
    attrs.AGL_limit != null &&
    Number(attrs.AGL_limit) <= 0
  ) {
    upperLimitM = Math.max(upperLimitM, 120);
  }

  return {
    identifier,
    name,
    restriction,
    reason,
    source: "anscr",
    country: "CZ",
    lowerLimitM: vertical.lowerLimitM,
    upperLimitM,
    lowerRef: vertical.lowerRef,
    upperRef: vertical.upperRef,
    contact: attrs.provoz_ZZ ? String(attrs.provoz_ZZ) : undefined,
    message: vertical.message,
  };
}

function ringsToGeometry(
  rings: number[][][],
): GeoJSON.Polygon | GeoJSON.MultiPolygon {
  if (rings.length === 1) {
    return { type: "Polygon", coordinates: rings };
  }
  return {
    type: "MultiPolygon",
    coordinates: rings.map((ring) => [ring]),
  };
}

function layerQueryUrl(
  service: string,
  layerId: number,
  params: URLSearchParams,
): string {
  return `${AIMGIS_BASE}/${service}/MapServer/${layerId}/query?${params}`;
}

/** Shrink huge viewports so aimgis does not time out on country-scale envelopes. */
function clampMapBbox(
  west: number,
  south: number,
  east: number,
  north: number,
): { west: number; south: number; east: number; north: number } | null {
  const spanLng = east - west;
  const spanLat = north - south;
  if (spanLng <= 0 || spanLat <= 0) return null;
  // Continent-scale — skip live geometry entirely.
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

/**
 * Live point query against ANS CR DroneMap layers.
 */
export async function queryAnscrPoint(
  lat: number,
  lng: number,
): Promise<MatchedZone[]> {
  const { x, y } = lonLatToWebMercator(lng, lat);
  const matches: MatchedZone[] = [];
  const seen = new Set<string>();

  await Promise.all(
    STATUS_LAYERS.map(async ({ service, layerId }) => {
      const params = new URLSearchParams({
        geometry: JSON.stringify({
          x,
          y,
          spatialReference: { wkid: 3857 },
        }),
        geometryType: "esriGeometryPoint",
        inSR: "3857",
        spatialRel: "esriSpatialRelIntersects",
        outFields: OUT_FIELDS,
        returnGeometry: "false",
        f: "json",
        resultRecordCount: "40",
      });
      const url = layerQueryUrl(service, layerId, params);
      try {
        const payload = await fetchJson(url, { retries: 0, timeoutMs: 6_000 });
        if (payload.error) return;
        for (const feature of payload.features ?? []) {
          const zone = attrsToMatchedZone(feature.attributes ?? {});
          if (!zone) continue;
          const key = `${zone.identifier}:${zone.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push(zone);
        }
      } catch (err) {
        if (
          isTimeout(err) ||
          (err instanceof AnscrFetchError && isTimeout(err.cause))
        ) {
          console.warn(`[anscr] ${service}/${layerId} point timeout`);
        } else {
          console.warn(`[anscr] ${service}/${layerId} point failed`, err);
        }
      }
    }),
  );

  return matches;
}

/**
 * Live bbox query for map polygons (excludes Grid CTR/ATZ cells).
 * Oversized viewports are clamped or skipped — aimgis cannot paint all of CZ at once.
 */
export async function queryAnscrBbox(
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

  const sw = lonLatToWebMercator(clamped.west, clamped.south);
  const ne = lonLatToWebMercator(clamped.east, clamped.north);
  const features: GeoJSON.Feature[] = [];
  const perLayer = Math.max(20, Math.floor(limit / MAP_LAYERS.length));
  const seen = new Set<string>();

  await Promise.all(
    MAP_LAYERS.map(async ({ service, layerId }) => {
      const params = new URLSearchParams({
        geometry: `${sw.x},${sw.y},${ne.x},${ne.y}`,
        geometryType: "esriGeometryEnvelope",
        inSR: "3857",
        outSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: OUT_FIELDS,
        returnGeometry: "true",
        f: "json",
        resultRecordCount: String(perLayer),
      });
      const url = layerQueryUrl(service, layerId, params);
      try {
        const payload = await fetchJson(url, { retries: 0, timeoutMs: 8_000 });
        if (payload.error) return;

        for (const feature of payload.features ?? []) {
          const zone = attrsToMatchedZone(feature.attributes ?? {});
          const rings = feature.geometry?.rings;
          if (!zone || !rings?.length) continue;
          const key = `${zone.identifier}:${zone.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          features.push({
            type: "Feature",
            id: zone.identifier,
            geometry: ringsToGeometry(rings),
            properties: {
              identifier: zone.identifier,
              name: zone.name,
              restriction: zone.restriction,
              reason: zone.reason,
              source: zone.source,
              country: "CZ",
              lowerLimitM: zone.lowerLimitM,
              upperLimitM: zone.upperLimitM,
              lowerRef: zone.lowerRef,
              upperRef: zone.upperRef,
              message: zone.message,
              mapStatus: zoneVisualStatus(zone),
            },
          });
        }
      } catch (err) {
        if (
          isTimeout(err) ||
          (err instanceof AnscrFetchError && isTimeout(err.cause))
        ) {
          console.warn(`[anscr] ${service}/${layerId} bbox timeout`);
        } else {
          console.warn(`[anscr] ${service}/${layerId} bbox failed`, err);
        }
      }
    }),
  );

  return { type: "FeatureCollection", features: features.slice(0, limit) };
}
