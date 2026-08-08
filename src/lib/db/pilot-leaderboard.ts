import { getDb, isDatabaseAvailable } from "./client";
import { flights, obstacles } from "./schema";
import {
  displayName,
  progressForUserIds,
  type PilotProgressRow,
} from "./pilot-ranks";
import type { PilotRankId } from "../pilot-rank";

export type TopPilotByLevelRow = {
  id: string;
  name: string;
  avatarUrl: string | null;
  pinCount: number;
  /** Rank ladder index 1–10 (also exposed as `level` for older clients). */
  level: number;
  rankId: PilotRankId;
  /** Effective rank-hours (airtime + achievements). */
  hours: number;
  /** @deprecated hours*100 — kept for older clients */
  xp: number;
  rank: number;
};

/**
 * Top pilots by effective rank-hours (airtime + achievements / activity).
 */
export async function listTopPilotsByLevel(
  limit = 20,
): Promise<TopPilotByLevelRow[]> {
  if (!(await isDatabaseAvailable())) return [];
  const capped = Math.min(Math.max(1, Math.floor(limit)), 50);
  const { db } = getDb();

  const flightUserRows = await db
    .selectDistinct({ userId: flights.userId })
    .from(flights);
  const pinUserRows = await db
    .selectDistinct({ userId: obstacles.userId })
    .from(obstacles);

  const activeIds = [
    ...new Set([
      ...flightUserRows.map((r) => r.userId),
      ...pinUserRows.map((r) => r.userId),
    ]),
  ];
  if (activeIds.length === 0) return [];

  const byUser = await progressForUserIds(activeIds);
  const scored: Omit<TopPilotByLevelRow, "rank">[] = [];

  for (const row of byUser.values()) {
    if (row.progress.hours <= 0 && row.pinCount <= 0) continue;
    scored.push(toTopPilotRow(row));
  }

  scored.sort((a, b) => {
    if (b.hours !== a.hours) return b.hours - a.hours;
    if (b.level !== a.level) return b.level - a.level;
    return a.id.localeCompare(b.id);
  });

  return scored.slice(0, capped).map((row, i) => ({
    ...row,
    rank: i + 1,
  }));
}

function toTopPilotRow(row: PilotProgressRow): Omit<TopPilotByLevelRow, "rank"> {
  const { progress } = row;
  return {
    id: row.id,
    name: displayName(row.name, row.email),
    avatarUrl: row.avatarUrl,
    pinCount: row.pinCount,
    level: progress.rank.index,
    rankId: progress.rank.id,
    hours: progress.hours,
    xp: Math.round(progress.hours * 100),
  };
}
