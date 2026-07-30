import { Hono } from "hono";
import {
  bboxZonesQuerySchema,
  clampBboxSpan,
  openCategoryCeiling,
  type DroneProfile,
} from "@canifly/middleware";
import { ensureDemoDataLoaded } from "../lib/db/bootstrap";
import { queryZonesInBbox } from "../lib/db/queries";

export const zonesRoutes = new Hono();

zonesRoutes.get("/bbox", async (c) => {
  try {
    await ensureDemoDataLoaded();

    const params = Object.fromEntries(
      new URL(c.req.url).searchParams.entries(),
    );
    const parsed = bboxZonesQuerySchema.safeParse(params);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid bbox parameters", details: parsed.error.flatten() },
        400,
      );
    }

    const { west, south, east, north, altitudeAgl, weightClass, limit } =
      parsed.data;
    const ceiling = openCategoryCeiling(altitudeAgl);

    if (west >= east || south >= north) {
      return c.json(
        { error: "Invalid bbox: west < east and south < north required" },
        400,
      );
    }

    const clamped = clampBboxSpan({ west, south, east, north });
    const profile: DroneProfile = {
      weightClass,
      operationCategory: "open",
      maxAltitudeAgl: ceiling,
    };

    const { collection, meta } = await queryZonesInBbox(
      clamped.west,
      clamped.south,
      clamped.east,
      clamped.north,
      profile,
      ceiling,
      limit,
    );

    const maxAge = Math.max(60, Math.floor(Number(process.env.ZONE_BBOX_CACHE_TTL_MS ?? 1_800_000) / 1000));
    c.header(
      "Cache-Control",
      `public, max-age=${maxAge}, stale-while-revalidate=86400`,
    );

    return c.json({ ...collection, meta });
  } catch (err) {
    console.error("[zones/bbox]", err);
    return c.json(
      {
        type: "FeatureCollection",
        features: [],
        error: "Failed to load zones",
        fallback: true,
      },
      503,
    );
  }
});
