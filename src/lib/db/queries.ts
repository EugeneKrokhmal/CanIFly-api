import { getDb, isDatabaseAvailable } from "./client";
import { memoryZoneStore } from "./memory-store";
import {
  classifyStatus,
  filterByProfile,
  filterForMap,
  geoJsonToWkt,
  resolveCountry,
  zoneFeatureToSlices,
  zoneVisualStatus,
  type CountryId,
  type DroneProfile,
  type MatchedZone,
  type StatusResult,
  type ZoneSliceRecord,
  type ZoneSource,
} from "@canifly/middleware";
import { backendLabelForCountry, getProvider, LIVE_ONLY_COUNTRIES } from "../geo/providers";
import {
  queryPostgisBbox,
  queryPostgisPoint,
} from "../geo/postgis-zones";
import {
  coalesceZoneBbox,
  getZoneBboxCached,
  setZoneBboxCached,
  zoneBboxCacheKey,
  zoneBboxCacheTtlMs,
} from "../geo/zone-bbox-cache";

export interface QueryMeta {
  queryMs: number;
  dataVersion: string | null;
  backend: "servais" | "pansa" | "aimgis" | "dipul" | "geopf" | "dronezoner" | "foca" | "anac" | "austro" | "postgis" | "memory" | "multi";
  country?: CountryId | null;
  countries?: CountryId[];
  /** Set when a live provider threw (e.g. missing PANSA_API_KEY). */
  providerError?: string;
  /** True when served from in-memory bbox cache. */
  cached?: boolean;
}

async function querySpainFallbacks(
  lat: number,
  lng: number,
  started: number,
): Promise<{ zones: MatchedZone[]; meta: QueryMeta }> {
  const result = await queryPostgisPoint(lat, lng, { fallbackCountry: "ES" });
  return {
    zones: result.zones,
    meta: {
      queryMs: Math.round(performance.now() - started),
      dataVersion: result.dataVersion,
      backend: result.backend,
      country: "ES",
    },
  };
}

