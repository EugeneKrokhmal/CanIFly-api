import { Hono } from "hono";
import {
  normalizeCatalogRow,
  type CatalogDrone,
  type OpenDroneListRow,
} from "../lib/drones/catalog";

export const dronesRoutes = new Hono();

const SOURCE_URL =
  "https://github.com/dronetag/opendronelist/releases/latest/download/models.json";

let cache: { at: number; drones: CatalogDrone[] } | null = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

dronesRoutes.get("/catalog", async (c) => {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return c.json({
        drones: cache.drones,
        meta: {
          source: "opendronelist",
          cached: true,
          count: cache.drones.length,
        },
      });
    }

    const res = await fetch(SOURCE_URL, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      return c.json(
        {
          drones: cache?.drones ?? [],
          meta: { source: "opendronelist", error: `upstream_${res.status}` },
        },
        cache ? 200 : 502,
      );
    }

    const rows = (await res.json()) as OpenDroneListRow[];
    const drones = rows
      .map(normalizeCatalogRow)
      .filter((d): d is CatalogDrone => d != null)
      .sort((a, b) => a.label.localeCompare(b.label));

    cache = { at: Date.now(), drones };

    return c.json({
      drones,
      meta: { source: "opendronelist", cached: false, count: drones.length },
    });
  } catch (err) {
    console.error("[drones/catalog]", err);
    return c.json(
      {
        drones: cache?.drones ?? [],
        meta: { source: "opendronelist", error: "fetch_failed" },
      },
      cache ? 200 : 503,
    );
  }
});
