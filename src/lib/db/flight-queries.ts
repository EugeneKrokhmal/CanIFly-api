import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "./client";
import { flights, users, type FlightRow, type NewFlight } from "./schema";
import {
  startedAtFromFileName,
  trackDistanceM,
} from "../flights/decode-dji";
import {
  flightStartAltitudeM,
  flightTrackFeatures,
} from "../flights/track-geo";
import { ranksForUserIds } from "./pilot-ranks";
import type { PilotRankId } from "../pilot-rank";

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Fix rows stored before camelCase detail parsing / with empty stats. */
export function enrichFlightRow(f: FlightRow): FlightRow {
  const d = (f.rawDetails ?? {}) as Record<string, unknown>;
  const last = (d._lastOsd ?? {}) as Record<string, unknown>;
  const durationS =
    (f.durationS > 0 ? f.durationS : null) ??
    num(d.totalTime, d.total_time, last.flyTime, last.totalTime) ??
    0;
  const fromTrack = trackDistanceM(f.trackCoordinates);
  const distanceM =
    (f.distanceM > 0 ? f.distanceM : null) ??
    num(d.totalDistance, d.total_distance, last.cumulativeDistance) ??
    fromTrack;
  const aircraftName =
    f.aircraftName ??
    str(d.aircraftName, d.aircraft_name) ??
    null;
  const maxHeightM =
    f.maxHeightM ??
    num(d.maxHeight, d.max_height, last.heightMax) ??
    null;
  const maxHSpeedMps =
    f.maxHSpeedMps ??
    num(d.maxHorizontalSpeed, d.max_horizontal_speed, last.hSpeedMax) ??
    null;

  const fromDetails = str(d.startTime, d.start_time);
  const detailsStarted =
    fromDetails && Number.isFinite(new Date(fromDetails).getTime())
      ? new Date(fromDetails)
      : null;
  const fromFile = f.sourceFileName
    ? startedAtFromFileName(f.sourceFileName)
    : null;
  // Prefer DJI startTime → filename stamp when present (upload-time fallback was wrong).
  const startedAt = detailsStarted ?? fromFile ?? f.startedAt;

  return {
    ...f,
    durationS,
    distanceM,
    aircraftName,
    maxHeightM,
    maxHSpeedMps,
    startedAt,
  };
}

export async function insertFlight(row: NewFlight): Promise<FlightRow> {
  const { db } = getDb();
  const [created] = await db.insert(flights).values(row).returning();
  if (!created) throw new Error("insertFlight returned no row");
  return created;
}

export async function findFlightByUserHash(
  userId: string,
  contentHash: string,
): Promise<FlightRow | null> {
  const { db } = getDb();
  const [row] = await db
    .select()
    .from(flights)
    .where(
      and(eq(flights.userId, userId), eq(flights.contentHash, contentHash)),
    )
    .limit(1);
  return row ?? null;
}

export async function listFlightsByUser(
  userId: string,
  limit = 100,
): Promise<FlightRow[]> {
  const { db } = getDb();
  const rows = await db
    .select()
    .from(flights)
    .where(eq(flights.userId, userId))
    .orderBy(desc(flights.startedAt))
    .limit(limit);
  return rows.map(enrichFlightRow);
}

export async function getFlightById(id: string): Promise<FlightRow | null> {
  const { db } = getDb();
  const [row] = await db.select().from(flights).where(eq(flights.id, id)).limit(1);
  return row ? enrichFlightRow(row) : null;
}

export async function deleteFlightByOwner(
  id: string,
  userId: string,
): Promise<boolean> {
  const { db } = getDb();
  const deleted = await db
    .delete(flights)
    .where(and(eq(flights.id, id), eq(flights.userId, userId)))
    .returning({ id: flights.id });
  return deleted.length > 0;
}

export type FlightFeatureProps = {
  id: string;
  userId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  authorRankId: PilotRankId;
  aircraftName: string | null;
  startedAt: string;
  durationS: number;
  distanceM: number;
  maxHeightM: number | null;
  maxHSpeedMps: number | null;
  hasTrack: boolean;
  startLat: number | null;
  startLng: number | null;
};

export async function queryFlightsInBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  limit = 200,
  userId?: string,
): Promise<GeoJSON.FeatureCollection> {
  const { db } = getDb();
  const conds = [
    sql`${flights.startLat} IS NOT NULL`,
    sql`${flights.startLng} IS NOT NULL`,
    gte(flights.startLng, west),
    lte(flights.startLng, east),
    gte(flights.startLat, south),
    lte(flights.startLat, north),
  ];
  if (userId) conds.push(eq(flights.userId, userId));

  const rows = await db
    .select({
      flight: flights,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(flights)
    .innerJoin(users, eq(users.id, flights.userId))
    .where(and(...conds))
    .orderBy(desc(flights.startedAt))
    .limit(limit);

  const rankByUser = await ranksForUserIds(rows.map((r) => r.flight.userId));

  const features: GeoJSON.Feature[] = [];
  for (const { flight: raw, authorName, authorAvatarUrl } of rows) {
    const f = enrichFlightRow(raw);
    const props: FlightFeatureProps = {
      id: f.id,
      userId: f.userId,
      authorName: authorName || "Pilot",
      authorAvatarUrl: authorAvatarUrl ?? null,
      authorRankId: rankByUser.get(f.userId) ?? "student",
      aircraftName: f.aircraftName,
      startedAt: f.startedAt.toISOString(),
      durationS: f.durationS,
      distanceM: f.distanceM,
      maxHeightM: f.maxHeightM,
      maxHSpeedMps: f.maxHSpeedMps,
      hasTrack: Boolean(f.trackCoordinates && f.trackCoordinates.length >= 2),
      startLat: f.startLat,
      startLng: f.startLng,
    };

    if (f.trackCoordinates && f.trackCoordinates.length >= 2) {
      const startAlt = flightStartAltitudeM(f.trackCoordinates);
      features.push(
        ...flightTrackFeatures(f.trackCoordinates, {
          ...props,
          altitudeM: startAlt,
        }),
      );
      if (f.startLat != null && f.startLng != null) {
        features.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [f.startLng, f.startLat],
          },
          properties: {
            ...props,
            altitudeM: startAlt,
            hasAltitude: startAlt != null,
          },
        });
      }
    } else if (f.startLat != null && f.startLng != null) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [f.startLng, f.startLat],
        },
        properties: {
          ...props,
          altitudeM: null,
          hasAltitude: false,
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}

export function flightSummaryJson(f: FlightRow) {
  const e = enrichFlightRow(f);
  return {
    id: e.id,
    source: e.source,
    sourceFileName: e.sourceFileName,
    startedAt: e.startedAt.toISOString(),
    durationS: e.durationS,
    distanceM: e.distanceM,
    maxHeightM: e.maxHeightM,
    maxHSpeedMps: e.maxHSpeedMps,
    aircraftName: e.aircraftName,
    startLat: e.startLat,
    startLng: e.startLng,
    hasTrack: Boolean(e.trackCoordinates && e.trackCoordinates.length >= 2),
    createdAt: e.createdAt.toISOString(),
  };
}
