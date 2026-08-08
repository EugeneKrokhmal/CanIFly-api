#!/usr/bin/env tsx
/**
 * Remove all @seed.canifly.local demo pilots (and cascaded pins / votes / flights).
 *
 * Usage:
 *   npm run seed:clear
 *   DATABASE_URL='postgresql://...' npm run seed:clear
 */
import { config } from "dotenv";
config({ path: ".env" });

import {
  ensurePostgisSchema,
  isDatabaseAvailable,
} from "../src/lib/db/client.js";
import { clearSeedPilots, SEED_EMAIL_SUFFIX } from "../src/lib/seed/pilots.js";

async function main(): Promise<void> {
  if (!(await isDatabaseAvailable())) {
    console.error("Database unavailable (check DATABASE_URL)");
    process.exit(1);
  }
  await ensurePostgisSchema();
  const result = await clearSeedPilots();
  console.log(
    `Removed ${result.removed} seed user(s) and ${result.pinCount} pin(s) (*${SEED_EMAIL_SUFFIX})`,
  );
  for (const email of result.emails) {
    console.log(`  - ${email}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
