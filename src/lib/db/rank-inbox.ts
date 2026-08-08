import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { PILOT_RANKS, rankDefById, type PilotRankId } from "../pilot-rank";
import { getDb } from "./client";
import { progressForUserIds } from "./pilot-ranks";
import { userMessages, users } from "./schema";

const RANK_UP = "rank_up";

function isPilotRankId(id: string | null | undefined): id is PilotRankId {
  return Boolean(id && PILOT_RANKS.some((r) => r.id === id));
}

/**
 * Baselining / rank-up detection for the server inbox.
 * - first call: set last_notified_rank_id to current (no messages)
 * - later: insert one rank_up message per newly reached rank
 */
export async function syncRankInbox(userId: string): Promise<void> {
  const map = await progressForUserIds([userId]);
  const currentId = map.get(userId)?.progress.rank.id ?? "student";
  const current = rankDefById(currentId);

  const { db } = getDb();
  const [row] = await db
    .select({ lastNotifiedRankId: users.lastNotifiedRankId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) return;

  const prevId = row.lastNotifiedRankId;
  if (prevId == null) {
    await db
      .update(users)
      .set({ lastNotifiedRankId: current.id })
      .where(eq(users.id, userId));
    return;
  }

  const prev = isPilotRankId(prevId) ? rankDefById(prevId) : PILOT_RANKS[0]!;
  if (current.index <= prev.index) {
    if (prevId !== current.id) {
      await db
        .update(users)
        .set({ lastNotifiedRankId: current.id })
        .where(eq(users.id, userId));
    }
    return;
  }

  const newlyReached = PILOT_RANKS.filter(
    (r) => r.index > prev.index && r.index <= current.index,
  );

  for (const rank of newlyReached) {
    await db
      .insert(userMessages)
      .values({
        userId,
        kind: RANK_UP,
        rankId: rank.id,
      })
      .onConflictDoNothing({
        target: [userMessages.userId, userMessages.kind, userMessages.rankId],
      });
  }

  await db
    .update(users)
    .set({ lastNotifiedRankId: current.id })
    .where(eq(users.id, userId));
}

export type InboxMessageJson = {
  id: string;
  kind: string;
  rankId: string;
  createdAt: string;
  readAt: string | null;
};

export async function listInboxMessages(
  userId: string,
): Promise<{ messages: InboxMessageJson[]; unreadCount: number }> {
  const { db } = getDb();
  const rows = await db
    .select({
      id: userMessages.id,
      kind: userMessages.kind,
      rankId: userMessages.rankId,
      createdAt: userMessages.createdAt,
      readAt: userMessages.readAt,
    })
    .from(userMessages)
    .where(eq(userMessages.userId, userId))
    .orderBy(desc(userMessages.createdAt))
    .limit(50);

  const messages = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    rankId: r.rankId,
    createdAt: r.createdAt.toISOString(),
    readAt: r.readAt ? r.readAt.toISOString() : null,
  }));

  const unreadCount = messages.filter((m) => m.readAt == null).length;
  return { messages, unreadCount };
}

export async function markInboxRead(
  userId: string,
  opts: { ids?: string[]; all?: boolean },
): Promise<number> {
  const { db } = getDb();
  const now = new Date();

  if (opts.all) {
    const updated = await db
      .update(userMessages)
      .set({ readAt: now })
      .where(
        and(eq(userMessages.userId, userId), isNull(userMessages.readAt)),
      )
      .returning({ id: userMessages.id });
    return updated.length;
  }

  const ids = (opts.ids ?? []).filter(Boolean);
  if (ids.length === 0) return 0;

  const updated = await db
    .update(userMessages)
    .set({ readAt: now })
    .where(
      and(
        eq(userMessages.userId, userId),
        inArray(userMessages.id, ids),
        isNull(userMessages.readAt),
      ),
    )
    .returning({ id: userMessages.id });
  return updated.length;
}

/** Unread count without listing (for header badge). */
export async function unreadInboxCount(userId: string): Promise<number> {
  const { db } = getDb();
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
    })
    .from(userMessages)
    .where(
      and(eq(userMessages.userId, userId), isNull(userMessages.readAt)),
    );
  return row?.n ?? 0;
}
