import { getDb, isDatabaseAvailable } from "./client";
import { memoryZoneStore } from "./memory-store";
import {
  classifyStatus,
  filterByProfile,
  filterForMap,
  geoJsonToWkt,
  zoneFeatureToSlices,
  type DroneProfile,
  type MatchedZone,
  type StatusResult,
  type UasZoneFeature,
  type ZoneSliceRecord,
  type ZoneSource,
} from "@canifly/middleware";
import {
  queryServaisBbox,
  queryServaisPoint,
} from "../geo/enaire-client";

export interface QueryMeta {
  queryMs: number;
  dataVersion: string | null;
  backend: "servais" | "postgis" | "memory";
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
  return {
    identifier: row.zone_identifier,
    name: row.name,
    restriction: row.restriction,
    reason: row.reason ?? [],
    source: row.source,
    lowerLimitM: row.lower_limit_m,
    upperLimitM: row.upper_limit_m,
    lowerRef: row.lower_ref,
    upperRef: row.upper_ref,
    contact,
    message: row.properties?.message,
  };
}

export async function queryPointIntersects(
  lat: number,
  lng: number,
): Promise<{ zones: MatchedZone[]; meta: QueryMeta }> {
  const started = performance.now();

  try {
    const live = await queryServaisPoint(lat, lng);
    if (live.length > 0) {
      return {
        zones: live,
        meta: {
          queryMs: Math.round(performance.now() - started),
          dataVersion: new Date().toISOString().slice(0, 10),
          backend: "servais",
        },
      };
    }
  } catch (err) {
    console.warn("[queryPointIntersects] servAIS failed, falling back", err);
  }

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
        },
      };
    }
  }

  const zones = memoryZoneStore.queryPoint(lat, lng);
  return {
    zones,
    meta: {
      queryMs: Math.round(performance.now() - started),
      dataVersion: memoryZoneStore.getDataVersion(),
      backend: "memory",
    },
  };
}

export async function evaluateAirspaceStatus(
  lat: number,
  lng: number,
  profile: DroneProfile,
  altitudeAgl: number,
): Promise<{ result: StatusResult; meta: QueryMeta }> {
  const { zones, meta } = await queryPointIntersects(lat, lng);
  const filtered = filterByProfile(zones, profile, altitudeAgl);
  const result = classifyStatus(filtered, { ceilingAgl: altitudeAgl });
  return { result, meta };
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

  const filterCollection = (
    raw: GeoJSON.FeatureCollection,
  ): GeoJSON.Feature[] => {
    const seen = new Set<string>();
    const out: GeoJSON.Feature[] = [];
    for (const f of raw.features) {
      const p = (f.properties ?? {}) as {
        restriction?: string;
        reason?: string[];
        source?: ZoneSource;
        lowerLimitM?: number;
        upperLimitM?: number;
        lowerRef?: string;
        upperRef?: string;
        identifier?: string;
        name?: string;
        message?: string;
      };
      const id = String(p.identifier ?? "");
      if (id && seen.has(id)) continue;
      const zone: MatchedZone = {
        identifier: id,
        name: String(p.name ?? ""),
        restriction: String(p.restriction ?? ""),
        reason: p.reason ?? [],
        source: (p.source ?? "fixture") as ZoneSource,
        lowerLimitM: Number(p.lowerLimitM ?? 0),
        upperLimitM: Number(p.upperLimitM ?? 120),
        lowerRef: String(p.lowerRef ?? "AGL"),
        upperRef: String(p.upperRef ?? "AGL"),
        message: p.message,
      };
      if (filterForMap([zone], profile, altitudeAgl).length === 0) continue;
      if (id) seen.add(id);
      out.push({
        ...f,
        properties: {
          ...f.properties,
          mapStatus: "uas",
        },
      });
    }
    return out;
  };

  try {
    const live = await queryServaisBbox(west, south, east, north, limit);
    if (live.features.length > 0) {
      return {
        collection: {
          type: "FeatureCollection",
          features: filterCollection(live),
        },
        meta: {
          queryMs: Math.round(performance.now() - started),
          dataVersion: new Date().toISOString().slice(0, 10),
          backend: "servais",
        },
      };
    }
  } catch (err) {
    console.warn("[queryZonesInBbox] servAIS failed, falling back", err);
  }

  const available = await isDatabaseAvailable();

  if (!available) {
    const raw = memoryZoneStore.queryBbox(west, south, east, north);
    return {
      collection: {
        type: "FeatureCollection",
        features: filterCollection(raw),
      },
      meta: {
        queryMs: Math.round(performance.now() - started),
        dataVersion: memoryZoneStore.getDataVersion(),
        backend: "memory",
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
