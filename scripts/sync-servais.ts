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

import {
  arcgisFeatureToUasZone,
} from "../src/lib/geo/normalize-slices";
import {
  EnaireFetchError,
  fetchServaisLayer,
  listServaisLayers,
} from "../src/lib/geo/enaire-client";
import { ensurePostgisSchema, isDatabaseAvailable } from "../src/lib/db/client";
import { ingestFeatures, getSliceCount } from "../src/lib/db/queries";
import type { UasZoneFeature } from "../src/lib/geo/ed318-types";

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
    console.error("Could not list servAIS layers:", err);
    process.exit(1);
    return;
  }

  if (onlyLayer !== undefined && !Number.isNaN(onlyLayer)) {
    layers = layers.filter((l) => l.id === onlyLayer);
  }

  console.log(
    `Syncing ${layers.length} layer(s): ${layers.map((l) => `${l.id}:${l.name}`).join(", ")}`,
  );

  const allFeatures: UasZoneFeature[] = [];

  for (const layer of layers) {
    try {
      console.log(`Fetching layer ${layer.id} (${layer.name})…`);
      const geoFeatures = await fetchServaisLayer(layer.id);
      console.log(`  ${geoFeatures.length} ArcGIS features`);
      for (let i = 0; i < geoFeatures.length; i++) {
        const mapped = arcgisFeatureToUasZone(
          geoFeatures[i],
          `servais-${layer.id}-${i}`,
        );
        if (mapped) allFeatures.push(mapped);
      }
    } catch (err) {
      if (err instanceof EnaireFetchError) {
        console.error(`  Layer ${layer.id} failed: ${err.message} (${err.url})`);
      } else {
        console.error(`  Layer ${layer.id} failed:`, err);
      }
    }
  }

  if (allFeatures.length === 0) {
    console.warn("No features ingested from servAIS.");
    process.exit(0);
  }

  const n = await ingestFeatures(allFeatures, "servais");
  console.log(`Inserted ${n} servais slices from ${allFeatures.length} zones.`);
  const total = await getSliceCount();
  console.log(`Total slices (${total.backend}): ${total.count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
