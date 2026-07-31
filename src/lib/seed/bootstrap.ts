/**
 * Idempotent demo pilot seed — runs once when no @seed.canifly.local users exist.
 */
import { ensurePostgisSchema, isDatabaseAvailable } from "../db/client.js";
import { seedPilots } from "./pilots.js";

let seedPromise: Promise<void> | undefined;

export async function ensureSeedPilotsLoaded(): Promise<void> {
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    if (!(await isDatabaseAvailable())) return;

    try {
      await ensurePostgisSchema();
      const result = await seedPilots();
      if (result.skipped) return;

      console.log(
        `[seed] demo pilots: +${result.pilots} users, +${result.flySpots} fly spots, +${result.votes} votes`,
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
