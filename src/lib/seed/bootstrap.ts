/**
 * Idempotent demo pilot seed — only when SEED_DEMO_PILOTS=1.
 * Off by default so clearing seed users on prod is not undone by redeploys.
 */
import { ensurePostgisSchema, isDatabaseAvailable } from "../db/client.js";
import { seedNeedsRefresh, seedPilots } from "./pilots.js";

let seedPromise: Promise<void> | undefined;

function seedDemoPilotsEnabled(): boolean {
  const v = process.env.SEED_DEMO_PILOTS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export async function ensureSeedPilotsLoaded(): Promise<void> {
  if (!seedDemoPilotsEnabled()) return;
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    if (!(await isDatabaseAvailable())) return;

    try {
      await ensurePostgisSchema();
      const force = await seedNeedsRefresh();
      if (force) {
        console.log("[seed] refreshing demo pilots (legacy copy detected)");
      }
      const result = await seedPilots({ force });
      if (result.skipped) return;

      console.log(
        `[seed] demo pilots: +${result.pilots} users, +${result.flySpots} fly spots, +${result.votes} votes${result.removed ? ` (replaced ${result.removed})` : ""}`,
      );
      if (result.rejectedSpots?.length) {
        console.warn(
          `[seed] skipped ${result.rejectedSpots.length} restricted/prohibited spot(s)`,
        );
      }
    } catch (err) {
      console.error("[seed] ensureSeedPilotsLoaded failed:", err);
    }
  })();

  return seedPromise;
}
