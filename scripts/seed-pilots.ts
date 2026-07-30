#!/usr/bin/env tsx
/**
 * Seed demo pilots with scenic fly spots (ES / CZ / PL).
 *
 * Usage:
 *   npm run seed:pilots              # skip if seed users exist
 *   npm run seed:pilots -- --force   # delete prior seed users and re-insert
 *   npm run seed:pilots -- --dry-run # print plan only
 *
 * Production (Supabase pooler URL from dashboard):
 *   DATABASE_URL='postgresql://...' npm run seed:pilots
 *
 * Seed accounts use @seed.canifly.local emails and password `SeedPilot2026!`
 */
import { config } from "dotenv";
config({ path: ".env" });

import {
  ensurePostgisSchema,
  isDatabaseAvailable,
} from "../src/lib/db/client.js";
import {
  SEED_EMAIL_SUFFIX,
  SEED_PASSWORD,
  seedPilots,
  seedPilotsPlan,
} from "../src/lib/seed/pilots.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  const plan = seedPilotsPlan();
  console.log(
    `Plan: ${plan.pilots} pilots, ${plan.flySpots} fly spots (${plan.emailSuffix})`,
  );

  if (dryRun) return;

  if (!(await isDatabaseAvailable())) {
    console.error("Database unavailable — check DATABASE_URL in .env");
    process.exit(1);
  }

  await ensurePostgisSchema();

  const result = await seedPilots({ force });

  if (result.skipped) {
    console.log(
      `Found ${result.existingEmails?.length ?? 0} seed user(s). Run with --force to replace.`,
    );
    console.log("Existing:", result.existingEmails?.join(", "));
    return;
  }

  if (result.removed) {
    console.log(`Removed ${result.removed} prior seed user(s).`);
  }

  if (result.rejectedSpots?.length) {
    console.warn("Skipped restricted/prohibited spots:");
    for (const line of result.rejectedSpots) console.warn(`  - ${line}`);
  }

  console.log(`+ ${result.pilots} pilots, ${result.flySpots} fly spots`);
  console.log(`+ ${result.votes} cross-upvote(s)`);
  console.log("\nDone.");
  console.log(`Login: any *${SEED_EMAIL_SUFFIX} / ${SEED_PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
