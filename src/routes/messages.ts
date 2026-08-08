import { Hono } from "hono";
import { z } from "zod";
import { isSessionUser, requireUser } from "../lib/auth/session";
import { ensurePostgisSchema, isDatabaseAvailable } from "../lib/db/client";
import {
  listInboxMessages,
  markInboxRead,
  syncRankInbox,
} from "../lib/db/rank-inbox";

export const messagesRoutes = new Hono();

const readBodySchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    ids: z.array(z.string().uuid()).min(1).max(50),
  }),
]);

messagesRoutes.get("/", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;

    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();
    await syncRankInbox(auth.id);
    const { messages, unreadCount } = await listInboxMessages(auth.id);
    return c.json({ messages, unreadCount });
  } catch (err) {
    console.error("[messages/GET]", err);
    return c.json({ error: "Failed to load messages" }, 500);
  }
});

messagesRoutes.post("/read", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;

    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const body = await c.req.json().catch(() => null);
    const parsed = readBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid body" }, 400);
    }

    const updated =
      "all" in parsed.data
        ? await markInboxRead(auth.id, { all: true })
        : await markInboxRead(auth.id, { ids: parsed.data.ids });

    const { messages, unreadCount } = await listInboxMessages(auth.id);
    return c.json({ updated, messages, unreadCount });
  } catch (err) {
    console.error("[messages/POST /read]", err);
    return c.json({ error: "Failed to mark read" }, 500);
  }
});
