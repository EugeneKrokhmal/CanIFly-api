import { Hono } from "hono";
import { z } from "zod";
import {
  ED318_SOURCES,
  arcgisFeatureToUasZone,
  type UasZoneFeature,
  type ZoneSource,
} from "@canifly/middleware";
import { ensurePostgisSchema, isDatabaseAvailable } from "../lib/db/client";
import { getSliceCount, ingestFeatures } from "../lib/db/queries";
import { clearZoneBboxCache } from "../lib/geo/zone-bbox-cache";
import {
  downloadEd318Source,
  EnaireFetchError,
  fetchServaisLayer,
  listServaisLayers,
} from "../lib/geo/enaire-client";
import { fetchDipulNationalZones } from "../lib/geo/dipul-client";
import { FIXTURE_ZONES } from "../lib/geo/fixtures";
import {
  clearSeedPilots,
  seedPilots,
  seedPilotsPlan,
} from "../lib/seed/pilots";

export const adminRoutes = new Hono();

const bodySchema = z.object({
  sources: z
    .array(z.enum(["fixtures", "ed318", "servais", "dipul"]))
    .default(["fixtures", "ed318"]),
});

const seedBodySchema = z.object({
  force: z.boolean().optional().default(false),
});

function authorize(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const secret = process.env.ENAIRE_INGEST_SECRET;
  if (!secret) return false;
  const header = c.req.header("x-ingest-secret");
  const auth = c.req.header("authorization");
  if (header && header === secret) return true;
  if (auth === `Bearer ${secret}`) return true;
  return false;
}

adminRoutes.post("/ingest", async (c) => {
  if (!authorize(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const json = (await c.req.json().catch(() => ({}))) as unknown;
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        400,
      );
    }

    const dbUp = await isDatabaseAvailable();
    if (dbUp) {
      await ensurePostgisSchema();
    }

    const counts: Record<string, number> = {};
    const errors: string[] = [];

    if (parsed.data.sources.includes("fixtures")) {
      counts.fixture = await ingestFeatures(FIXTURE_ZONES, "fixture");
    }

    if (parsed.data.sources.includes("ed318")) {
      for (const key of Object.keys(
        ED318_SOURCES,
      ) as (keyof typeof ED318_SOURCES)[]) {
        try {
          const { features } = await downloadEd318Source(key);
          counts[key] = await ingestFeatures(features, key as ZoneSource);
        } catch (err) {
          const msg =
            err instanceof EnaireFetchError
              ? `${key}: ${err.message}`
              : `${key}: unknown error`;
          errors.push(msg);
        }
      }
    }

    if (parsed.data.sources.includes("servais")) {
      try {
        const layers = await listServaisLayers();
        const all: UasZoneFeature[] = [];
        for (const layer of layers) {
          try {
            const feats = await fetchServaisLayer(layer.id);
            feats.forEach((f, i) => {
              const mapped = arcgisFeatureToUasZone(
                f,
                `servais-${layer.id}-${i}`,
              );
              if (mapped) all.push(mapped);
            });
          } catch (err) {
            errors.push(
              `servais layer ${layer.id}: ${err instanceof Error ? err.message : "error"}`,
            );
          }
        }
        counts.servais = await ingestFeatures(all, "servais");
      } catch (err) {
        errors.push(
          `servais: ${err instanceof Error ? err.message : "error"}`,
        );
      }
    }

    if (parsed.data.sources.includes("dipul")) {
      // National crawl is 10–20+ min — never block the HTTP request (Render timeouts).
      void (async () => {
        try {
          console.log("[admin/ingest dipul] background sync started");
          const all = await fetchDipulNationalZones((p) => {
            if (p.done === p.total || p.done % 25 === 0) {
              console.log(
                `[admin/ingest dipul] ${p.done}/${p.total} · ${p.zones} zones`,
              );
            }
          });
          const n = await ingestFeatures(all, "dipul");
          clearZoneBboxCache();
          console.log(`[admin/ingest dipul] done — ${n} slices`);
        } catch (err) {
          console.error(
            "[admin/ingest dipul] failed",
            err instanceof Error ? err.message : err,
          );
        }
      })();
      counts.dipul = -1; // started async
    }

    const total = await getSliceCount();
    if (!parsed.data.sources.includes("dipul")) {
      clearZoneBboxCache();
    }

    return c.json({
      ok: true,
      database: dbUp ? "postgis" : "memory",
      counts,
      errors,
      total: total.count,
      backend: total.backend,
      ...(parsed.data.sources.includes("dipul")
        ? { dipul: "started_async", note: "Watch Render logs; finishes in ~15–30 min" }
        : {}),
    });
  } catch (err) {
    console.error("[admin/ingest]", err);
    return c.json(
      {
        error: "Ingest failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      500,
    );
  }
});

adminRoutes.get("/ingest", async (c) => {
  if (!authorize(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const total = await getSliceCount();
  const dbUp = await isDatabaseAvailable();
  return c.json({
    databaseAvailable: dbUp,
    ...total,
  });
});

/** Demo pilots + scenic fly spots (ES / CZ / PL). Same auth as /ingest. */
adminRoutes.post("/seed-pilots", async (c) => {
  if (!authorize(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const json = (await c.req.json().catch(() => ({}))) as unknown;
    const parsed = seedBodySchema.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        400,
      );
    }

    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();
    const result = await seedPilots({ force: parsed.data.force });

    return c.json({
      ok: true,
      plan: seedPilotsPlan(),
      ...result,
    });
  } catch (err) {
    console.error("[admin/seed-pilots]", err);
    return c.json(
      {
        error: "Seed failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      500,
    );
  }
});

/** Remove all @seed.canifly.local users and cascaded pins / votes / flights. */
adminRoutes.post("/clear-seed-pilots", async (c) => {
  if (!authorize(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    if (!(await isDatabaseAvailable())) {
      return c.json({ error: "Database unavailable" }, 503);
    }

    await ensurePostgisSchema();
    const result = await clearSeedPilots();
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error("[admin/clear-seed-pilots]", err);
    return c.json(
      {
        error: "Clear seed failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      500,
    );
  }
});
