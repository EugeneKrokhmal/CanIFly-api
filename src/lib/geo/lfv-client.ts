/**
 * Live Swedish UAS / drone airspace via LFV Drönarkarta WFS
 * (https://daim.lfv.se/echarts/dronechart/API/).
 *
 * Layers mirror the official drone chart: CTR/ATZ/TIZ, restriction & danger
 * areas, runway/heliport buffers, AIP SUP and NOTAM. Point and map queries use
 * viewport WFS (no national file cache — avoids OOM on small hosts).
 *
 * Attribution: LFV data under CC BY-NC-ND 4.0 — Transportstyrelsen remains the
 * regulatory authority; the chart is not a certified AIS briefing.
 */
import {
  toMeters,
  zoneVisualStatus,
  type MatchedZone,
  type UasRestriction,
} from "@canifly/middleware";
import { ViewportLayerCache } from "./geojson-bbox-cache";

const LFV_WFS = "https://daim.lfv.se/geoserver/wfs";

const MAX_MAP_BBOX_DEG = 3.5;
const CLAMP_MAP_BBOX_DEG = 2.0;

/** Layers used for status (point) and map paint. */
const STATUS_TYPES: readonly string[] = [
  "mais:CTR",
  "mais:ATZ",
  "mais:TIZ",
  "mais:RSTA",
  "mais:DNGA",
  "DAIM_TOPO:RWY5K",
  "DAIM_TOPO:HKP1K",
  "DAIM_TOPO:SUP",
  "dynais:NOTAM",
  "DAIM_TOPO:esgg_rpas",
];

const MAP_TYPES = STATUS_TYPES;

const viewportLayerCache = new ViewportLayerCache();

/** Military CTRs called out on the LFV drone-chart API page. */
const MILITARY_CTR_NAMES = new Set([
  "SAAB CTR",
  "SECTOR A",
  "SECTOR B",
  "KARLSBORG CTR",
  "MALMEN CTR",
  "KALLAX CTR",
  "RONNEBY CTR",
  "VIDSEL CTR",
  "VISBY CTR",
]);

export class LfvFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LfvFetchError";
  }
}

interface LfvProps {
  TYPEOFAREA?: string | null;
  NAMEOFAREA?: string | null;
  LOCATION?: string | null;
  UPPER?: string | number | null;
  LOWER?: string | number | null;
  COMMENT_1?: string | null;
  COMMENT_2?: string | null;
  POSITIONINDICATOR?: string | null;
  POSITIONIN?: string | null;
  WEF?: string | null;
  NAME?: string | null;
  DESIG?: string | null;
  FROM?: string | null;
  TO?: string | null;
  COM_EN?: string | null;
  COM_SE?: string | null;
  URL?: string | null;
  SERIES?: string | null;
  NO?: string | number | null;
  YEAR?: string | number | null;
  CODE23?: string | null;
  CODE45?: string | null;
  STARTVALIDITY?: string | null;
  ENDVALIDITY?: string | null;
  ITEM_A?: string | null;
  ITEM_E?: string | null;
  [key: string]: unknown;
}

function isTimeout(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "TimeoutError") ||
    (err instanceof Error && /aborted due to timeout|TimeoutError/i.test(err.message))
  );
}

function layerKind(typeName: string): string {
  const short = typeName.includes(":") ? typeName.split(":")[1]! : typeName;
  return short.toUpperCase();
}

function isGroundLower(lower: unknown): boolean {
  const s = String(lower ?? "")
    .trim()
    .toUpperCase();
  if (!s) return true;
  return (
    s === "GND" ||
    s === "SFC" ||
    s === "GND/SFC" ||
    s === "SFC/GND" ||
    s.startsWith("GND")
  );
}

