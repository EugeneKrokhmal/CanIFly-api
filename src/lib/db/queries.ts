import { getDb, isDatabaseAvailable } from "./client";
import { memoryZoneStore } from "./memory-store";
import {
  classifyStatus,
  countriesForBbox,
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
import { backendLabelForCountry, getProvider } from "../geo/providers";
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
  backend: "servais" | "pansa" | "aimgis" | "dipul" | "postgis" | "memory" | "multi";
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
    if (live.length > 0 || country === "PL" || country === "CZ" || country === "DE") {
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
    if (country === "PL" || country === "CZ" || country === "DE") {
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
  const countries = countriesForBbox({ west, south, east, north });

  if (countries.length === 0) {
    return {
      collection: { type: "FeatureCollection", features: [] },
      meta: {
        queryMs: Math.round(performance.now() - started),
        dataVersion: null,
        backend: "memory",
        countries: [],
      },
    };
  }

  const perCountryLimit = Math.max(50, Math.ceil(limit / countries.length));
  const merged: GeoJSON.Feature[] = [];
  const backends = new Set<string>();
  let providerError: string | undefined;

  await Promise.all(
    countries.map(async (country) => {
      const provider = getProvider(country);
      try {
        const live = await provider.queryBbox(
          west,
          south,
          east,
          north,
          perCountryLimit,
          altitudeAgl,
        );
        if (live.features.length > 0) {
          backends.add(backendLabelForCountry(country));
          merged.push(...filterCollection(live, profile, altitudeAgl));
          return;
        }
        // Empty success still counts as the live/primary backend for PL/CZ.
        if (country === "PL" || country === "CZ" || country === "DE") {
          backends.add(backendLabelForCountry(country));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[queryZonesInBbox] ${country} provider failed, falling back`,
          err,
        );
        if (country === "PL" || country === "CZ" || country === "DE") {
          backends.add(backendLabelForCountry(country));
          providerError = message;
        }
      }
      if (country === "ES") {
        const fallback = await querySpainBboxFallback(
          west,
          south,
          east,
          north,
          profile,
          altitudeAgl,
          perCountryLimit,
          started,
        );
        backends.add(fallback.meta.backend);
        merged.push(...fallback.collection.features);
      }
    }),
  );

  const seen = new Set<string>();
  const features: GeoJSON.Feature[] = [];
  for (const f of merged) {
    const p = (f.properties ?? {}) as { identifier?: string; country?: string };
    const key = `${p.country ?? ""}:${p.identifier ?? ""}`;
    if (p.identifier && seen.has(key)) continue;
    if (p.identifier) seen.add(key);
    features.push(f);
    if (features.length >= limit) break;
  }

  const backendList = [...backends];
  const backend: QueryMeta["backend"] =
    backendList.length > 1
      ? "multi"
      : backendList[0] === "pansa"
        ? "pansa"
        : backendList[0] === "servais"
          ? "servais"
          : backendList[0] === "aimgis"
            ? "aimgis"
            : backendList[0] === "dipul"
              ? "dipul"
              : backendList[0] === "postgis"
                ? "postgis"
                : "memory";

  return {
    collection: { type: "FeatureCollection", features },
    meta: {
      queryMs: Math.round(performance.now() - started),
      dataVersion: new Date().toISOString().slice(0, 10),
      backend,
      countries,
      ...(providerError ? { providerError } : {}),
    },
  };
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
