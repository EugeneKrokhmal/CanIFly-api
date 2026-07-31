import {
  type CountryId,
  type MatchedZone,
  type UasZoneFeature,
  type ZoneSource,
} from "@canifly/middleware";
import { getDb, isDatabaseAvailable } from "../db/client";
import { memoryZoneStore } from "../db/memory-store";

interface RawSliceRow {
  id?: string;
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

export function rowToMatchedZone(
  row: RawSliceRow,
  fallbackCountry?: CountryId,
): MatchedZone {
  const contact = row.properties?.zoneAuthority?.[0]?.email;
  const countryRaw = (row.properties?.country ?? "").toUpperCase();
  let country: CountryId | undefined;
  if (countryRaw === "ESP" || countryRaw === "ES") country = "ES";
  else if (countryRaw === "CZE" || countryRaw === "CZ") country = "CZ";
  else if (countryRaw === "POL" || countryRaw === "PL") country = "PL";
  else if (countryRaw === "DEU" || countryRaw === "DE") country = "DE";
  else if (row.source === "anscr") country = "CZ";
  else if (row.source === "dipul") country = "DE";
  else if (
    row.source === "aero" ||
    row.source === "urbano" ||
    row.source === "infra" ||
    row.source === "servais"
  ) {
    country = "ES";
  } else if (fallbackCountry) {
    country = fallbackCountry;
  }

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

export async function queryPostgisPoint(
  lat: number,
  lng: number,
  options: {
    source?: ZoneSource;
    fallbackCountry?: CountryId;
    limit?: number;
  } = {},
): Promise<{
  zones: MatchedZone[];
  dataVersion: string | null;
  backend: "postgis" | "memory";
}> {
  const limit = options.limit ?? 50;
  const available = await isDatabaseAvailable();

  if (available) {
    const { sql: client } = getDb();
    const rows = options.source
      ? await client<RawSliceRow[]>`
          SELECT
            zone_identifier, name, restriction, reason, source,
            lower_limit_m, upper_limit_m, lower_ref, upper_ref, properties
          FROM uas_zone_slices
          WHERE source = ${options.source}
            AND ST_Intersects(
              geom,
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
            )
          LIMIT ${limit}
        `
      : await client<RawSliceRow[]>`
          SELECT
            zone_identifier, name, restriction, reason, source,
            lower_limit_m, upper_limit_m, lower_ref, upper_ref, properties
          FROM uas_zone_slices
          WHERE ST_Intersects(
            geom,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
          )
          LIMIT ${limit}
        `;

    const versionRows = options.source
      ? await client<{ v: Date | null }[]>`
          SELECT MAX(ingested_at) AS v FROM uas_zone_slices
          WHERE source = ${options.source}
        `
      : await client<{ v: Date | null }[]>`
          SELECT MAX(ingested_at) AS v FROM uas_zone_slices
        `;

    return {
      zones: rows.map((r) => rowToMatchedZone(r, options.fallbackCountry)),
      dataVersion: versionRows[0]?.v
        ? new Date(versionRows[0].v).toISOString().slice(0, 10)
        : null,
      backend: "postgis",
    };
  }

  const zones = memoryZoneStore
    .queryPoint(lat, lng)
    .filter((z) => (options.source ? z.source === options.source : true))
    .map((z) => ({
      ...z,
      country: z.country ?? options.fallbackCountry,
    }));

  return {
    zones,
    dataVersion: memoryZoneStore.getDataVersion(),
    backend: "memory",
  };
}

export async function queryPostgisBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  options: {
    source?: ZoneSource;
    fallbackCountry?: CountryId;
    limit?: number;
  } = {},
): Promise<{
  features: GeoJSON.Feature[];
  dataVersion: string | null;
  backend: "postgis" | "memory";
}> {
  const limit = options.limit ?? 500;
  const available = await isDatabaseAvailable();

  if (!available) {
    const raw = memoryZoneStore.queryBbox(west, south, east, north);
    const features = raw.features.filter((f) => {
      if (!options.source) return true;
      return (f.properties as { source?: string } | null)?.source === options.source;
    });
    return {
      features,
      dataVersion: memoryZoneStore.getDataVersion(),
      backend: "memory",
    };
  }

  const { sql: client } = getDb();
  const rows = options.source
    ? await client<(RawSliceRow & { geom_geojson: string })[]>`
        SELECT
          id::text AS id, zone_identifier, name, restriction, reason, source,
          lower_limit_m, upper_limit_m, lower_ref, upper_ref, properties,
          ST_AsGeoJSON(geom)::text AS geom_geojson
        FROM uas_zone_slices
        WHERE source = ${options.source}
          AND geom && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)
          AND name NOT LIKE 'Grid CTR%'
          AND name NOT LIKE 'Grid ATZ%'
          AND name NOT LIKE 'Hustě osídlený%'
        ORDER BY ST_NPoints(geom) DESC NULLS LAST
        LIMIT ${limit}
      `
    : await client<(RawSliceRow & { geom_geojson: string })[]>`
        SELECT
          id::text AS id, zone_identifier, name, restriction, reason, source,
          lower_limit_m, upper_limit_m, lower_ref, upper_ref, properties,
          ST_AsGeoJSON(geom)::text AS geom_geojson
        FROM uas_zone_slices
        WHERE geom && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)
          AND name NOT LIKE 'Grid CTR%'
          AND name NOT LIKE 'Grid ATZ%'
          AND name NOT LIKE 'Hustě osídlený%'
        ORDER BY ST_NPoints(geom) DESC NULLS LAST
        LIMIT ${limit}
      `;

  const features: GeoJSON.Feature[] = [];
  for (const row of rows) {
    const zone = rowToMatchedZone(row, options.fallbackCountry);
    const geometry =
      typeof row.geom_geojson === "string"
        ? (JSON.parse(row.geom_geojson) as GeoJSON.Geometry)
        : row.geom_geojson;
    features.push({
      type: "Feature",
      id: row.id ?? `${zone.identifier}:${zone.lowerLimitM}:${zone.upperLimitM}`,
      geometry,
      properties: {
        identifier: zone.identifier,
        name: zone.name,
        restriction: zone.restriction,
        reason: zone.reason,
        source: zone.source,
        country: zone.country ?? options.fallbackCountry ?? null,
        lowerLimitM: zone.lowerLimitM,
        upperLimitM: zone.upperLimitM,
        lowerRef: zone.lowerRef,
        upperRef: zone.upperRef,
        message: zone.message,
        mapStatus: "uas",
      },
    });
  }

  const versionRows = options.source
    ? await client<{ v: Date | null }[]>`
        SELECT MAX(ingested_at) AS v FROM uas_zone_slices
        WHERE source = ${options.source}
      `
    : await client<{ v: Date | null }[]>`
        SELECT MAX(ingested_at) AS v FROM uas_zone_slices
      `;

  return {
    features,
    dataVersion: versionRows[0]?.v
      ? new Date(versionRows[0].v).toISOString().slice(0, 10)
      : null,
    backend: "postgis",
  };
}
