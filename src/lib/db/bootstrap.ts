/**
 * Load demo fixture zones into the in-memory store as a last-resort fallback.
 * Live status/bbox prefer ENAIRE servAIS.
 */
import { FIXTURE_ZONES } from "../geo/fixtures";
import { ingestFeatures, getSliceCount } from "./queries";
import { ensurePostgisSchema, isDatabaseAvailable } from "./client";

let bootstrapped = false;

export async function ensureDemoDataLoaded(): Promise<{
  count: number;
  backend: "postgis" | "memory";
  seeded: boolean;
}> {
  if (await isDatabaseAvailable()) {
    try {
      await ensurePostgisSchema();
    } catch {
      // continue with memory fixtures
    }
  }

  const current = await getSliceCount();
  if (current.count > 0) {
    bootstrapped = true;
    return { ...current, seeded: false };
  }

  const n = await ingestFeatures(FIXTURE_ZONES, "fixture");
  bootstrapped = true;
  const after = await getSliceCount();
  return { count: after.count || n, backend: after.backend, seeded: true };
}

export function wasBootstrapped(): boolean {
  return bootstrapped;
}