export async function queryPointIntersects(
  lat: number,
  lng: number,
  altitudeAgl = 120,
): Promise<{ zones: MatchedZone[]; meta: QueryMeta }> {
  const started = performance.now();
  const country = resolveCountry(lat, lng);

  if (!country) {
    return {
      zones: [],
      meta: {
        queryMs: Math.round(performance.now() - started),
        dataVersion: null,
        backend: "memory",
        country: null,
      },
    };
  }

  const provider = getProvider(country);
  try {
    const live = await provider.queryPoint(lat, lng, altitudeAgl);
    if (live.length > 0 || LIVE_ONLY_COUNTRIES.has(country)) {
      return {
        zones: live,
        meta: {
          queryMs: Math.round(performance.now() - started),
          dataVersion: new Date().toISOString().slice(0, 10),
          backend: backendLabelForCountry(country),
          country,
        },
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[queryPointIntersects] ${country} provider failed, falling back`,
      err,
    );
    if (LIVE_ONLY_COUNTRIES.has(country)) {
      return {
        zones: [],
        meta: {
          queryMs: Math.round(performance.now() - started),
          dataVersion: null,
          backend: backendLabelForCountry(country),
          country,
          providerError: message,
        },
      };
    }
  }
  if (country === "ES") {
    return querySpainFallbacks(lat, lng, started);
  }

  return {
    zones: [],
    meta: {
      queryMs: Math.round(performance.now() - started),
      dataVersion: null,
      backend: backendLabelForCountry(country),
      country,
    },
  };
}

export async function evaluateAirspaceStatus(
  lat: number,
  lng: number,
  profile: DroneProfile,
  altitudeAgl: number,
): Promise<{ result: StatusResult; meta: QueryMeta }> {
  const { zones, meta } = await queryPointIntersects(lat, lng, altitudeAgl);
  const filtered = filterByProfile(zones, profile, altitudeAgl);
  const result = classifyStatus(filtered, { ceilingAgl: altitudeAgl });
  return { result, meta };
}

function normalizeReason(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.length > 0) {
    return value
      .split(/[,;|]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function filterCollection(
  raw: GeoJSON.FeatureCollection,
  profile: DroneProfile,
  altitudeAgl: number,
): GeoJSON.Feature[] {
  const seen = new Set<string>();
  const out: GeoJSON.Feature[] = [];
  for (const f of raw.features) {
    const p = (f.properties ?? {}) as {
      restriction?: string;
      reason?: string[];
      source?: ZoneSource;
      country?: string;
      lowerLimitM?: number;
      upperLimitM?: number;
      lowerRef?: string;
      upperRef?: string;
      identifier?: string;
      name?: string;
      message?: string;
    };
    const id = String(p.identifier ?? "");
    const dedupeKey = `${p.country ?? ""}:${id}`;
    if (id && seen.has(dedupeKey)) continue;
    const zone: MatchedZone = {
      identifier: id,
      name: String(p.name ?? ""),
      restriction: String(p.restriction ?? ""),
      reason: normalizeReason(p.reason),
      source: (p.source ?? "fixture") as ZoneSource,
      country: p.country,
      lowerLimitM: Number(p.lowerLimitM ?? 0),
      upperLimitM: Number(p.upperLimitM ?? 120),
      lowerRef: String(p.lowerRef ?? "AGL"),
      upperRef: String(p.upperRef ?? "AGL"),
      message: p.message,
    };
    if (filterForMap([zone], profile, altitudeAgl).length === 0) continue;
    if (id) seen.add(dedupeKey);
    out.push({
      ...f,
      properties: {
        ...f.properties,
        mapStatus: zoneVisualStatus(zone),
      },
    });
  }
  return out;
}

async function querySpainBboxFallback(
  west: number,
  south: number,
  east: number,
  north: number,
  profile: DroneProfile,
  altitudeAgl: number,
  limit: number,
  started: number,
): Promise<{ collection: GeoJSON.FeatureCollection; meta: QueryMeta }> {
  const result = await queryPostgisBbox(west, south, east, north, {
    fallbackCountry: "ES",
    limit,
  });
  const collection: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: filterCollection(
      { type: "FeatureCollection", features: result.features },
      profile,
      altitudeAgl,
    ),
  };
  return {
    collection,
    meta: {
      queryMs: Math.round(performance.now() - started),
      dataVersion: result.dataVersion,
      backend: result.backend,
      country: "ES",
      countries: ["ES"],
    },
  };
}

export async function queryZonesInBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  profile: DroneProfile,
  altitudeAgl: number,
  limit = 500,
): Promise<{ collection: GeoJSON.FeatureCollection; meta: QueryMeta }> {
  const key = zoneBboxCacheKey(
    west,
    south,
    east,
    north,
    profile,
    altitudeAgl,
    limit,
  );
  const cached = getZoneBboxCached(key);
  if (cached) {
    return {
      collection: cached.collection,
      meta: { ...cached.meta, queryMs: 0, cached: true },
    };
  }

  return coalesceZoneBbox(key, async () => {
    const result = await queryZonesInBboxLive(
      west,
      south,
      east,
      north,
      profile,
      altitudeAgl,
      limit,
    );
    setZoneBboxCached(key, result, zoneBboxCacheTtlMs());
    return result;
  });
}

async function queryZonesInBboxLive(
  west: number,
  south: number,
  east: number,
  north: number,
  profile: DroneProfile,
  altitudeAgl: number,
  limit = 500,
): Promise<{ collection: GeoJSON.FeatureCollection; meta: QueryMeta }> {
  const started = performance.now();
  // One country per viewport — center point, not every overlapping AABB (faster at borders).
  const centerLat = (south + north) / 2;
  const centerLng = (west + east) / 2;
  const country = resolveCountry(centerLat, centerLng);

  if (!country) {
    return {
      collection: { type: "FeatureCollection", features: [] },
      meta: {
        queryMs: Math.round(performance.now() - started),
        dataVersion: null,
        backend: "memory",
        countries: [],
        country: null,
      },
    };
  }

  const countries = [country];

  // Spain map: PostGIS first (synced servAIS), live servAIS only when PostGIS is empty.
  if (country === "ES") {
    const postgis = await querySpainBboxFallback(
      west,
      south,
      east,
      north,
      profile,
      altitudeAgl,
      limit,
      started,
    );
    if (postgis.collection.features.length > 0) {
      return postgis;
    }
  }

  const provider = getProvider(country);
  try {
    const live = await provider.queryBbox(
      west,
      south,
      east,
      north,
      limit,
      altitudeAgl,
    );
    const features = filterCollection(live, profile, altitudeAgl).slice(0, limit);
    return {
      collection: { type: "FeatureCollection", features },
      meta: {
        queryMs: Math.round(performance.now() - started),
        dataVersion: new Date().toISOString().slice(0, 10),
        backend: backendLabelForCountry(country),
        country,
        countries,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[queryZonesInBbox] ${country} provider failed`,
      err,
    );
    return {
      collection: { type: "FeatureCollection", features: [] },
      meta: {
        queryMs: Math.round(performance.now() - started),
        dataVersion: null,
        backend: backendLabelForCountry(country),
        country,
        countries,
        providerError: message,
      },
    };
  }
}

export async function replaceSlicesForSource(
  source: ZoneSource,
  slices: ZoneSliceRecord[],
): Promise<number> {
  const available = await isDatabaseAvailable();

  if (!available) {
    return memoryZoneStore.replaceSource(source, slices);
  }

  const { sql: client } = getDb();
  await client`DELETE FROM uas_zone_slices WHERE source = ${source}`;

  const BATCH = 100;
  for (let i = 0; i < slices.length; i += BATCH) {
    const batch = slices.slice(i, i + BATCH);
    await client.begin(async (tx) => {
      for (const slice of batch) {
        const wkt = geoJsonToWkt(slice.geomGeoJson);
        const validFrom = slice.validFrom
          ? slice.validFrom.toISOString()
          : null;
        const validTo = slice.validTo ? slice.validTo.toISOString() : null;
        const ingestedAt =
          slice.ingestedAt instanceof Date
            ? slice.ingestedAt.toISOString()
            : new Date(slice.ingestedAt).toISOString();
        await tx`
          INSERT INTO uas_zone_slices (
            id, zone_identifier, name, source, restriction, reason, zone_type,
            lower_limit_m, upper_limit_m, lower_ref, upper_ref, properties,
            geom, geom_wkt, valid_from, valid_to, ingested_at
          ) VALUES (
            ${slice.id}::uuid,
            ${slice.zoneIdentifier},
            ${slice.name},
            ${slice.source}::zone_source,
            ${slice.restriction},
            ${slice.reason},
            ${slice.zoneType},
            ${slice.lowerLimitM},
            ${slice.upperLimitM},
            ${slice.lowerRef},
            ${slice.upperRef},
            ${JSON.stringify(slice.properties)}::jsonb,
            ST_SetSRID(ST_GeomFromText(${wkt}), 4326),
            ${wkt},
            ${validFrom},
            ${validTo},
            ${ingestedAt}
          )
        `;
      }
    });
    if ((i + BATCH) % 500 === 0 || i + BATCH >= slices.length) {
      console.log(
        `[ingest] ${source}: ${Math.min(i + BATCH, slices.length)}/${slices.length} slices`,
      );
    }
  }

  return slices.length;
}

export async function ingestFeatures(
  features: import("@canifly/middleware").UasZoneFeature[],
  source: ZoneSource,
): Promise<number> {
  const now = new Date();
  const slices = features.flatMap((f) => zoneFeatureToSlices(f, source, now));
  return replaceSlicesForSource(source, slices);
}

export async function getSliceCount(): Promise<{
  count: number;
  backend: "postgis" | "memory";
}> {
  if (!(await isDatabaseAvailable())) {
    return { count: memoryZoneStore.getCount(), backend: "memory" };
  }
  const { sql: client } = getDb();
  const rows = await client<{ c: number }[]>`
    SELECT COUNT(*)::int AS c FROM uas_zone_slices
  `;
  return { count: rows[0]?.c ?? 0, backend: "postgis" };
}
