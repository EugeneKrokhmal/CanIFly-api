/**
 * Strict map ↔ API accuracy suite.
 *
 * Validates that what the map paints from /api/zones/bbox and
 * /api/obstacles/bbox is well-formed, internally consistent with
 * zoneVisualStatus, and that interior samples of painted polygons
 * resolve the same zone via /api/airspace/status.
 *
 * Usage:
 *   npx tsx scripts/accuracy-map-data.ts
 *   API_BASE=https://canifly-api.onrender.com npx tsx scripts/accuracy-map-data.ts
 *   API_BASE=http://localhost:4000 npx tsx scripts/accuracy-map-data.ts
 */
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point as turfPoint } from "@turf/helpers";
import {
  zoneVisualStatus,
  type AirspaceStatus,
  type MatchedZone,
  type ZoneSource,
} from "@canifly/middleware";

const BASE = (process.env.API_BASE ?? "https://canifly-api.onrender.com").replace(
  /\/$/,
  "",
);
const PROFILE = {
  altitudeAgl: "120",
  weightClass: "c0",
  operationCategory: "open",
} as const;

const VALID_STATUSES = new Set([
  "prohibited",
  "restricted",
  "limited",
  "clear",
]);

const STATUS_RANK: Record<string, number> = {
  prohibited: 4,
  restricted: 3,
  limited: 2,
  clear: 1,
};

type Failure = { suite: string; caseId: string; detail: string };

const failures: Failure[] = [];
const warnings: Failure[] = [];
let checks = 0;

function fail(suite: string, caseId: string, detail: string) {
  failures.push({ suite, caseId, detail });
}

function warn(suite: string, caseId: string, detail: string) {
  warnings.push({ suite, caseId, detail });
}

function ok() {
  checks += 1;
}

