import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb, isDatabaseAvailable } from "./client";
import {
  obstacles,
  obstacleVotes,
  users,
  type ObstacleRow,
  type NewObstacle,
} from "./schema";
import type { ObstacleType } from "../obstacles/labels";

export type ObstacleVoteValue = "up" | "down";

export function isObstacleInactive(likes: number, dislikes: number): boolean {
  const total = likes + dislikes;
  if (total <= 0) return false;
  return dislikes / total > 0.5;
}

function displayName(name: string | null | undefined, email?: string | null) {
  const n = name?.trim();
  if (n) return n;
  if (email) return email.split("@")[0] || "Pilot";
  return "Pilot";
}

function toFeature(row: {
  id: string;
  userId: string;
  type: ObstacleType;
  lat: number;
  lng: number;
  heightM: number;
  message: string | null;
  photoUrl: string | null;
  createdAt: Date;
  authorName: string | null;
  authorEmail: string | null;
  likes: number;
  dislikes: number;
  myVote: ObstacleVoteValue | null;
}): GeoJSON.Feature {
  const inactive = isObstacleInactive(row.likes, row.dislikes);
  return {
    type: "Feature",
    id: row.id,
    geometry: {
      type: "Point",
      coordinates: [row.lng, row.lat],
    },
    properties: {
      id: row.id,
      userId: row.userId,
      type: row.type,
      heightM: row.heightM,
      message: row.message,
      photoUrl: row.photoUrl,
      authorName: displayName(row.authorName, row.authorEmail),
      createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
      likes: row.likes,
      dislikes: row.dislikes,
      myVote: row.myVote,
      inactive: inactive ? 1 : 0,
    },
  };
}

async function voteTallies(
  obstacleIds: string[],
  viewerUserId?: string | null,
): Promise<
  Map<
    string,
    { likes: number; dislikes: number; myVote: ObstacleVoteValue | null }
  >
> {
  const map = new Map<
    string,
    { likes: number; dislikes: number; myVote: ObstacleVoteValue | null }
  >();
  for (const id of obstacleIds) {
    map.set(id, { likes: 0, dislikes: 0, myVote: null });
  }
  if (obstacleIds.length === 0) return map;

  const { db } = getDb();
  const counts = await db
    .select({
      obstacleId: obstacleVotes.obstacleId,
      value: obstacleVotes.value,
      count: sql<number>`count(*)::int`,
    })
    .from(obstacleVotes)
    .where(inArray(obstacleVotes.obstacleId, obstacleIds))
    .groupBy(obstacleVotes.obstacleId, obstacleVotes.value);

  for (const row of counts) {
    const entry = map.get(row.obstacleId);
    if (!entry) continue;
    const n = Number(row.count) || 0;
    if (row.value === "up") entry.likes = n;
    else entry.dislikes = n;
  }

  if (viewerUserId) {
    const mine = await db
      .select({
        obstacleId: obstacleVotes.obstacleId,
        value: obstacleVotes.value,
      })
      .from(obstacleVotes)
      .where(
        and(
          inArray(obstacleVotes.obstacleId, obstacleIds),
          eq(obstacleVotes.userId, viewerUserId),
        ),
      );
    for (const row of mine) {
      const entry = map.get(row.obstacleId);
      if (entry) entry.myVote = row.value;
    }
  }

  return map;
}

export async function insertObstacle(
  input: NewObstacle,
): Promise<ObstacleRow | null> {
  if (!(await isDatabaseAvailable())) return null;
  const { db } = getDb();
  const [row] = await db.insert(obstacles).values(input).returning();
  return row ?? null;
}

export async function queryObstaclesInBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  limit = 500,
  viewerUserId?: string | null,
): Promise<GeoJSON.FeatureCollection> {
  if (!(await isDatabaseAvailable())) {
    return { type: "FeatureCollection", features: [] };
  }

  const { db } = getDb();
  const rows = await db
    .select({
      id: obstacles.id,
      userId: obstacles.userId,
      type: obstacles.type,
      lat: obstacles.lat,
      lng: obstacles.lng,
      heightM: obstacles.heightM,
      message: obstacles.message,
      photoUrl: obstacles.photoUrl,
      createdAt: obstacles.createdAt,
      authorName: users.name,
      authorEmail: users.email,
    })
    .from(obstacles)
    .leftJoin(users, eq(obstacles.userId, users.id))
    .where(
      and(
        gte(obstacles.lng, west),
        lte(obstacles.lng, east),
        gte(obstacles.lat, south),
        lte(obstacles.lat, north),
      ),
    )
    .orderBy(desc(obstacles.createdAt))
    .limit(limit);

  const tallies = await voteTallies(
    rows.map((r) => r.id),
    viewerUserId,
  );

  return {
    type: "FeatureCollection",
    features: rows.map((row) => {
      const t = tallies.get(row.id) ?? {
        likes: 0,
        dislikes: 0,
        myVote: null,
      };
      return toFeature({ ...row, ...t, type: row.type as ObstacleType });
    }),
  };
}

