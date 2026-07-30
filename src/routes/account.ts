import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { updateAccountSchema } from "@canifly/middleware";
import {
  clearAuthCookie,
  isSessionUser,
  requireUser,
} from "../lib/auth/session";
import {
  ensurePostgisSchema,
  getDb,
  isDatabaseAvailable,
} from "../lib/db/client";
import { listObstaclesByUser } from "../lib/db/obstacle-queries";
import { users } from "../lib/db/schema";
import { normalizeMailLocale } from "../lib/auth/mail";
import {
  deleteAvatarPhoto,
  deleteObstaclePhoto,
  saveAvatarPhoto,
} from "../lib/obstacles/photo";

export const accountRoutes = new Hono();

function toPublicUser(row: {
  id: string;
  email: string;
  name: string;
  operatorNumber: string | null;
  bio: string | null;
  avatarUrl: string | null;
  locale?: string | null;
}) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || row.email.split("@")[0] || "Pilot",
    operatorNumber: row.operatorNumber,
    bio: row.bio,
    avatarUrl: row.avatarUrl,
    locale: normalizeMailLocale(row.locale),
  };
}

accountRoutes.patch("/", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;

    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const form = await c.req.formData();
    const parsed = updateAccountSchema.safeParse({
      name: form.get("name"),
      bio: form.get("bio"),
      operatorNumber: form.get("operatorNumber"),
      removeAvatar: form.get("removeAvatar"),
    });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid profile", details: parsed.error.flatten() },
        400,
      );
    }

    const { db } = getDb();
    const [current] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        operatorNumber: users.operatorNumber,
        bio: users.bio,
        avatarUrl: users.avatarUrl,
        locale: users.locale,
      })
      .from(users)
      .where(eq(users.id, auth.id))
      .limit(1);

    if (!current) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let avatarUrl = current.avatarUrl;
    const file = form.get("avatar");
    if (file instanceof File && file.size > 0) {
      const saved = await saveAvatarPhoto(file);
      if ("error" in saved) {
        return c.json({ error: saved.error }, 400);
      }
      await deleteAvatarPhoto(current.avatarUrl);
      avatarUrl = saved.url;
    } else if (parsed.data.removeAvatar) {
      await deleteAvatarPhoto(current.avatarUrl);
      avatarUrl = null;
    }

    const [row] = await db
      .update(users)
      .set({
        name: parsed.data.name,
        bio: parsed.data.bio,
        operatorNumber: parsed.data.operatorNumber,
        avatarUrl,
      })
      .where(eq(users.id, auth.id))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        operatorNumber: users.operatorNumber,
        bio: users.bio,
        avatarUrl: users.avatarUrl,
        locale: users.locale,
      });

    return c.json({ user: toPublicUser(row) });
  } catch (err) {
    console.error("[account/PATCH]", err);
    return c.json({ error: "Failed to update account" }, 500);
  }
});

accountRoutes.delete("/", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;

    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();
    const { db } = getDb();

    const [current] = await db
      .select({
        id: users.id,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, auth.id))
      .limit(1);

    if (!current) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const obstacleRows = await listObstaclesByUser(auth.id, 2000);
    for (const o of obstacleRows) {
      await deleteObstaclePhoto(o.photoUrl);
    }
    await deleteAvatarPhoto(current.avatarUrl);

    await db.delete(users).where(eq(users.id, auth.id));

    clearAuthCookie(c);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[account/DELETE]", err);
    return c.json({ error: "Failed to delete account" }, 500);
  }
});
