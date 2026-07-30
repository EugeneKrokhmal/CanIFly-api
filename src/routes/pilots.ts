import { Hono } from "hono";
import { z } from "zod";
import { ensurePostgisSchema, isDatabaseAvailable } from "../lib/db/client";
import {
  getPilotProfile,
  listObstaclesByUser,
  listTopPilotsByPinCount,
} from "../lib/db/obstacle-queries";

export const pilotsRoutes = new Hono();

const idSchema = z.string().uuid();

const topQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

/** Top pilots by pins left — must stay before `/:id`. */
pilotsRoutes.get("/top", async (c) => {
  try {
    // Decorative: empty list when DB is down (don't 503 the map UI).
    if (!(await isDatabaseAvailable())) {
      return c.json({ pilots: [] });
    }

    await ensurePostgisSchema();

    const parsed = topQuerySchema.safeParse({
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.success) {
      return c.json({ error: "Invalid query" }, 400);
    }

    const pilots = await listTopPilotsByPinCount(parsed.data.limit);
    return c.json({ pilots });
  } catch (err) {
    console.error("[pilots/GET /top]", err);
    return c.json({ pilots: [] });
  }
});

pilotsRoutes.get("/:id", async (c) => {
  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const parsed = idSchema.safeParse(c.req.param("id"));
    if (!parsed.success) {
      return c.json({ error: "Invalid id" }, 400);
    }

    const pilot = await getPilotProfile(parsed.data);
    if (!pilot) {
      return c.json({ error: "Pilot not found" }, 404);
    }

    const obstacles = await listObstaclesByUser(parsed.data);

    return c.json({
      pilot: {
        id: pilot.id,
        name: pilot.name,
        operatorNumber: pilot.operatorNumber,
        bio: pilot.bio,
        avatarUrl: pilot.avatarUrl,
        createdAt: pilot.createdAt,
      },
      obstacles: obstacles.map((o) => ({
        id: o.id,
        kind: o.kind,
        type: o.type,
        lat: o.lat,
        lng: o.lng,
        heightM: o.heightM,
        message: o.message,
        photoUrl: o.photoUrl,
        createdAt: o.createdAt,
      })),
    });
  } catch (err) {
    console.error("[pilots/GET]", err);
    return c.json({ error: "Failed to load profile" }, 500);
  }
});