export async function getObstacleVoteSummary(
  obstacleId: string,
  viewerUserId?: string | null,
): Promise<{
  likes: number;
  dislikes: number;
  myVote: ObstacleVoteValue | null;
  inactive: boolean;
} | null> {
  if (!(await isDatabaseAvailable())) return null;
  const { db } = getDb();
  const [exists] = await db
    .select({ id: obstacles.id, userId: obstacles.userId })
    .from(obstacles)
    .where(eq(obstacles.id, obstacleId))
    .limit(1);
  if (!exists) return null;

  const tallies = await voteTallies([obstacleId], viewerUserId);
  const t = tallies.get(obstacleId) ?? {
    likes: 0,
    dislikes: 0,
    myVote: null,
  };
  return {
    ...t,
    inactive: isObstacleInactive(t.likes, t.dislikes),
  };
}

export async function getObstacleOwnerId(
  obstacleId: string,
): Promise<string | null> {
  if (!(await isDatabaseAvailable())) return null;
  const { db } = getDb();
  const [row] = await db
    .select({ userId: obstacles.userId })
    .from(obstacles)
    .where(eq(obstacles.id, obstacleId))
    .limit(1);
  return row?.userId ?? null;
}

/** Upsert vote, or remove if value is null / same value toggled off by caller. */
export async function setObstacleVote(
  obstacleId: string,
  userId: string,
  value: ObstacleVoteValue | null,
): Promise<{
  likes: number;
  dislikes: number;
  myVote: ObstacleVoteValue | null;
  inactive: boolean;
} | null> {
  if (!(await isDatabaseAvailable())) return null;
  const { db } = getDb();

  const ownerId = await getObstacleOwnerId(obstacleId);
  if (!ownerId) return null;
  if (ownerId === userId) {
    throw new Error("OWN_OBSTACLE");
  }

  if (value === null) {
    await db
      .delete(obstacleVotes)
      .where(
        and(
          eq(obstacleVotes.obstacleId, obstacleId),
          eq(obstacleVotes.userId, userId),
        ),
      );
  } else {
    await db
      .insert(obstacleVotes)
      .values({
        obstacleId,
        userId,
        value,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [obstacleVotes.obstacleId, obstacleVotes.userId],
        set: { value, updatedAt: new Date() },
      });
  }

  return getObstacleVoteSummary(obstacleId, userId);
}

export async function getPilotProfile(userId: string): Promise<{
  id: string;
  name: string;
  operatorNumber: string | null;
  bio: string | null;
  avatarUrl: string | null;
  createdAt: Date;
} | null> {
  if (!(await isDatabaseAvailable())) return null;
  const { db } = getDb();
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      operatorNumber: users.operatorNumber,
      bio: users.bio,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: displayName(row.name, row.email),
    operatorNumber: row.operatorNumber,
    bio: row.bio,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
  };
}

export async function listObstaclesByUser(
  userId: string,
  limit = 100,
): Promise<
  Array<{
    id: string;
    type: ObstacleType;
    lat: number;
    lng: number;
    heightM: number;
    message: string | null;
    photoUrl: string | null;
    createdAt: Date;
  }>
> {
  if (!(await isDatabaseAvailable())) return [];
  const { db } = getDb();
  return db
    .select({
      id: obstacles.id,
      type: obstacles.type,
      lat: obstacles.lat,
      lng: obstacles.lng,
      heightM: obstacles.heightM,
      message: obstacles.message,
      photoUrl: obstacles.photoUrl,
      createdAt: obstacles.createdAt,
    })
    .from(obstacles)
    .where(eq(obstacles.userId, userId))
    .orderBy(desc(obstacles.createdAt))
    .limit(limit);
}

export async function deleteObstacleByOwner(
  id: string,
  userId: string,
): Promise<ObstacleRow | null> {
  if (!(await isDatabaseAvailable())) return null;
  const { db } = getDb();
  const deleted = await db
    .delete(obstacles)
    .where(and(eq(obstacles.id, id), eq(obstacles.userId, userId)))
    .returning();
  return deleted[0] ?? null;
}