async function getJson(
  url: string,
  timeoutMs = 60_000,
): Promise<{ ok: true; data: unknown; ms: number } | { ok: false; error: string; ms: number }> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status} ${body.slice(0, 200)}`,
        ms,
      };
    }
    return { ok: true, data: await res.json(), ms };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    clearTimeout(timer);
  }
}

function qs(params: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
}

function zonesBboxUrl(b: {
  west: number;
  south: number;
  east: number;
  north: number;
  limit?: number;
}): string {
  return `${BASE}/api/zones/bbox?${qs({
    ...PROFILE,
    west: b.west,
    south: b.south,
    east: b.east,
    north: b.north,
    limit: b.limit ?? 500,
  })}`;
}

function obstaclesBboxUrl(b: {
  west: number;
  south: number;
  east: number;
  north: number;
}): string {
  return `${BASE}/api/obstacles/bbox?${qs({
    west: b.west,
    south: b.south,
    east: b.east,
    north: b.north,
    limit: 500,
  })}`;
}

function statusUrl(lat: number, lng: number): string {
  return `${BASE}/api/airspace/status?${qs({ ...PROFILE, lat, lng })}`;
}

type Props = Record<string, unknown>;

function asProps(f: GeoJSON.Feature): Props {
  return (f.properties ?? {}) as Props;
}

function featureKey(f: GeoJSON.Feature): string {
  const p = asProps(f);
  const id = String(p.identifier ?? p.id ?? "");
  const country = String(p.country ?? "");
  return `${country}:${id}`;
}

function toMatchedZone(p: Props): MatchedZone {
  const reasonRaw = p.reason;
  const reason = Array.isArray(reasonRaw)
    ? reasonRaw.map(String)
    : reasonRaw
      ? [String(reasonRaw)]
      : [];
  return {
    identifier: String(p.identifier ?? ""),
    name: String(p.name ?? ""),
    restriction: String(p.restriction ?? ""),
    reason,
    source: (p.source ?? "fixture") as ZoneSource,
    country: p.country != null ? String(p.country) : undefined,
    lowerLimitM: Number(p.lowerLimitM ?? 0),
    upperLimitM: Number(p.upperLimitM ?? 120),
    lowerRef: String(p.lowerRef ?? "AGL"),
    upperRef: String(p.upperRef ?? "AGL"),
    message: p.message != null ? String(p.message) : undefined,
  };
}

function validateCoord(lng: number, lat: number, path: string): string | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return `${path}: non-finite (${lng},${lat})`;
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    return `${path}: out of world bounds (${lng},${lat})`;
  }
  return null;
}

function validateRing(
  ring: GeoJSON.Position[],
  path: string,
): string[] {
  const errs: string[] = [];
  if (!Array.isArray(ring) || ring.length < 4) {
    errs.push(`${path}: ring needs ≥4 positions (got ${ring?.length ?? 0})`);
    return errs;
  }
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i];
    if (!Array.isArray(c) || c.length < 2) {
      errs.push(`${path}[${i}]: bad position`);
      continue;
    }
    const e = validateCoord(Number(c[0]), Number(c[1]), `${path}[${i}]`);
    if (e) errs.push(e);
  }
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (Number(a[0]) !== Number(b[0]) || Number(a[1]) !== Number(b[1])) {
    errs.push(`${path}: ring not closed`);
  }
  return errs;
}

function validateGeometry(geom: GeoJSON.Geometry | null, path: string): string[] {
  const errs: string[] = [];
  if (!geom || typeof geom !== "object") {
    return [`${path}: missing geometry`];
  }
  if (geom.type === "Polygon") {
    if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
      return [`${path}: empty Polygon`];
    }
    geom.coordinates.forEach((ring, i) => {
      errs.push(...validateRing(ring, `${path}.coordinates[${i}]`));
    });
    return errs;
  }
  if (geom.type === "MultiPolygon") {
    if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
      return [`${path}: empty MultiPolygon`];
    }
    geom.coordinates.forEach((poly, pi) => {
      if (!Array.isArray(poly) || poly.length === 0) {
        errs.push(`${path}.coordinates[${pi}]: empty`);
        return;
      }
      poly.forEach((ring, ri) => {
        errs.push(
          ...validateRing(ring, `${path}.coordinates[${pi}][${ri}]`),
        );
      });
    });
    return errs;
  }
  return [`${path}: expected Polygon|MultiPolygon got ${geom.type}`];
}

function geomBbox(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): {
  west: number;
  south: number;
  east: number;
  north: number;
} {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (lng: number, lat: number) => {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  };
  if (geom.type === "Polygon") {
    for (const ring of geom.coordinates) {
      for (const c of ring) visit(Number(c[0]), Number(c[1]));
    }
  } else {
    for (const poly of geom.coordinates) {
      for (const ring of poly) {
        for (const c of ring) visit(Number(c[0]), Number(c[1]));
      }
    }
  }
  return { west, south, east, north };
}

/** Candidate interior points: ring centroid + mid-edge nudges. */
function interiorCandidates(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): Array<[number, number]> {
  const rings: GeoJSON.Position[][] =
    geom.type === "Polygon"
      ? [geom.coordinates[0]]
      : geom.coordinates.map((p) => p[0]);

  const out: Array<[number, number]> = [];
  for (const ring of rings) {
    if (!ring || ring.length < 4) continue;
    let sx = 0;
    let sy = 0;
    const n = ring.length - 1;
    for (let i = 0; i < n; i++) {
      sx += Number(ring[i][0]);
      sy += Number(ring[i][1]);
    }
    out.push([sx / n, sy / n]);

    for (let i = 0; i < Math.min(n, 12); i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const mx = (Number(a[0]) + Number(b[0])) / 2;
      const my = (Number(a[1]) + Number(b[1])) / 2;
      const cx = sx / n;
      const cy = sy / n;
      out.push([mx * 0.7 + cx * 0.3, my * 0.7 + cy * 0.3]);
      out.push([mx * 0.4 + cx * 0.6, my * 0.4 + cy * 0.6]);
    }
  }
  return out;
}

function findInteriorPoint(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): [number, number] | null {
  for (const [lng, lat] of interiorCandidates(geom)) {
    if (booleanPointInPolygon(turfPoint([lng, lat]), geom as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | GeoJSON.Polygon | GeoJSON.MultiPolygon)) {
      return [lng, lat];
    }
  }
  // Last resort: tiny grid inside bbox
  const b = geomBbox(geom);
  const steps = 8;
  for (let iy = 1; iy < steps; iy++) {
    for (let ix = 1; ix < steps; ix++) {
      const lng = b.west + ((b.east - b.west) * ix) / steps;
      const lat = b.south + ((b.north - b.south) * iy) / steps;
      if (booleanPointInPolygon(turfPoint([lng, lat]), geom)) {
        return [lng, lat];
      }
    }
  }
  return null;
}

function exteriorPoint(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): [number, number] {
  const b = geomBbox(geom);
  const padLng = Math.max(0.02, (b.east - b.west) * 0.35);
  const padLat = Math.max(0.02, (b.north - b.south) * 0.35);
  const candidates: Array<[number, number]> = [
    [b.west - padLng, b.south - padLat],
    [b.east + padLng, b.north + padLat],
    [b.west - padLng, (b.south + b.north) / 2],
    [b.east + padLng, (b.south + b.north) / 2],
  ];
  for (const c of candidates) {
    if (!booleanPointInPolygon(turfPoint(c), geom)) return c;
  }
  return [b.east + padLng + 0.05, b.north + padLat + 0.05];
}

const BBOXES: Array<{
  id: string;
  west: number;
  south: number;
  east: number;
  north: number;
  minFeatures: number;
  countryHint?: string;
}> = [
  { id: "ES-Madrid", west: -3.8, south: 40.35, east: -3.55, north: 40.5, minFeatures: 1, countryHint: "ES" },
  { id: "ES-MAD-airport", west: -3.62, south: 40.44, east: -3.5, north: 40.5, minFeatures: 1, countryHint: "ES" },
  { id: "ES-Barcelona", west: 2.05, south: 41.3, east: 2.25, north: 41.45, minFeatures: 1, countryHint: "ES" },
  { id: "DE-Berlin", west: 13.3, south: 52.45, east: 13.55, north: 52.55, minFeatures: 1, countryHint: "DE" },
  { id: "DE-BER-airport", west: 13.45, south: 52.33, east: 13.55, north: 52.4, minFeatures: 1, countryHint: "DE" },
  { id: "DE-MUC-airport", west: 11.7, south: 48.32, east: 11.85, north: 48.39, minFeatures: 1, countryHint: "DE" },
  { id: "DE-FRA-airport", west: 8.5, south: 50.0, east: 8.62, north: 50.07, minFeatures: 1, countryHint: "DE" },
  { id: "FR-Paris", west: 2.25, south: 48.8, east: 2.45, north: 48.9, minFeatures: 1, countryHint: "FR" },
  { id: "FR-CDG", west: 2.48, south: 48.98, east: 2.62, north: 49.04, minFeatures: 1, countryHint: "FR" },
  { id: "CZ-Prague", west: 14.3, south: 50.0, east: 14.55, north: 50.15, minFeatures: 1, countryHint: "CZ" },
  { id: "CZ-PRG-airport", west: 14.2, south: 50.07, east: 14.32, north: 50.13, minFeatures: 1, countryHint: "CZ" },
  { id: "PL-Warsaw", west: 20.9, south: 52.15, east: 21.1, north: 52.3, minFeatures: 1, countryHint: "PL" },
  { id: "PL-WAW-airport", west: 20.92, south: 52.14, east: 21.02, north: 52.2, minFeatures: 1, countryHint: "PL" },
  { id: "SE-Stockholm", west: 17.9, south: 59.25, east: 18.2, north: 59.4, minFeatures: 1, countryHint: "SE" },
  { id: "SE-ARN-airport", west: 17.85, south: 59.62, east: 17.98, north: 59.68, minFeatures: 1, countryHint: "SE" },
  { id: "IE-Dublin", west: -6.35, south: 53.28, east: -6.15, north: 53.42, minFeatures: 1, countryHint: "IE" },
  { id: "IE-DUB-airport", west: -6.3, south: 53.4, east: -6.2, north: 53.45, minFeatures: 1, countryHint: "IE" },
  { id: "LV-Riga", west: 24.0, south: 56.9, east: 24.2, north: 57.0, minFeatures: 1, countryHint: "LV" },
  { id: "LV-RIX-airport", west: 23.92, south: 56.9, east: 24.02, north: 56.95, minFeatures: 1, countryHint: "LV" },
];

/** Hard pin checks: painted map must cover these pins with expected severity. */
const HARD_PINS: Array<{
  id: string;
  lat: number;
  lng: number;
  expectStatus: Set<string>;
  country: string;
}> = [
  { id: "ES-MAD-airport", lat: 40.4719, lng: -3.5626, expectStatus: new Set(["prohibited", "restricted"]), country: "ES" },
  { id: "DE-BER-airport", lat: 52.3667, lng: 13.5033, expectStatus: new Set(["prohibited"]), country: "DE" },
  { id: "DE-MUC-airport", lat: 48.3537, lng: 11.775, expectStatus: new Set(["prohibited"]), country: "DE" },
  { id: "DE-FRA-airport", lat: 50.0379, lng: 8.5622, expectStatus: new Set(["prohibited"]), country: "DE" },
  { id: "FR-Paris", lat: 48.8566, lng: 2.3522, expectStatus: new Set(["prohibited"]), country: "FR" },
  { id: "FR-CDG", lat: 49.0097, lng: 2.5479, expectStatus: new Set(["prohibited"]), country: "FR" },
  { id: "CZ-PRG-airport", lat: 50.1008, lng: 14.26, expectStatus: new Set(["prohibited"]), country: "CZ" },
  { id: "PL-WAW-airport", lat: 52.1657, lng: 20.9671, expectStatus: new Set(["prohibited", "restricted"]), country: "PL" },
  { id: "SE-ARN-airport", lat: 59.6519, lng: 17.9186, expectStatus: new Set(["prohibited", "restricted"]), country: "SE" },
  { id: "IE-DUB-airport", lat: 53.4264, lng: -6.2499, expectStatus: new Set(["prohibited", "restricted"]), country: "IE" },
  { id: "LV-RIX-airport", lat: 56.9236, lng: 23.9711, expectStatus: new Set(["prohibited", "restricted"]), country: "LV" },
];

const MAX_CROSSCHECK_PER_BBOX = 12;
const MAX_GEOM_ERRORS_REPORT = 8;

type ZoneFc = GeoJSON.FeatureCollection & {
  meta?: { backend?: string; country?: string; countries?: string[] };
  error?: string;
  fallback?: boolean;
};

async function validateZonesBbox(b: (typeof BBOXES)[number]): Promise<{
  features: GeoJSON.Feature[];
  backend?: string;
}> {
  const suite = "zones/bbox";
  const res = await getJson(zonesBboxUrl(b));
  if (!res.ok) {
    fail(suite, b.id, `fetch: ${res.error}`);
    return { features: [] };
  }
  const data = res.data as ZoneFc;
  if (data.error || data.fallback) {
    fail(suite, b.id, `API error/fallback: ${data.error ?? "fallback"}`);
    return { features: [] };
  }
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    fail(suite, b.id, `not a FeatureCollection`);
    return { features: [] };
  }
  ok();

  const providerError = (data.meta as { providerError?: string } | undefined)
    ?.providerError;
  if (providerError) {
    fail(suite, b.id, `meta.providerError=${providerError}`);
  }

  if (data.features.length < b.minFeatures) {
    fail(
      suite,
      b.id,
      `features=${data.features.length} < min ${b.minFeatures} (backend=${data.meta?.backend})`,
    );
  } else {
    ok();
  }

  const seen = new Set<string>();
  let geomErrCount = 0;
  for (let i = 0; i < data.features.length; i++) {
    const f = data.features[i];
    const caseId = `${b.id}#${i}`;
    if (f.type !== "Feature") {
      fail(suite, caseId, `type=${f.type}`);
      continue;
    }
    const p = asProps(f);
    const id = String(p.identifier ?? "");
    if (!id) fail(suite, caseId, "missing properties.identifier");
    else ok();

    if (!p.restriction && p.restriction !== "") {
      fail(suite, caseId, `missing restriction id=${id}`);
    } else ok();

    const mapStatus = String(p.mapStatus ?? "");
    if (!VALID_STATUSES.has(mapStatus)) {
      fail(suite, caseId, `invalid mapStatus=${mapStatus} id=${id}`);
    } else {
      ok();
      const zone = toMatchedZone(p);
      const expected = zoneVisualStatus(zone);
      if (mapStatus !== expected) {
        fail(
          suite,
          caseId,
          `mapStatus=${mapStatus} ≠ zoneVisualStatus=${expected} id=${id} restriction=${zone.restriction}`,
        );
      } else ok();
    }

    const key = featureKey(f);
    if (id && seen.has(key)) {
      fail(suite, caseId, `duplicate feature key ${key}`);
    } else if (id) {
      seen.add(key);
      ok();
    }

    const gerrs = validateGeometry(f.geometry, `geom`);
    if (gerrs.length) {
      geomErrCount += 1;
      if (geomErrCount <= MAX_GEOM_ERRORS_REPORT) {
        fail(suite, caseId, gerrs.slice(0, 3).join("; ") + ` id=${id}`);
      }
    } else ok();

    // Must intersect requested bbox (loose: any vertex or PIP of bbox corners is overkill;
    // check feature bbox overlaps request).
    if (
      f.geometry &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
    ) {
      const fb = geomBbox(f.geometry);
      const overlaps =
        fb.west <= b.east &&
        fb.east >= b.west &&
        fb.south <= b.north &&
        fb.north >= b.south;
      if (!overlaps) {
        fail(
          suite,
          caseId,
          `geometry bbox outside request id=${id} feat=[${fb.west.toFixed(3)},${fb.south.toFixed(3)},${fb.east.toFixed(3)},${fb.north.toFixed(3)}]`,
        );
      } else ok();
    }
  }
  if (geomErrCount > MAX_GEOM_ERRORS_REPORT) {
    fail(
      suite,
      b.id,
      `…and ${geomErrCount - MAX_GEOM_ERRORS_REPORT} more geometry errors`,
    );
  }

  console.log(
    `  zones ${b.id}: features=${data.features.length} backend=${data.meta?.backend ?? "?"} ${res.ms}ms`,
  );
  return { features: data.features, backend: data.meta?.backend };
}

