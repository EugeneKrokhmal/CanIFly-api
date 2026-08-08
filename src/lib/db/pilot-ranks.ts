import { inArray } from "drizzle-orm";
import { getDb } from "./client";
import { flights, obstacles, users } from "./schema";
import { computePilotBadges } from "../badges";
import {
  computePilotProgress,
  type PilotRankId,
} from "../pilot-rank";

export type PilotProgressRow = {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  pinCount: number;
  progress: ReturnType<typeof computePilotProgress>;
};

function displayName(name: string | null | undefined, email?: string | null) {
  const n = name?.trim();
  if (n) return n;
  if (email) return email.split("@")[0] || "Pilot";
  return "Pilot";
}

/**
 * Shared aggregation: flights + pins + badges → computePilotProgress per user.
 */
export async function progressForUserIds(
  userIds: string[],
): Promise<Map<string, PilotProgressRow>> {
  const out = new Map<string, PilotProgressRow>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return out;

  const { db } = getDb();

  const profiles = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      operatorNumber: users.operatorNumber,
      bio: users.bio,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(inArray(users.id, ids));

  const flightRows = await db
    .select({
      userId: flights.userId,
      startedAt: flights.startedAt,
      durationS: flights.durationS,
      distanceM: flights.distanceM,
      maxHeightM: flights.maxHeightM,
      trackCoordinates: flights.trackCoordinates,
    })
    .from(flights)
    .where(inArray(flights.userId, ids));

  const pinRows = await db
    .select({
      userId: obstacles.userId,
      kind: obstacles.kind,
      photoUrl: obstacles.photoUrl,
      createdAt: obstacles.createdAt,
    })
    .from(obstacles)
    .where(inArray(obstacles.userId, ids));

  const flightsByUser = new Map<string, typeof flightRows>();
  for (const f of flightRows) {
    const list = flightsByUser.get(f.userId) ?? [];
    list.push(f);
    flightsByUser.set(f.userId, list);
  }

  const pinsByUser = new Map<string, typeof pinRows>();
  for (const p of pinRows) {
    const list = pinsByUser.get(p.userId) ?? [];
    list.push(p);
    pinsByUser.set(p.userId, list);
  }

  for (const profile of profiles) {
    const userFlights = flightsByUser.get(profile.id) ?? [];
    const userPins = pinsByUser.get(profile.id) ?? [];
    const badgeFlights = userFlights.map((f) => ({
      startedAt: f.startedAt,
      durationS: f.durationS ?? 0,
      distanceM: f.distanceM ?? 0,
      maxHeightM: f.maxHeightM,
      hasTrack: Boolean(
        f.trackCoordinates &&
          Array.isArray(f.trackCoordinates) &&
          f.trackCoordinates.length >= 2,
      ),
    }));
    const badgePins = userPins.map((p) => ({
      kind: p.kind,
      photoUrl: p.photoUrl,
      createdAt: p.createdAt,
    }));
    const badges = computePilotBadges({
      pilot: {
        operatorNumber: profile.operatorNumber,
        avatarUrl: profile.avatarUrl,
        bio: profile.bio,
        createdAt: profile.createdAt,
      },
      flights: badgeFlights,
      pins: badgePins,
    });
    const progress = computePilotProgress({
      flightCount: userFlights.length,
      totalDistanceM: badgeFlights.reduce((s, f) => s + f.distanceM, 0),
      totalDurationS: badgeFlights.reduce((s, f) => s + f.durationS, 0),
      pinCount: userPins.length,
      flySpotCount: userPins.filter((p) => p.kind === "fly_spot").length,
      badgeCount: badges.filter((b) => b.earned).length,
      hasOperator: Boolean(profile.operatorNumber?.trim()),
    });
    out.set(profile.id, {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      pinCount: userPins.length,
      progress,
    });
  }

  return out;
}

/** Map userId → rank id (defaults to student). */
export async function ranksForUserIds(
  userIds: string[],
): Promise<Map<string, PilotRankId>> {
  const progress = await progressForUserIds(userIds);
  const out = new Map<string, PilotRankId>();
  for (const id of new Set(userIds.filter(Boolean))) {
    out.set(id, progress.get(id)?.progress.rank.id ?? "student");
  }
  return out;
}

export { displayName };
