/**
 * Soft heap guard for in-memory national GeoJSON caches on small hosts (Render free).
 * Exit 134 / SIGABRT is often the Linux OOM killer (RSS), not V8 heap alone —
 * stacked nationals (DK/CH/PT/AT/IE/LV) + DIPUL's many parallel WFS buffers.
 */

const clearers = new Set<() => void>();

function softMb(): number {
  const n = Number(process.env.GEO_HEAP_SOFT_MB ?? 220);
  return Number.isFinite(n) && n > 64 ? n : 220;
}

function hardMb(): number {
  const n = Number(process.env.GEO_HEAP_HARD_MB ?? 340);
  return Number.isFinite(n) && n > softMb() ? n : Math.max(softMb() + 80, 340);
}

/** Leave headroom under hard RSS for concurrent fetch/parse buffers (e.g. dipul). */
function rssSoftMb(): number {
  const n = Number(process.env.GEO_RSS_SOFT_MB ?? hardMb() - 60);
  return Number.isFinite(n) && n > 96 ? n : Math.max(hardMb() - 60, 96);
}

export function heapUsedMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

export function heapRssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

/** True when we can still load another national dataset or a heavy WFS fan-out. */
export function canAllocateHeavyCache(): boolean {
  return heapUsedMb() < softMb() && heapRssMb() < rssSoftMb();
}

export function underHardHeapLimit(): boolean {
  return heapUsedMb() < hardMb() && heapRssMb() < hardMb();
}

export function registerGeoCacheClearer(clear: () => void): void {
  clearers.add(clear);
}

export function clearRegisteredGeoCaches(reason: string): void {
  console.warn(
    `[memory] clearing geo caches (${reason}) heap=${heapUsedMb().toFixed(0)}MB rss=${heapRssMb().toFixed(0)}MB`,
  );
  for (const clear of clearers) {
    try {
      clear();
    } catch {
      /* ignore */
    }
  }
}

/** Drop caches if over soft limit; returns whether allocation is still OK. */
export function ensureHeapForHeavyCache(label: string): boolean {
  if (canAllocateHeavyCache()) return true;
  clearRegisteredGeoCaches(`before ${label}`);
  return canAllocateHeavyCache();
}

/** National FR/CZ map warm is optional — off by default on small instances. */
export function nationalMapWarmEnabled(): boolean {
  const v = (process.env.ENABLE_NATIONAL_MAP_CACHE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function memoryHealth(): {
  heapUsedMb: number;
  rssMb: number;
  softMb: number;
  rssSoftMb: number;
  hardMb: number;
  nationalMapWarm: boolean;
} {
  return {
    heapUsedMb: Math.round(heapUsedMb()),
    rssMb: Math.round(heapRssMb()),
    softMb: softMb(),
    rssSoftMb: Math.round(rssSoftMb()),
    hardMb: hardMb(),
    nationalMapWarm: nationalMapWarmEnabled(),
  };
}
