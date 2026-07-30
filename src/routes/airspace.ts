import { Hono } from "hono";
import {
  COUNTRIES,
  coverageBounds,
  inCoverageHint,
  openCategoryCeiling,
  parseLocale,
  pointStatusQuerySchema,
  resolveCountry,
  type DroneProfile,
} from "@canifly/middleware";
import { ensureDemoDataLoaded } from "../lib/db/bootstrap";
import { evaluateAirspaceStatus } from "../lib/db/queries";

export const airspaceRoutes = new Hono();

airspaceRoutes.get("/status", async (c) => {
  try {
    await ensureDemoDataLoaded();
    // Locale available for future summary i18n; English summaries for now.
    parseLocale(c.req.header("Accept-Language"));

    const params = Object.fromEntries(
      new URL(c.req.url).searchParams.entries(),
    );
    const parsed = pointStatusQuerySchema.safeParse(params);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.flatten() },
        400,
      );
    }

    const { lat, lng, altitudeAgl, weightClass } = parsed.data;
    const profile: DroneProfile = {
      weightClass,
      operationCategory: "open",
      maxAltitudeAgl: openCategoryCeiling(altitudeAgl),
    };

    if (!inCoverageHint(lat, lng)) {
      return c.json(
        {
          error: "Coordinates appear outside current coverage bounds",
          bounds: coverageBounds(),
          countries: Object.keys(COUNTRIES),
        },
        400,
      );
    }

    const { result, meta } = await evaluateAirspaceStatus(
      lat,
      lng,
      profile,
      profile.maxAltitudeAgl,
    );

    return c.json({
      ...result,
      meta: {
        ...meta,
        country: meta.country ?? resolveCountry(lat, lng),
      },
    });
  } catch (err) {
    console.error("[api/airspace/status]", err);
    return c.json({ error: "Failed to evaluate airspace status" }, 500);
  }
});
