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
  type CountryId,
  type DroneProfile,
  type MatchedZone,
  type StatusResult,
  type UasZoneFeature,
  type ZoneSliceRecord,
  type ZoneSource,
} from "@canifly/middleware";
import { getProvider } from "../geo/providers";

export interface QueryMeta {
  queryMs: number;
  dataVersion: string | null;
  backend: "servais" | "pansa" | "postgis" | "memory" | "multi";
  country?: CountryId | null;
  countries?: CountryId[];
}

interface RawSliceRow {
  zone_identifier: string;
  name: string;
  restriction: string;
  reason: string[] | null;
  source: ZoneSource;
  lower_limit_m: number;
  upper_limit_m: number;
  lower_ref: string;
  upper_ref: string;
  properties: UasZoneFeature;
  geom_geojson?: string | GeoJSON.Geometry;
}

function rowToMatchedZone(row: RawSliceRow): MatchedZone {
  const contact = row.properties?.zoneAuthority?.[0]?.email;
  const countryRaw = row.properties?.country;
  const country =
    countryRaw === "ESP" || countryRaw === "ES"
      ? "ES"
      : countryRaw === "POL" || countryRaw === "PL"
        ? "PL"
        : undefined;
  return {
    identifier: row.zone_identifier,
    name: row.name,
    restriction: row.restriction,
    reason: row.reason ?? [],
    source: row.source,
    country,
    lowerLimitM: row.lower_limit_m,
    upperLimitM: row.upper_limit_m,
    lowerRef: row.lower_ref,
    upperRef: row.upper_ref,
    contact,
    message: row.properties?.message,
  };
}

async function querySpainFallbacks(
  lat: number,
  lng: number,
  started: number,
): Promise<{ zones: MatchedZone[]; meta: QueryMeta } | null> {
  const available = await isDatabaseAvailable();
  if (available) {
    const { sql: client } = getDb();
    const rows = await client<RawSliceRow[]>`
      SELECT
        zone_identifier,
        name,
        restriction,
        reason,
        source,
        lower_limit_m,
        upper_limit_m,
        lower_ref,
        upper_ref,
        properties
      FROM uas_zone_slices
      WHERE ST_Intersects(
        geom,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
      )
      LIMIT 50
    `;

    const versionRows = await client<{ v: Date | null }[]>`
      SELECT MAX(ingested_at) AS v FROM uas_zone_slices
    `;

    if (rows.length > 0) {
      return {
        zones: rows.map(rowToMatchedZone),
        meta: {
          queryMs: Math.round(performance.now() - started),
          dataVersion: versionRows[0]?.v
            ? new Date(versionRows[0].v).toISOString().slice(0, 10)
            : null,
          backend: "postgis",
          country: "ES",
        },
      };
    }
  }

  const zones = memoryZoneStore.queryPoint(lat, lng).map((z) => ({
    ...z,
    country: z.country ?? "ES",
  }));
  return {
    zones,
    meta: {
      queryMs: Math.round(performance.now() - started),
      dataVersion: memoryZoneStore.getDataVersion(),
      backend: "memory",
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
    if (live.length > 0 || country === "PL") {
      return {
        zones: live,
        meta: {
          queryMs: Math.round(performance.now() - started),
          dataVersion: new Date().toISOString().slice(0, 10),
          backend: country === "PL" ? "pansa" : "servais",
          country,
        },
      };
    }
  } catch (err) {
    console.warn(
      `[queryPointIntersects] ${country} provider failed, falling back`,
      err,
    );
  }

  if (country === "ES") {
    const fallback = await querySpainFallbacks(lat, lng, started);
    if (fallback) return fallback;
  }

  return {
    zones: [],
    meta: {
      queryMs: Math.round(performance.now() - started),
      dataVersion: null,
      backend: country === "PL" ? "pansa" : "servais",
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
      reason: p.reason ?? [],
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
        mapStatus: "uas",
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
  const available = await isDatabaseAvailable();

  if (!available) {
    const raw = memoryZoneStore.queryBbox(west, south, east, north);
    return {
      collection: {
        type: "FeatureCollection",
        features: filterCollection(raw, profile, altitudeAgl),
      },
      meta: {
        queryMs: Math.round(performance.now() - started),
        dataVersion: memoryZoneStore.getDataVersion(),
        backend: "memory",
        country: "ES",
        countries: ["ES"],
      },
    };
  }

  const { sql: client } = getDb();
  const rows = await client<(RawSliceRow & { geom_geojson: string })[]>`
    SELECT
      zone_identifier,
      name,
      restriction,
      reason,
      source,
      lower_limit_m,
      upper_limit_m,
      lower_ref,
      upper_ref,
      properties,
      ST_AsGeoJSON(geom)::text AS geom_geojson
    FROM uas_zone_slices
    WHERE geom && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)
    LIMIT ${limit}
  `;

  const features: GeoJSON.Feature[] = [];
  for (const row of rows) {
    const zone = rowToMatchedZone(row);
    if (filterForMap([zone], profile, altitudeAgl).length === 0) continue;
    const geometry =
      typeof row.geom_geojson === "string"
        ? (JSON.parse(row.geom_geojson) as GeoJSON.Geometry)
        : row.geom_geojson;
    features.push({
      type: "Feature",
      geometry,
      properties: {
        identifier: zone.identifier,
        name: zone.name,
        restriction: zone.restriction,
        reason: zone.reason,
        source: zone.source,
        country: zone.country ?? "ES",
        lowerLimitM: zone.lowerLimitM,
        upperLimitM: zone.upperLimitM,
        lowerRef: zone.lowerRef,
        upperRef: zone.upperRef,
        message: zone.message,
        mapStatus: "uas",
      },
    });
  }

  const versionRows = await client<{ v: Date | null }[]>`
    SELECT MAX(ingested_at) AS v FROM uas_zone_slices
  `;

  return {
    collection: { type: "FeatureCollection", features },
    meta: {
      queryMs: Math.round(performance.now() - started),
      dataVersion: versionRows[0]?.v
        ? new Date(versionRows[0].v).toISOString().slice(0, 10)
        : null,
      backend: "postgis",
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
          backends.add(country === "PL" ? "pansa" : "servais");
          merged.push(...filterCollection(live, profile, altitudeAgl));
          return;
        }
      } catch (err) {
        console.warn(
          `[queryZonesInBbox] ${country} provider failed, falling back`,
          err,
        );
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
  await client.begin(async (tx) => {
    await tx`DELETE FROM uas_zone_slices WHERE source = ${source}`;
    for (const slice of slices) {
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

  return slices.length;
}

export async function ingestFeatures(
  features: UasZoneFeature[],
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
