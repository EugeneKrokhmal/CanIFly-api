import type {
  MatchedZone,
  UasRestriction,
  UasZoneFeature,
} from "@canifly/middleware";
import { pansaHttpsRequest } from "./pansa-tls";

const PANSA_BASE = "https://api.dronemap.pansa.pl";
const TOKEN_SKEW_MS = 60_000;

export class PansaFetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PansaFetchError";
  }
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

function requireApiKey(): string {
  const key = process.env.PANSA_API_KEY?.trim();
  if (!key) {
    throw new PansaFetchError(
      "PANSA_API_KEY is not configured",
      `${PANSA_BASE}/v1/front/login`,
    );
  }
  return key;
}

async function login(): Promise<TokenCache> {
  const apiKey = requireApiKey();
  const url = `${PANSA_BASE}/v1/front/login`;
  const response = await pansaHttpsRequest(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "x-api-key": apiKey,
      Origin: "https://dronemap.pansa.pl",
      Referer: "https://dronemap.pansa.pl/",
      "Content-Length": "0",
    },
    timeoutMs: 12_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new PansaFetchError(`Login failed HTTP ${response.status}`, url, response.status);
  }
  const payload = JSON.parse(response.body) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) {
    throw new PansaFetchError("Login response missing access_token", url);
  }
  const expiresInSec = Number(payload.expires_in ?? 300);
  return {
    accessToken: payload.access_token,
    expiresAt: Date.now() + expiresInSec * 1000 - TOKEN_SKEW_MS,
  };
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }
  tokenCache = await login();
  return tokenCache.accessToken;
}

async function pansaGet<T>(
  path: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const apiKey = requireApiKey();
  const token = await getAccessToken();
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  );
  const url = `${PANSA_BASE}${path}${qs.toString() ? `?${qs}` : ""}`;
  const response = await pansaHttpsRequest(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "x-api-key": apiKey,
      Authorization: `Bearer ${token}`,
      Origin: "https://dronemap.pansa.pl",
      Referer: "https://dronemap.pansa.pl/",
    },
    timeoutMs: 25_000,
  });
  if (response.status === 401) {
    tokenCache = null;
    throw new PansaFetchError(`Unauthorized HTTP 401`, url, 401);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new PansaFetchError(`HTTP ${response.status}`, url, response.status);
  }
  return JSON.parse(response.body) as T;
}

interface PansaTypeInfo {
  name: string;
  descriptionEn?: string;
  descriptionPl?: string;
}

let typeCache: { byName: Map<string, PansaTypeInfo>; expiresAt: number } | null =
  null;
const TYPE_CACHE_MS = 6 * 60 * 60 * 1000;

async function getPansaTypeMap(): Promise<Map<string, PansaTypeInfo>> {
  if (typeCache && typeCache.expiresAt > Date.now()) {
    return typeCache.byName;
  }
  const payload = await pansaGet<{
    properties?: Array<{
      name?: string;
      description?: { en?: string; pl?: string } | string | null;
    }>;
  }>("/v1/zones/types");
  const byName = new Map<string, PansaTypeInfo>();
  for (const row of payload.properties ?? []) {
    const name = String(row.name ?? "")
      .trim()
      .toUpperCase();
    if (!name) continue;
    const desc = row.description;
    byName.set(name, {
      name,
      descriptionEn:
        typeof desc === "string"
          ? desc
          : desc && typeof desc === "object"
            ? desc.en
            : undefined,
      descriptionPl:
        typeof desc === "object" && desc ? desc.pl : undefined,
    });
  }
  typeCache = { byName, expiresAt: Date.now() + TYPE_CACHE_MS };
  return byName;
}

function formatPansaActivity(acts: unknown): string | undefined {
  if (!acts || typeof acts !== "object") return undefined;
  const a = acts as Record<string, unknown>;
  if (a.H24 === true || a.h24 === true) return "Zone active H24";
  // Common table-style payloads — keep short.
  if (typeof a.text === "string" && a.text.trim()) return a.text.trim();
  return undefined;
}

async function resolvePansaMessage(raw: PansaZoneRaw): Promise<string | undefined> {
  const own = pickDescription(raw.description);
  const activity = formatPansaActivity(raw.acts);
  let typeDesc: string | undefined;
  try {
    const types = await getPansaTypeMap();
    const t = types.get(String(raw.type ?? "").toUpperCase());
    typeDesc = t?.descriptionEn?.trim() || t?.descriptionPl?.trim();
  } catch (err) {
    console.warn("[pansa] types catalog failed", err);
  }
  const body = own || typeDesc;
  if (!activity && !body) return undefined;
  if (activity && body) return `${activity}\n\n${body}`;
  return activity ?? body;
}

