#!/usr/bin/env tsx
/**
 * Seed scenic fly spots (with photos) under a real user account.
 *
 * Only skips PROHIBITED after live airspace check (keeps clear / limited / restricted).
 * Photos: Wikimedia Commons search → JPEG via sharp/storage.
 *
 * Usage:
 *   FLY_SPOT_OWNER_EMAIL='you@example.com' npx tsx scripts/seed-scenic-fly-spots.ts --dry-run
 *   FLY_SPOT_OWNER_EMAIL='you@example.com' npx tsx scripts/seed-scenic-fly-spots.ts
 *
 * Prod:
 *   DATABASE_URL='...' SUPABASE_URL='...' SUPABASE_SERVICE_ROLE_KEY='...' \
 *     FLY_SPOT_OWNER_EMAIL='...' npx tsx scripts/seed-scenic-fly-spots.ts
 *
 * Optional: --country=ES,DE  to limit; --force to re-insert even if same lat/lng exists for owner
 */
import { config } from "dotenv";
config({ path: ".env" });

import { and, eq } from "drizzle-orm";
import {
  DEFAULT_DRONE_PROFILE,
  type AirspaceStatus,
} from "@canifly/middleware";
import { ensurePostgisSchema, getDb, isDatabaseAvailable } from "../src/lib/db/client";
import { obstacles, users } from "../src/lib/db/schema";
import { evaluateAirspaceStatus } from "../src/lib/db/queries";
import { saveObstaclePhoto } from "../src/lib/obstacles/photo";
import {
  SCENIC_FLY_SPOTS,
  type ScenicFlySpot,
} from "../src/lib/seed/scenic-fly-spots";

const ALLOWED = new Set<AirspaceStatus>(["clear", "limited", "restricted"]);
const CEILING = 120;
const UA = "CanIFlyScenicSeed/0.3 (https://canifly.org; scenic fly spots)";

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function fetchCommonsPhoto(query: string): Promise<Buffer | null> {
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("format", "json");
  api.searchParams.set("generator", "search");
  api.searchParams.set("gsrsearch", `filetype:bitmap ${query}`);
  api.searchParams.set("gsrnamespace", "6");
  api.searchParams.set("gsrlimit", "5");
  api.searchParams.set("prop", "imageinfo");
  api.searchParams.set("iiprop", "url|mime|size");
  api.searchParams.set("iiurlwidth", "1400");

  const res = await fetch(api, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    query?: {
      pages?: Record<
        string,
        {
          imageinfo?: Array<{
            url?: string;
            thumburl?: string;
            mime?: string;
          }>;
        }
      >;
    };
  };
  const pages = Object.values(data.query?.pages ?? {});
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    const mime = info?.mime ?? "";
    if (!mime.startsWith("image/") || mime.includes("svg")) continue;
    const url = info.thumburl || info.url;
    if (!url) continue;
    const img = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(45_000),
    });
    if (!img.ok) continue;
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 5000) return buf;
  }
  return null;
}

