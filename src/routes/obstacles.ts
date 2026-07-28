import { Hono } from "hono";
import { z } from "zod";
import {
  bboxObstaclesQuerySchema,
  clampBboxSpan,
  createObstacleSchema,
  obstacleVoteSchema,
} from "@canifly/middleware";
import { getSessionUser, isSessionUser, requireUser } from "../lib/auth/session";
import { ensurePostgisSchema, isDatabaseAvailable } from "../lib/db/client";
import {
  deleteObstacleByOwner,
  insertObstacle,
  queryObstaclesInBbox,
  setObstacleVote,
} from "../lib/db/obstacle-queries";
import { deleteObstaclePhoto, saveObstaclePhoto } from "../lib/obstacles/photo";

export const obstaclesRoutes = new Hono();

const idSchema = z.string().uuid();

obstaclesRoutes.get("/bbox", async (c) => {
  try {
    await ensurePostgisSchema();

    const params = Object.fromEntries(
      new URL(c.req.url).searchParams.entries(),
    );
    const parsed = bboxObstaclesQuerySchema.safeParse(params);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid bbox parameters", details: parsed.error.flatten() },
        400,
      );
    }

    const { west, south, east, north, limit } = parsed.data;
    if (west >= east || south >= north) {
      return c.json(
        { error: "Invalid bbox: west < east and south < north required" },
        400,
      );
    }

    const session = await getSessionUser(c);
    const clamped = clampBboxSpan({ west, south, east, north });
    const collection = await queryObstaclesInBbox(
      clamped.west,
      clamped.south,
      clamped.east,
      clamped.north,
      limit,
      session?.id,
    );

    return c.json(collection);
  } catch (err) {
    console.error("[obstacles/bbox]", err);
    return c.json({ error: "Failed to load obstacles" }, 500);
  }
});

obstaclesRoutes.post("/", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;

    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const contentType = c.req.header("content-type") ?? "";
    let type: string;
    let lat: number;
    let lng: number;
    let heightM: number;
    let message: string | null = null;
    let photo: File | null = null;

    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const parsed = createObstacleSchema.safeParse({
        type: form.get("type"),
        lat: Number(form.get("lat")),
        lng: Number(form.get("lng")),
        heightM: Number(form.get("heightM")),
        message: (() => {
          const m = form.get("message");
          if (typeof m !== "string" || !m.trim()) return null;
          return m;
        })(),
      });
      if (!parsed.success) {
        return c.json(
          { error: "Invalid obstacle", details: parsed.error.flatten() },
          400,
        );
      }
      type = parsed.data.type;
      lat = parsed.data.lat;
      lng = parsed.data.lng;
      heightM = parsed.data.heightM;
      message = parsed.data.message?.trim() ? parsed.data.message.trim() : null;
      const file = form.get("photo");
      if (file instanceof File && file.size > 0) photo = file;
    } else {
      const body = await c.req.json().catch(() => null);
      const parsed = createObstacleSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid obstacle", details: parsed.error.flatten() },
          400,
        );
      }
      type = parsed.data.type;
      lat = parsed.data.lat;
      lng = parsed.data.lng;
      heightM = parsed.data.heightM;
      message = parsed.data.message?.trim()
        ? parsed.data.message.trim()
        : null;
    }

    let photoUrl: string | null = null;
    if (photo) {
      const saved = await saveObstaclePhoto(photo);
      if ("error" in saved) {
        return c.json({ error: saved.error }, 400);
      }
      photoUrl = saved.url;
    }

    const row = await insertObstacle({
      userId: auth.id,
      type: type as
        | "construction"
        | "crane"
        | "electric_line"
        | "air_sports"
        | "other",
      lat,
      lng,
      heightM,
      message,
      photoUrl,
    });

    if (!row) {
      return c.json({ error: "Failed to save obstacle" }, 500);
    }

    return c.json({
      obstacle: {
        id: row.id,
        userId: row.userId,
        type: row.type,
        lat: row.lat,
        lng: row.lng,
        heightM: row.heightM,
        message: row.message,
        photoUrl: row.photoUrl,
        createdAt: row.createdAt,
      },
    });
  } catch (err) {
    console.error("[obstacles/POST]", err);
    return c.json({ error: "Failed to create obstacle" }, 500);
  }
});

obstaclesRoutes.delete("/:id", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;

    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const parsed = idSchema.safeParse(c.req.param("id"));
    if (!parsed.success) {
      return c.json({ error: "Invalid id" }, 400);
    }

    const deleted = await deleteObstacleByOwner(parsed.data, auth.id);
    if (!deleted) {
      return c.json({ error: "Obstacle not found" }, 404);
    }

    await deleteObstaclePhoto(deleted.photoUrl);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[obstacles/DELETE]", err);
    return c.json({ error: "Failed to delete obstacle" }, 500);
  }
});

obstaclesRoutes.post("/:id/vote", async (c) => {
  try {
    const auth = await requireUser(c);
    if (!isSessionUser(auth)) return auth;

    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();

    const idParsed = idSchema.safeParse(c.req.param("id"));
    if (!idParsed.success) {
      return c.json({ error: "Invalid id" }, 400);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = obstacleVoteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid vote", details: parsed.error.flatten() },
        400,
      );
    }

    try {
      const summary = await setObstacleVote(
        idParsed.data,
        auth.id,
        parsed.data.value,
      );
      if (!summary) {
        return c.json({ error: "Obstacle not found" }, 404);
      }
      return c.json({ vote: summary });
    } catch (err) {
      if (err instanceof Error && err.message === "OWN_OBSTACLE") {
        return c.json(
          { error: "You can’t vote on your own report" },
          400,
        );
      }
      throw err;
    }
  } catch (err) {
    console.error("[obstacles/vote]", err);
    return c.json({ error: "Failed to save vote" }, 500);
  }
});