export interface PansaZoneRaw {
  uid?: string;
  name?: string;
  othername?: string | null;
  country?: string | null;
  type?: string | null;
  min?: number | null;
  max?: number | null;
  contact?: string | null;
  description?: { en?: string; pl?: string } | string | null;
  restriction?: string | null;
  geojson?: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  geometry?: unknown;
  start?: string | null;
  stop?: string | null;
  acts?: unknown;
  source?: string | null;
}

interface PansaListResponse {
  properties?: PansaZoneRaw[];
  status?: unknown;
}

function pickDescription(desc: PansaZoneRaw["description"]): string | undefined {
  if (!desc) return undefined;
  if (typeof desc === "string") return desc.trim() || undefined;
  return (desc.en ?? desc.pl ?? "").trim() || undefined;
}

/** Map PANSA zone type / name / text → ED-318-like restriction. */
export function pansaToRestriction(raw: PansaZoneRaw): UasRestriction {
  const t = String(raw.type ?? "").toUpperCase();
  const n = String(raw.name ?? "").toUpperCase().replace(/\s+/g, " ");
  const msg = (pickDescription(raw.description) ?? "").toUpperCase();

  if (raw.restriction) {
    const r = String(raw.restriction).toUpperCase();
    if (r.includes("PROHIB")) return "PROHIBITED";
    if (r.includes("AUTHORI") || r.includes("AUTH")) return "REQ_AUTHORISATION";
    if (r.includes("COND")) return "CONDITIONAL";
  }

  if (t === "DRAP" || n.startsWith("DRA-P") || n.startsWith("DRAP")) {
    return "PROHIBITED";
  }
  if (t === "DRAR" || n.startsWith("DRA-R") || n.startsWith("DRAR")) {
    return "REQ_AUTHORISATION";
  }
  if (t === "DRAI" || n.startsWith("DRA-I") || n.startsWith("DRAI")) {
    return "CONDITIONAL";
  }
  if (["P", "EPP"].includes(t) || msg.includes("PROHIBITED")) {
    return "PROHIBITED";
  }
  if (
    [
      "CTR",
      "CTR1KM",
      "CTR6KM",
      "MCTR",
      "MCTR2KM",
      "ATZ",
      "ATZ1KM",
      "ATZ6KM",
      "R",
      "EPR",
      "TRA",
      "TSA",
      "D",
      "EPD",
      "RMZ",
      "ADIZ",
    ].includes(t)
  ) {
    return "REQ_AUTHORISATION";
  }
  return "CONDITIONAL";
}

function pansaReasons(raw: PansaZoneRaw): string[] {
  const t = String(raw.type ?? "").toUpperCase();
  if (t.startsWith("DRA")) return ["UAS_GEOGRAPHIC_ZONE"];
  if (
    [
      "CTR",
      "CTR1KM",
      "CTR6KM",
      "MCTR",
      "MCTR2KM",
      "ATZ",
      "ATZ1KM",
      "ATZ6KM",
      "TMA",
      "MTMA",
    ].includes(t)
  ) {
    return ["AIR_TRAFFIC"];
  }
  if (["TSA", "TRA", "D", "R", "P", "MRT"].includes(t)) return ["OTHER"];
  return ["OTHER"];
}