async function crossCheckInterior(
  bboxId: string,
  features: GeoJSON.Feature[],
  bboxBackend?: string,
): Promise<void> {
  const suite = "map↔status";
  const ranked = [...features]
    .filter(
      (f) =>
        f.geometry &&
        (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"),
    )
    .sort((a, b) => {
      const sa = String(asProps(a).mapStatus ?? "clear");
      const sb = String(asProps(b).mapStatus ?? "clear");
      return (STATUS_RANK[sb] ?? 0) - (STATUS_RANK[sa] ?? 0);
    })
    .slice(0, MAX_CROSSCHECK_PER_BBOX);

  for (const f of ranked) {
    const p = asProps(f);
    const id = String(p.identifier ?? "");
    const mapStatus = String(p.mapStatus ?? "clear") as AirspaceStatus;
    const geom = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
    const interior = findInteriorPoint(geom);
    const caseId = `${bboxId}/${id || "noid"}`;

    if (!interior) {
      fail(suite, caseId, "could not find interior sample point");
      continue;
    }
    const [lng, lat] = interior;
    // Double-check PIP
    if (!booleanPointInPolygon(turfPoint([lng, lat]), geom)) {
      fail(suite, caseId, `interior candidate not in polygon ${lng},${lat}`);
      continue;
    }
    ok();

    const res = await getJson(statusUrl(lat, lng));
    if (!res.ok) {
      fail(suite, caseId, `status fetch: ${res.error}`);
      continue;
    }
    const data = res.data as {
      status?: string;
      zones?: Array<{ identifier?: string; restriction?: string }>;
      meta?: { backend?: string; country?: string; providerError?: string };
      error?: string;
    };
    if (data.error) {
      fail(suite, caseId, `status error: ${data.error}`);
      continue;
    }
    if (data.meta?.providerError) {
      fail(suite, caseId, `providerError=${data.meta.providerError}`);
    }

    const statusZones = data.zones ?? [];
    const ids = new Set(statusZones.map((z) => String(z.identifier ?? "")));
    if (!ids.has(id)) {
      // Known divergence: map (filterForMap/PostGIS) vs live status backends.
      const backendsDiffer =
        bboxBackend &&
        data.meta?.backend &&
        bboxBackend !== data.meta.backend;
      const detail = `interior (${lat.toFixed(5)},${lng.toFixed(5)}) map paints id=${id} mapStatus=${mapStatus} but status zones=[${[...ids].slice(0, 8).join(",")}] status=${data.status} bboxBackend=${bboxBackend} statusBackend=${data.meta?.backend}`;
      if (backendsDiffer) {
        fail(suite, caseId, `BACKEND_MISMATCH ${detail}`);
      } else {
        fail(suite, caseId, `ZONE_MISSING ${detail}`);
      }
    } else {
      ok();
      // Severity: overall status must be ≥ this zone's mapStatus unless free-band clear-up-to.
      const overall = String(data.status ?? "clear");
      const zoneRank = STATUS_RANK[mapStatus] ?? 0;
      const overallRank = STATUS_RANK[overall] ?? 0;
      if (mapStatus !== "clear" && overallRank < zoneRank) {
        // Free-band exception: mapStatus limited but classify may return clear when freeLimit >= ceiling
        const zone = toMatchedZone(p);
        const isFreeBandish =
          mapStatus === "limited" &&
          (overall === "clear" || overall === "limited");
        if (!isFreeBandish) {
          fail(
            suite,
            caseId,
            `severity: mapStatus=${mapStatus} but pin status=${overall} (weaker) id=${id}`,
          );
        } else {
          warn(
            suite,
            caseId,
            `free-band-ish: mapStatus=${mapStatus} status=${overall}`,
          );
          ok();
        }
      } else ok();
    }

    // Exterior: same identifier must not appear when sampling clearly outside
    // (unless geometry is huge / wrapping — skip if exterior still inside).
    const ext = exteriorPoint(geom);
    if (booleanPointInPolygon(turfPoint(ext), geom)) {
      warn(suite, caseId, "skip exterior: still inside geom");
      continue;
    }
    const resExt = await getJson(statusUrl(ext[1], ext[0]));
    if (!resExt.ok) {
      fail(suite, caseId, `exterior status fetch: ${resExt.error}`);
      continue;
    }
    const dataExt = resExt.data as {
      zones?: Array<{ identifier?: string }>;
      error?: string;
    };
    if (dataExt.error) {
      // Outside coverage is acceptable for exterior samples near borders
      if (String(dataExt.error).toLowerCase().includes("coverage")) {
        ok();
        continue;
      }
      fail(suite, caseId, `exterior status error: ${dataExt.error}`);
      continue;
    }
    const extIds = new Set(
      (dataExt.zones ?? []).map((z) => String(z.identifier ?? "")),
    );
    if (extIds.has(id)) {
      fail(
        suite,
        caseId,
        `exterior (${ext[1].toFixed(5)},${ext[0].toFixed(5)}) still reports id=${id}`,
      );
    } else ok();
  }
}

async function validateObstacles(b: (typeof BBOXES)[number]): Promise<void> {
  const suite = "obstacles/bbox";
  const res = await getJson(obstaclesBboxUrl(b));
  if (!res.ok) {
    fail(suite, b.id, `fetch: ${res.error}`);
    return;
  }
  const data = res.data as GeoJSON.FeatureCollection & { error?: string };
  if (data.error) {
    fail(suite, b.id, `error: ${data.error}`);
    return;
  }
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    fail(suite, b.id, "not a FeatureCollection");
    return;
  }
  ok();

  const seen = new Set<string>();
  for (let i = 0; i < data.features.length; i++) {
    const f = data.features[i];
    const caseId = `${b.id}#${i}`;
    if (f.type !== "Feature") {
      fail(suite, caseId, `type=${f.type}`);
      continue;
    }
    if (!f.geometry || f.geometry.type !== "Point") {
      fail(suite, caseId, `geometry must be Point got ${f.geometry?.type}`);
      continue;
    }
    const [lng, lat] = f.geometry.coordinates;
    const ce = validateCoord(Number(lng), Number(lat), "coord");
    if (ce) fail(suite, caseId, ce);
    else ok();

    if (
      Number(lng) < b.west - 0.001 ||
      Number(lng) > b.east + 0.001 ||
      Number(lat) < b.south - 0.001 ||
      Number(lat) > b.north + 0.001
    ) {
      fail(
        suite,
        caseId,
        `point outside bbox (${lng},${lat})`,
      );
    } else ok();

    const p = asProps(f);
    const id = String(p.id ?? "");
    if (!id) fail(suite, caseId, "missing properties.id");
    else if (seen.has(id)) fail(suite, caseId, `duplicate obstacle id=${id}`);
    else {
      seen.add(id);
      ok();
    }

    if (!p.type && !p.obstacleType && !p.kind) {
      // soft: some rows may use different field names
      warn(suite, caseId, `no type/kind on obstacle id=${id}`);
    }
  }
  console.log(
    `  obstacles ${b.id}: features=${data.features.length} ${res.ms}ms`,
  );
}