function parseLimitFt(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toUpperCase();
  if (!s || s === "GND" || s === "SFC" || s === "GND/SFC" || s === "UNL" || s === "-") {
    return s === "UNL" ? 99999 : 0;
  }
  const fl = s.match(/^FL\s*(\d+)/);
  if (fl) return Number(fl[1]) * 100;
  const n = Number(s.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isActiveWindow(fromIso: string | null | undefined, toIso: string | null | undefined): boolean {
  const now = Date.now();
  if (fromIso) {
    const t = Date.parse(fromIso);
    if (Number.isFinite(t) && now < t) return false;
  }
  if (toIso) {
    const t = Date.parse(toIso);
    if (Number.isFinite(t) && now > t) return false;
  }
  return true;
}

function keepFeature(typeName: string, props: LfvProps): boolean {
  const kind = layerKind(typeName);
  if (kind === "RSTA" || kind === "DNGA") {
    return isGroundLower(props.LOWER);
  }
  if (kind === "SUP") {
    if (!isActiveWindow(props.FROM ?? undefined, props.TO ?? undefined)) return false;
    const lowerFt = parseLimitFt(props.LOWER);
    // Drone chart shows SUP with LOWER <= 500 ft; keep GND / low layers.
    if (lowerFt != null && lowerFt > 500) return false;
    return true;
  }
  if (kind === "NOTAM") {
    const code23 = String(props.CODE23 ?? "").toUpperCase();
    const code45 = String(props.CODE45 ?? "").toUpperCase();
    if (code45 === "TT") return false;
    if (code23 && !(code23.startsWith("R") || code23.startsWith("W"))) return false;
    if (
      !isActiveWindow(
        props.STARTVALIDITY ?? undefined,
        props.ENDVALIDITY ?? undefined,
      )
    ) {
      return false;
    }
    const lowerFt = parseLimitFt(props.LOWER);
    if (lowerFt != null && lowerFt > 500) return false;
    return true;
  }
  return true;
}

function restrictionFor(
  typeName: string,
  props: LfvProps,
): UasRestriction {
  const kind = layerKind(typeName);
  const name = String(props.NAMEOFAREA ?? props.NAME ?? props.LOCATION ?? "")
    .trim()
    .toUpperCase();
  if (MILITARY_CTR_NAMES.has(name) || name.includes("MILIT")) {
    return "PROHIBITED";
  }
  if (
    kind === "CTR" ||
    kind === "ATZ" ||
    kind === "TIZ" ||
    kind === "RWY5K" ||
    kind === "HKP1K"
  ) {
    return "PROHIBITED";
  }
  if (kind === "SUP" || kind === "NOTAM") {
    return "PROHIBITED";
  }
  if (kind === "DNGA" || kind === "ESGG_RPAS") {
    return "CONDITIONAL";
  }
  if (kind === "RSTA") {
    const msg = `${props.COMMENT_2 ?? ""} ${props.COMMENT_1 ?? ""}`.toUpperCase();
    if (
      msg.includes("PERMISSION REQUIRED") ||
      msg.includes("TILLSTÅND") ||
      msg.includes("TILLSTAND")
    ) {
      return "REQ_AUTHORISATION";
    }
    return "REQ_AUTHORISATION";
  }
  return "REQ_AUTHORISATION";
}

function pickName(typeName: string, props: LfvProps): string {
  const kind = layerKind(typeName);
  if (kind === "SUP") {
    return String(props.NAME ?? props.DESIG ?? "AIP SUP").trim();
  }
  if (kind === "NOTAM") {
    const series = props.SERIES ?? "";
    const no = props.NO ?? "";
    const year = props.YEAR ?? "";
    const label = `${series}${no}/${year}`.replace(/^\/|\/$/g, "");
    return String(props.ITEM_A || label || "NOTAM").trim();
  }
  return String(
    props.LOCATION ||
      props.NAMEOFAREA ||
      props.NAME ||
      props.POSITIONINDICATOR ||
      props.POSITIONIN ||
      layerKind(typeName),
  ).trim();
}

function pickIdentifier(typeName: string, props: LfvProps, name: string): string {
  const kind = layerKind(typeName);
  if (kind === "NOTAM") {
    return `NOTAM:${props.SERIES ?? ""}:${props.NO ?? ""}:${props.YEAR ?? ""}`;
  }
  if (kind === "SUP") {
    return `SUP:${props.DESIG ?? props.NAME ?? name}:${props.FROM ?? ""}`;
  }
  const pos = props.POSITIONINDICATOR ?? props.POSITIONIN ?? "";
  const area = props.NAMEOFAREA ?? props.NAME ?? name;
  return `${kind}:${pos}:${area}`.replace(/:+$/g, "");
}

function pickMessage(props: LfvProps): string | undefined {
  const parts = [
    props.COMMENT_2,
    props.COMMENT_1,
    props.COM_EN,
    props.COM_SE,
    props.ITEM_E,
    props.URL,
  ]
    .map((v) => (v != null ? String(v).trim() : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function propsToMatchedZone(
  typeName: string,
  props: LfvProps,
): MatchedZone | null {
  if (!keepFeature(typeName, props)) return null;
  const name = pickName(typeName, props);
  if (!name) return null;
  const identifier = pickIdentifier(typeName, props, name);
  const kind = layerKind(typeName);
  const lowerFt = parseLimitFt(props.LOWER) ?? 0;
  const upperFt = parseLimitFt(props.UPPER) ?? 400;
  const reason = [kind];
  if (props.TYPEOFAREA) reason.push(String(props.TYPEOFAREA));
  const nameU = name.toUpperCase();
  if (MILITARY_CTR_NAMES.has(nameU)) reason.push("MILITARY");

  return {
    identifier,
    name,
    restriction: restrictionFor(typeName, props),
    reason,
    source: "lfv",
    country: "SE",
    lowerLimitM: toMeters(lowerFt, "FT"),
    upperLimitM: toMeters(upperFt, "FT"),
    lowerRef: "AGL",
    upperRef: "AMSL",
    message: pickMessage(props),
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
    bbox: `${west},${south},${east},${north},EPSG:4326`,
    count: String(count),
    outputFormat: "application/json",
  });
  return `${LFV_WFS}?${params}`;
}

async function fetchGeoJson(
  url: string,
  timeoutMs = 12_000,
): Promise<GeoJSON.FeatureCollection> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CanIFly/0.3" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new LfvFetchError(`HTTP ${response.status}`, url, response.status);
    }
    const data = (await response.json()) as GeoJSON.FeatureCollection;
    if (!data || data.type !== "FeatureCollection") {
      return { type: "FeatureCollection", features: [] };
    }
    return data;
  } catch (err) {
    if (isTimeout(err)) {
      throw new LfvFetchError("lfv timeout", url, undefined, err);
    }
    throw err instanceof LfvFetchError
      ? err
      : new LfvFetchError(String(err), url, undefined, err);
  }
}

/**
 * Live point query — tiny envelope around the pin (WFS has no native point op).
 */
export async function queryLfvPoint(
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
        40,
      );
      try {
        const fc = await fetchGeoJson(url);
        for (const f of fc.features) {
          const props = (f.properties ?? {}) as LfvProps;
          const zone = propsToMatchedZone(typeName, props);
          if (!zone || seen.has(zone.identifier)) continue;
          seen.add(zone.identifier);
          matches.push(zone);
        }
      } catch (err) {
        if (
          isTimeout(err) ||
          (err instanceof LfvFetchError && isTimeout(err.cause))
        ) {
          console.warn(`[lfv] ${typeName} point timeout`);
        } else {
          console.warn(`[lfv] ${typeName} point failed`, err);
        }
      }
    }),
  );

  return matches;
}