async function main() {
  const dryRun = argFlag("--dry-run");
  const force = argFlag("--force");
  const countryFilter = (argValue("--country") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const ownerEmail = (process.env.FLY_SPOT_OWNER_EMAIL ?? "").trim().toLowerCase();
  const ownerIdEnv = (process.env.FLY_SPOT_OWNER_ID ?? "").trim();
  if (!dryRun && !ownerEmail && !ownerIdEnv) {
    console.error("Set FLY_SPOT_OWNER_EMAIL or FLY_SPOT_OWNER_ID");
    process.exit(1);
  }

  if (!(await isDatabaseAvailable())) {
    console.error("DATABASE_URL unavailable");
    process.exit(1);
  }
  await ensurePostgisSchema();
  const { db } = getDb();

  let owner: { id: string; name: string | null; email: string } | null = null;
  if (ownerEmail || ownerIdEnv) {
    if (ownerIdEnv) {
      const rows = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, ownerIdEnv))
        .limit(1);
      if (!rows[0]) {
        console.error(`No user with id ${ownerIdEnv}`);
        process.exit(1);
      }
      owner = rows[0];
    } else {
      const rows = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.email, ownerEmail))
        .limit(1);
      if (!rows[0]) {
        console.error(
          `No user with email ${ownerEmail}. Sign in once on this DB, then re-run.`,
        );
        process.exit(1);
      }
      owner = rows[0];
    }
    console.log(
      `Owner: ${owner.name ?? "?"} <${owner.email}> (${owner.id.slice(0, 8)}…)`,
    );
  } else {
    console.log("No owner set — dry-run airspace check only");
  }
  console.log(
    dryRun ? "DRY RUN — no inserts" : "LIVE — will insert fly spots + photos",
  );

  let candidates = SCENIC_FLY_SPOTS;
  if (countryFilter.length > 0) {
    candidates = candidates.filter((s) => countryFilter.includes(s.country));
  }

  const byCountry = new Map<string, number>();
  let kept = 0;
  let skippedStatus = 0;
  let skippedDup = 0;
  let inserted = 0;
  let photoFail = 0;

  for (const spot of candidates) {
    let status: AirspaceStatus | "error" = "error";
    try {
      const { result } = await evaluateAirspaceStatus(
        spot.lat,
        spot.lng,
        DEFAULT_DRONE_PROFILE,
        CEILING,
      );
      status = result.status;
    } catch (err) {
      console.warn(
        `  airspace error @ ${spot.message}:`,
        err instanceof Error ? err.message : err,
      );
    }

    if (status !== "error" && !ALLOWED.has(status)) {
      console.log(`✗ ${spot.country} ${spot.message} → ${status}`);
      skippedStatus += 1;
      continue;
    }
    if (status === "error") {
      console.log(`? ${spot.country} ${spot.message} → keep (airspace offline)`);
    } else {
      console.log(`✓ ${spot.country} ${spot.message} → ${status}`);
    }

    if (owner) {
      const existing = await db
        .select({ id: obstacles.id })
        .from(obstacles)
        .where(
          and(
            eq(obstacles.userId, owner.id),
            eq(obstacles.kind, "fly_spot"),
            eq(obstacles.lat, spot.lat),
            eq(obstacles.lng, spot.lng),
          ),
        )
        .limit(1);
      if (existing.length > 0 && !force) {
        console.log(`  skip duplicate`);
        skippedDup += 1;
        continue;
      }
    }

    kept += 1;
    byCountry.set(spot.country, (byCountry.get(spot.country) ?? 0) + 1);

    if (dryRun || !owner) continue;

    let photoUrl: string | null = null;
    try {
      const buf = await fetchCommonsPhoto(spot.photoQuery);
      if (buf) {
        const file = new File([buf], "scenic.jpg", { type: "image/jpeg" });
        const saved = await saveObstaclePhoto(file);
        if ("url" in saved) photoUrl = saved.url;
        else {
          console.warn(`  photo: ${saved.error}`);
          photoFail += 1;
        }
      } else {
        console.warn(`  photo: no Commons hit for "${spot.photoQuery}"`);
        photoFail += 1;
      }
    } catch (err) {
      console.warn(
        `  photo fetch failed:`,
        err instanceof Error ? err.message : err,
      );
      photoFail += 1;
    }

    await db.insert(obstacles).values({
      userId: owner.id,
      kind: "fly_spot",
      type: spot.type,
      lat: spot.lat,
      lng: spot.lng,
      heightM: 120,
      message: spot.message,
      photoUrl,
    });
    inserted += 1;
    console.log(`  inserted${photoUrl ? " + photo" : " (no photo)"}`);
  }

  console.log("\n--- summary ---");
  console.log(`candidates: ${candidates.length}`);
  console.log(`kept (clear/limited): ${kept}`);
  console.log(`rejected status: ${skippedStatus}`);
  console.log(`duplicates: ${skippedDup}`);
  console.log(`inserted: ${inserted}`);
  console.log(`photo misses: ${photoFail}`);
  console.log("per country kept:", Object.fromEntries(byCountry));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
