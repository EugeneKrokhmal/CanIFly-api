#!/usr/bin/env tsx
/**
 * Sync German UAS zones from dipul WFS into PostGIS (map layers only).
 * Skips wohngrundstuecke — too dense for a national store.
 *
 * Usage:
 *   npx tsx scripts/sync-dipul.ts
 */
import { config } from "dotenv";
config({ path: ".env" });

import { fetchDipulNationalZones } from "../src/lib/geo/dipul-client";
import { ensurePostgisSchema, isDatabaseAvailable } from "../src/lib/db/client";
import { getSliceCount, ingestFeatures } from "../src/lib/db/queries";
import { clearZoneBboxCache } from "../src/lib/geo/zone-bbox-cache";

async function main(): Promise<void> {
  const dbUp = await isDatabaseAvailable();
  console.log(`Database available: ${dbUp}`);
  if (dbUp) {
    await ensurePostgisSchema();
  } else {
    console.warn("PostGIS unavailable — writing to in-memory store.");
  }

  console.log("Fetching dipul national map layers (tiled WFS)…");
  let lastLog = 0;
  const features = await fetchDipulNationalZones((p) => {
    const now = Date.now();
    if (now - lastLog < 5_000 && p.done < p.total) return;
    lastLog = now;
    console.log(
      `  ${p.done}/${p.total} tiles · ${p.zones} unique zones · last ${p.typeName}`,
    );
  });
  console.log(`Fetched ${features.length} unique zones. Ingesting…`);

  const n = await ingestFeatures(features, "dipul");
  clearZoneBboxCache();
  console.log(`Inserted ${n} dipul slices.`);
  const total = await getSliceCount();
  console.log(`Total slices (${total.backend}): ${total.count}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