function featureToMapFeature(
  typeName: string,
  f: GeoJSON.Feature,
): GeoJSON.Feature | null {
  if (!f.geometry) return null;
  const props = (f.properties ?? {}) as LfvProps;
  const zone = propsToMatchedZone(typeName, props);
  if (!zone) return null;
  return {
    type: "Feature",
    geometry: f.geometry,
    properties: {
      identifier: zone.identifier,
      name: zone.name,
      restriction: zone.restriction,
      reason: zone.reason,
      source: zone.source,
      country: zone.country,
      lowerLimitM: zone.lowerLimitM,
      upperLimitM: zone.upperLimitM,
      lowerRef: zone.lowerRef,
      upperRef: zone.upperRef,
      message: zone.message,
      mapStatus: zoneVisualStatus(zone),
    },
  };
}

/** Map bbox — parallel per-layer viewport cache. */
export async function queryLfvBbox(
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

  const perLayer = Math.max(20, Math.floor(limit / MAP_TYPES.length));
  const layers = await Promise.all(
    MAP_TYPES.map(async (typeName) => {
      try {
        return await viewportLayerCache.get(
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
            const fc = await fetchGeoJson(url);
            const out: GeoJSON.Feature[] = [];
            for (const f of fc.features) {
              const mapped = featureToMapFeature(typeName, f);
              if (mapped) out.push(mapped);
            }
            return out;
          },
        );
      } catch (err) {
        if (
          isTimeout(err) ||
          (err instanceof LfvFetchError && isTimeout(err.cause))
        ) {
          console.warn(`[lfv] ${typeName} bbox timeout`);
        } else {
          console.warn(`[lfv] ${typeName} bbox failed`, err);
        }
        return [] as GeoJSON.Feature[];
      }
    }),
  );

  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const layer of layers) {
    for (const f of layer) {
      const id = String(
        (f.properties as { identifier?: string } | null)?.identifier ?? "",
      );
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      features.push(f);
      if (features.length >= limit) {
        return { type: "FeatureCollection", features };
      }
    }
  }
  return { type: "FeatureCollection", features };
}
