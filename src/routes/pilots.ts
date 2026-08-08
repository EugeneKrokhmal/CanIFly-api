import { Hono } from "hono";
import { z } from "zod";
import { ensurePostgisSchema, isDatabaseAvailable } from "../lib/db/client";
import {
  getPilotProfile,
  listObstaclesByUser,
} from "../lib/db/obstacle-queries";
import { listTopPilotsByLevel } from "../lib/db/pilot-leaderboard";
import {
  flightSummaryJson,
  listFlightsByUser,
} from "../lib/db/flight-queries";
import {
  computePilotBadges,
  pilotBadgeStats,
} from "../lib/badges";

export const pilotsRoutes = new Hono();

const idSchema = z.string().uuid();

const topQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

/** Top pilots by aviation rank / airtime — must stay before `/:id`. */
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

    const pilots = await listTopPilotsByLevel(parsed.data.limit);
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

    const obstacles = await listObstaclesByUser(parsed.data, 500);
    const flights = await listFlightsByUser(parsed.data, 100);

    const badgeFlights = flights.map((f) => ({
      startedAt: f.startedAt,
      durationS: f.durationS,
      distanceM: f.distanceM,
      maxHeightM: f.maxHeightM,
      hasTrack: Boolean(f.trackCoordinates && f.trackCoordinates.length >= 2),
    }));
    const badgePins = obstacles.map((o) => ({
      kind: o.kind,
      photoUrl: o.photoUrl,
      createdAt: o.createdAt,
    }));
    const badges = computePilotBadges({
      pilot: {
        operatorNumber: pilot.operatorNumber,
        avatarUrl: pilot.avatarUrl,
        bio: pilot.bio,
        createdAt: pilot.createdAt,
      },
      flights: badgeFlights,
      pins: badgePins,
    });
    const stats = pilotBadgeStats({
      flights: badgeFlights,
      pins: badgePins,
    });

    return c.json({
      pilot: {
        id: pilot.id,
        name: pilot.name,
        operatorNumber: pilot.operatorNumber,
        bio: pilot.bio,
        avatarUrl: pilot.avatarUrl,
        createdAt: pilot.createdAt,
      },
      stats,
      badges,
      flights: flights.map(flightSummaryJson),
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
