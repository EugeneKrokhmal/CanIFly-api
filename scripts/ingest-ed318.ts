#!/usr/bin/env tsx
/**
 * Ingest ENAIRE ED-318 GeoJSON files into PostGIS (or memory store fallback).
 *
 * Usage:
 *   npx tsx scripts/ingest-ed318.ts
 *   npx tsx scripts/ingest-ed318.ts --fixtures-only
 *   npx tsx scripts/ingest-ed318.ts --file ./data/ZGUAS_Urbano.geojson --source urbano
 */
import { config } from "dotenv";
config({ path: ".env" });

import { ED318_SOURCES } from "../src/lib/constants";
import {
  downloadEd318File,
  downloadEd318Source,
  EnaireFetchError,
} from "../src/lib/geo/enaire-client";
import { FIXTURE_ZONES } from "../src/lib/geo/fixtures";
import { ensurePostgisSchema, isDatabaseAvailable } from "../src/lib/db/client";
import { ingestFeatures, getSliceCount } from "../src/lib/db/queries";
import type { ZoneSource } from "../src/lib/geo/ed318-types";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fixturesOnly = args.includes("--fixtures-only");
  const fileIdx = args.indexOf("--file");
  const sourceIdx = args.indexOf("--source");

  const dbUp = await isDatabaseAvailable();
  console.log(`Database available: ${dbUp}`);
  if (dbUp) {
    await ensurePostgisSchema();
    console.log("PostGIS schema ready.");
  } else {
    console.warn(
      "PostGIS unavailable — ingesting into in-memory store (process-local only).",
    );
  }

  if (fixturesOnly) {
    const n = await ingestFeatures(FIXTURE_ZONES, "fixture");
    console.log(`Loaded ${n} fixture slices.`);
    const total = await getSliceCount();
    console.log(`Total slices (${total.backend}): ${total.count}`);
    return;
  }

  if (fileIdx >= 0) {
    const filePath = args[fileIdx + 1];
    const source = (args[sourceIdx + 1] ?? "aero") as ZoneSource;
    if (!filePath) {
      throw new Error("--file requires a path");
    }
    const features = await downloadEd318File(filePath);
    console.log(`Parsed ${features.length} features from ${filePath}`);
    const n = await ingestFeatures(features, source);
    console.log(`Inserted ${n} slices for source=${source}`);
    return;
  }

  // Always seed fixtures first so demo points work even if ENAIRE is down.
  await ingestFeatures(FIXTURE_ZONES, "fixture");
  console.log(`Seeded ${FIXTURE_ZONES.length} fixture zones.`);

  for (const key of Object.keys(ED318_SOURCES) as (keyof typeof ED318_SOURCES)[]) {
    try {
      console.log(`Downloading ${ED318_SOURCES[key].label}…`);
      const { features, bytes } = await downloadEd318Source(key);
      console.log(
        `  ${features.length} features (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
      );
      const n = await ingestFeatures(features, key);
      console.log(`  Inserted ${n} slices.`);
    } catch (err) {
      if (err instanceof EnaireFetchError) {
        console.error(
          `  Failed to fetch ${key} from ${err.url}: ${err.message}`,
        );
        console.error("  Continuing with remaining sources / fixtures.");
      } else {
        console.error(`  Unexpected error for ${key}:`, err);
      }
    }
  }

  const total = await getSliceCount();
  console.log(`Done. Total slices (${total.backend}): ${total.count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