function metersBetween(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Approximate range (m) covering a lon/lat bbox from its center. */
export function bboxToRangeM(
  west: number,
  south: number,
  east: number,
  north: number,
): { lat: number; lon: number; range: number } {
  const lat = (south + north) / 2;
  const lon = (west + east) / 2;
  const corner = metersBetween(lat, lon, north, east);
  return { lat, lon, range: Math.max(500, Math.ceil(corner * 1.15)) };
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Drop FIR-wide fills — they paint the whole country red unlike DroneMap. */
const MAX_MAP_ZONE_SPAN_DEG = 3.5;

function geometryEnvelope(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): { minLng: number; maxLng: number; minLat: number; maxLat: number } {
  const coords: number[][] =
    geometry.type === "Polygon"
      ? geometry.coordinates.flat()
      : geometry.coordinates.flat(2);
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const c of coords) {
    minLng = Math.min(minLng, c[0]);
    maxLng = Math.max(maxLng, c[0]);
    minLat = Math.min(minLat, c[1]);
    maxLat = Math.max(maxLat, c[1]);
  }
  return { minLng, maxLng, minLat, maxLat };
}

export function isOversizedForMap(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  maxSpan = MAX_MAP_ZONE_SPAN_DEG,
): boolean {
  const e = geometryEnvelope(geometry);
  return e.maxLng - e.minLng > maxSpan || e.maxLat - e.minLat > maxSpan;
}

/**
 * Country-scale DRA-I “navigation warning FIR …” advisories — informative on
 * DroneMap, not a solid no-fly fill. Skip for map + status driving zones.
 */
export function isPansaFirWideAdvisory(raw: PansaZoneRaw): boolean {
  const name = String(raw.name ?? "").toUpperCase();
  const type = String(raw.type ?? "").toUpperCase();
  if (name.includes("NAVIGATION WARNING") && name.includes("FIR")) return true;
  if (type === "DRAI" && /\bFIR\b/.test(name)) return true;
  if (
    type === "DRAI" &&
    raw.geojson &&
    (raw.geojson.type === "Polygon" || raw.geojson.type === "MultiPolygon") &&
    isOversizedForMap(raw.geojson)
  ) {
    return true;
  }
  return false;
}

/**
 * Scheduled activity: `true` / `false` when start/stop exist, else `null`
 * (standing / always-published geometry).
 */
export function pansaScheduleState(
  raw: PansaZoneRaw,
  nowMs = Date.now(),
): boolean | null {
  const start = raw.start ? Date.parse(String(raw.start)) : Number.NaN;
  const stop = raw.stop ? Date.parse(String(raw.stop)) : Number.NaN;
  if (!Number.isFinite(start) && !Number.isFinite(stop)) return null;
  if (Number.isFinite(start) && nowMs < start) return false;
  if (Number.isFinite(stop) && nowMs > stop) return false;
  return true;
}

/**
 * Whether a PANSA zone should drive Clear/Restricted/Prohibited for open
 * recreational status. Standing TRA/TSA (no activation window) are omitted from
 * the map as well — they blanket large rural areas without affecting flight status.
 */
export function isPansaStatusRelevant(raw: PansaZoneRaw): boolean {
  if (isPansaFirWideAdvisory(raw)) return false;
  const type = String(raw.type ?? "").toUpperCase();
  const schedule = pansaScheduleState(raw);

  // Temporary reserved / segregated: only when explicitly active.
  if (type === "TRA" || type === "TSA" || type === "TS" || type === "TR") {
    return schedule === true;
  }

  // DRA-P / DRA-R with an expired or future window → ignore for status.
  if (
    (type === "DRAP" ||
      type === "DRAR" ||
      type === "R" ||
      type === "P" ||
      type === "D") &&
    schedule === false
  ) {
    return false;
  }

  // Large manned-aviation AREA overlays — map only.
  if (type === "AREA") return false;

  // DRA-I is informational on DroneMap (checklist), not a hard restriction.
  if (type === "DRAI") return false;

  return true;
}

/** Map: geometries that overlap status logic (no standing TRA/TSA wash, etc.). */
export function isPansaMapRelevant(raw: PansaZoneRaw): boolean {
  if (isPansaFirWideAdvisory(raw)) return false;
  const geom = raw.geojson;
  if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) {
    return false;
  }
  if (isOversizedForMap(geom)) return false;
  // Skip expired scheduled shapes on the map too.
  if (pansaScheduleState(raw) === false) return false;
  return isPansaStatusRelevant(raw);
}

function geometryContainsPoint(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  lng: number,
  lat: number,
): boolean {
  if (geometry.type === "Polygon") {
    const [outer, ...holes] = geometry.coordinates;
    if (!outer || !pointInRing(lng, lat, outer)) return false;
    return !holes.some((hole) => pointInRing(lng, lat, hole));
  }
  return geometry.coordinates.some((poly) => {
    const [outer, ...holes] = poly;
    if (!outer || !pointInRing(lng, lat, outer)) return false;
    return !holes.some((hole) => pointInRing(lng, lat, hole));
  });
}

export async function pansaRawToMatchedZone(
  raw: PansaZoneRaw,
): Promise<MatchedZone | null> {
  const identifier = String(raw.name ?? raw.uid ?? "").trim();
  if (!identifier) return null;
  const lower = Number(raw.min ?? 0);
  const upper = Number(raw.max ?? 120);
  return {
    identifier,
    name: String(raw.othername ?? raw.name ?? identifier),
    restriction: pansaToRestriction(raw),
    reason: pansaReasons(raw),
    source: "pansa",
    country: "PL",
    lowerLimitM: Number.isFinite(lower) ? lower : 0,
    upperLimitM: Number.isFinite(upper) ? upper : 120,
    lowerRef: "AGL",
    upperRef: "AGL",
    contact: raw.contact ? String(raw.contact) : undefined,
    message: await resolvePansaMessage(raw),
  };
}

