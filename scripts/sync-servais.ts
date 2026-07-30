#!/usr/bin/env tsx
/**
 * Sync UAS zones from ENAIRE servAIS FeatureServer into PostGIS / memory store.
 *
 * Usage:
 *   npx tsx scripts/sync-servais.ts
 *   npx tsx scripts/sync-servais.ts --layer 0
 */
import { config } from "dotenv";
config({ path: ".env" });

import { arcgisFeatureToUasZone, type UasZoneFeature } from "@canifly/middleware";
import {
  EnaireFetchError,
  fetchServaisLayer,
  listServaisLayers,
} from "../src/lib/geo/enaire-client";
import { ensurePostgisSchema, isDatabaseAvailable } from "../src/lib/db/client";
import { ingestFeatures, getSliceCount } from "../src/lib/db/queries";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const layerIdx = args.indexOf("--layer");
  const onlyLayer =
    layerIdx >= 0 ? Number(args[layerIdx + 1]) : undefined;

  const dbUp = await isDatabaseAvailable();
  console.log(`Database available: ${dbUp}`);
  if (dbUp) {
    await ensurePostgisSchema();
  } else {
    console.warn("PostGIS unavailable — writing to in-memory store.");
  }

  let layers: { id: number; name: string }[];
  try {
    layers = await listServaisLayers();
  } catch (err) {
    if (err instanceof EnaireFetchError) {
      console.error(`Failed to list layers: ${err.message} (${err.url})`);
      process.exit(1);
    }
    throw err;
  }

  if (onlyLayer != null && !Number.isNaN(onlyLayer)) {
    layers = layers.filter((l) => l.id === onlyLayer);
  }

  const all: UasZoneFeature[] = [];
  for (const layer of layers) {
    try {
      console.log(`Fetching layer ${layer.id} (${layer.name})…`);
      const pages = await fetchServaisLayer(layer.id);
      for (const page of pages) {
        for (const f of page.features ?? []) {
          const zone = arcgisFeatureToUasZone(f, "servais");
          if (zone) all.push(zone);
        }
      }
      console.log(`  Features so far: ${all.length}`);
    } catch (err) {
      console.error(
        `  Layer ${layer.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const n = await ingestFeatures(all, "servais");
  console.log(`Inserted ${n} servais slices.`);
  const total = await getSliceCount();
  console.log(`Total slices (${total.backend}): ${total.count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