async function hardPinChecks(): Promise<void> {
  const suite = "hard-pins";
  for (const pin of HARD_PINS) {
    // Status severity
    const res = await getJson(statusUrl(pin.lat, pin.lng));
    if (!res.ok) {
      fail(suite, pin.id, `status fetch: ${res.error}`);
      continue;
    }
    const data = res.data as {
      status?: string;
      zones?: unknown[];
      meta?: { country?: string; backend?: string };
      error?: string;
    };
    if (data.error) {
      fail(suite, pin.id, `status error: ${data.error}`);
      continue;
    }
    const st = String(data.status ?? "");
    if (!pin.expectStatus.has(st)) {
      fail(
        suite,
        pin.id,
        `status=${st} want one of [${[...pin.expectStatus].join(",")}] backend=${data.meta?.backend}`,
      );
    } else ok();

    if (data.meta?.country && data.meta.country !== pin.country) {
      fail(
        suite,
        pin.id,
        `country=${data.meta.country} want ${pin.country}`,
      );
    } else ok();

    // Map must paint a covering polygon at this pin
    const pad = 0.04;
    const bboxRes = await getJson(
      zonesBboxUrl({
        west: pin.lng - pad,
        south: pin.lat - pad,
        east: pin.lng + pad,
        north: pin.lat + pad,
      }),
    );
    if (!bboxRes.ok) {
      fail(suite, pin.id, `bbox fetch: ${bboxRes.error}`);
      continue;
    }
    const fc = bboxRes.data as ZoneFc;
    const covering = (fc.features ?? []).filter((f) => {
      if (
        !f.geometry ||
        (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")
      ) {
        return false;
      }
      return booleanPointInPolygon(
        turfPoint([pin.lng, pin.lat]),
        f.geometry,
      );
    });
    if (covering.length === 0) {
      fail(
        suite,
        pin.id,
        `map bbox paints ${fc.features?.length ?? 0} zones but NONE contain pin (${pin.lat},${pin.lng}) backend=${fc.meta?.backend}`,
      );
    } else {
      ok();
      const severities = covering.map((f) =>
        String(asProps(f).mapStatus ?? "clear"),
      );
      const best = Math.max(...severities.map((s) => STATUS_RANK[s] ?? 0));
      const wantMin = Math.min(
        ...[...pin.expectStatus].map((s) => STATUS_RANK[s] ?? 0),
      );
      if (best < wantMin) {
        fail(
          suite,
          pin.id,
          `covering mapStatus max rank ${best} < expected min ${wantMin} statuses=[${severities.join(",")}]`,
        );
      } else ok();
    }
    console.log(
      `  pin ${pin.id}: status=${st} covering=${covering.length} ${res.ms}ms`,
    );
  }
}

async function main(): Promise<number> {
  console.log(`=== map/API accuracy (strict) ===`);
  console.log(`API_BASE=${BASE}`);
  console.log(`profile=${JSON.stringify(PROFILE)}\n`);

  const health = await getJson(`${BASE}/health`, 15_000);
  if (!health.ok) {
    console.error(`FAIL health: ${health.error}`);
    return 2;
  }
  console.log(`health: ${JSON.stringify(health.data)}\n`);

  console.log("=== hard airport / city pins (status + map cover) ===");
  await hardPinChecks();

  console.log("\n=== zones bbox schema + geometry + mapStatus ===");
  const bboxFeatures: Array<{
    id: string;
    features: GeoJSON.Feature[];
    backend?: string;
  }> = [];
  for (const b of BBOXES) {
    const r = await validateZonesBbox(b);
    bboxFeatures.push({ id: b.id, ...r });
  }

  console.log("\n=== obstacles bbox points ===");
  for (const b of BBOXES) {
    await validateObstacles(b);
  }

  console.log(
    `\n=== interior/exterior cross-check (up to ${MAX_CROSSCHECK_PER_BBOX}/bbox) ===`,
  );
  for (const row of bboxFeatures) {
    if (!row.features.length) continue;
    console.log(`  cross-checking ${row.id} (${row.features.length} zones)…`);
    await crossCheckInterior(row.id, row.features, row.backend);
  }

  console.log("\n=== summary ===");
  console.log(`checks_passed≈${checks}`);
  console.log(`failures=${failures.length} warnings=${warnings.length}`);
  if (warnings.length) {
    console.log("\n--- warnings ---");
    for (const w of warnings.slice(0, 40)) {
      console.log(`  WARN [${w.suite}] ${w.caseId}: ${w.detail}`);
    }
    if (warnings.length > 40) console.log(`  … +${warnings.length - 40} more`);
  }
  if (failures.length) {
    console.log("\n--- failures ---");
    for (const f of failures) {
      console.log(`  FAIL [${f.suite}] ${f.caseId}: ${f.detail}`);
    }
    const categories = new Map<string, number>();
    for (const f of failures) {
      let cat = "other";
      if (f.detail.includes("geometry bbox outside")) {
        cat = "bbox_returns_zones_outside_request";
      } else if (f.detail.includes("BACKEND_MISMATCH")) {
        cat = "map_vs_status_backend_id_mismatch";
      } else if (f.detail.includes("ZONE_MISSING")) {
        cat = "map_zone_id_missing_in_status";
      } else if (f.detail.includes("providerError") || f.detail.includes("heap")) {
        cat = "provider_heap_or_error";
      } else if (f.detail.includes("< min")) {
        cat = "empty_or_thin_bbox";
      } else if (f.detail.includes("want one of")) {
        cat = "hard_pin_wrong_status";
      } else if (f.detail.includes("NONE contain pin")) {
        cat = "hard_pin_map_not_covering";
      }
      categories.set(cat, (categories.get(cat) ?? 0) + 1);
    }
    console.log("\n--- failure categories ---");
    for (const [k, v] of [...categories.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${v}\t${k}`);
    }
    console.log(`\nFAIL (${failures.length})`);
    return 1;
  }
  console.log("\nPASS");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