export async function pansaRawToFeature(
  raw: PansaZoneRaw,
): Promise<GeoJSON.Feature | null> {
  const zone = await pansaRawToMatchedZone(raw);
  const geom = raw.geojson;
  if (!zone || !geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) {
    return null;
  }
  const activity = formatPansaActivity(raw.acts);
  return {
    type: "Feature",
    geometry: geom,
    properties: {
      identifier: zone.identifier,
      name: zone.name,
      restriction: zone.restriction,
      reason: zone.reason,
      source: zone.source,
      country: zone.country,
      zoneType: String(raw.type ?? ""),
      activeH24: Boolean(
        raw.acts &&
          typeof raw.acts === "object" &&
          ((raw.acts as { H24?: boolean }).H24 ||
            (raw.acts as { h24?: boolean }).h24),
      ),
      activity,
      lowerLimitM: zone.lowerLimitM,
      upperLimitM: zone.upperLimitM,
      lowerRef: zone.lowerRef,
      upperRef: zone.upperRef,
      message: zone.message,
      contact: zone.contact,
      mapStatus: "uas",
    },
  };
}

/** Also useful if we later ingest into PostGIS. */
export async function pansaRawToUasZoneFeature(
  raw: PansaZoneRaw,
): Promise<UasZoneFeature | null> {
  const zone = await pansaRawToMatchedZone(raw);
  const geom = raw.geojson;
  if (!zone || !geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) {
    return null;
  }
  return {
    identifier: zone.identifier,
    country: "POL",
    name: zone.name,
    type: String(raw.type ?? "UAS"),
    restriction: zone.restriction,
    reason: zone.reason,
    zoneAuthority: zone.contact
      ? [{ name: "PANSA", phone: zone.contact }]
      : [{ name: "PANSA" }],
    geometry: [
      {
        upperLimit: zone.upperLimitM,
        lowerLimit: zone.lowerLimitM,
        uomDimensions: "M",
        upperVerticalReference: "AGL",
        lowerVerticalReference: "AGL",
        horizontalProjection: geom,
      },
    ],
    message: zone.message,
  };
}

export async function queryPansaFiltered(
  lat: number,
  lon: number,
  rangeM: number,
  maxHeightM: number,
): Promise<PansaZoneRaw[]> {
  const payload = await pansaGet<PansaListResponse>("/v1/zones/filtered", {
    lat,
    lon,
    range: Math.round(rangeM),
    max_height: Math.round(maxHeightM),
  });
  return Array.isArray(payload.properties) ? payload.properties : [];
}

export async function queryPansaPoint(
  lat: number,
  lng: number,
  altitudeAgl = 120,
): Promise<MatchedZone[]> {
  // Warm type-description cache once per request batch.
  await getPansaTypeMap().catch(() => undefined);
  const raws = await queryPansaFiltered(lat, lng, 2_000, Math.max(altitudeAgl, 120));
  const zones: MatchedZone[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    if (!isPansaStatusRelevant(raw)) continue;
    const geom = raw.geojson;
    if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue;
    if (!geometryContainsPoint(geom, lng, lat)) continue;
    const zone = await pansaRawToMatchedZone(raw);
    if (!zone || seen.has(zone.identifier)) continue;
    seen.add(zone.identifier);
    zones.push(zone);
  }
  return zones;
}

export async function queryPansaBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  limit = 500,
  maxHeightM = 120,
): Promise<GeoJSON.FeatureCollection> {
  await getPansaTypeMap().catch(() => undefined);
  const { lat, lon, range } = bboxToRangeM(west, south, east, north);
  // Generous cap — still below country-wide FIR pulls.
  const cappedRange = Math.min(range, 280_000);
  const raws = await queryPansaFiltered(lat, lon, cappedRange, maxHeightM);
  const features: GeoJSON.Feature[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    if (!isPansaMapRelevant(raw)) continue;
    const feature = await pansaRawToFeature(raw);
    if (!feature) continue;
    const id = String((feature.properties as { identifier?: string })?.identifier ?? "");
    if (id && seen.has(id)) continue;
    const geom = feature.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
    if (!geometryIntersectsBbox(geom, west, south, east, north)) continue;
    if (id) seen.add(id);
    features.push(feature);
    if (features.length >= limit) break;
  }
  return { type: "FeatureCollection", features };
}

function geometryIntersectsBbox(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  west: number,
  south: number,
  east: number,
  north: number,
): boolean {
  const e = geometryEnvelope(geometry);
  return !(east < e.minLng || west > e.maxLng || north < e.minLat || south > e.maxLat);
}
