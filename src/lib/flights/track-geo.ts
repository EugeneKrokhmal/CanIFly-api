/**
 * Split a flight track into short LineStrings colored by altitude (AGL meters).
 * Coordinates may be [lng, lat] or [lng, lat, alt].
 */

const MAX_VERTICES = 1_800;

function thinTrack(coords: number[][]): number[][] {
  if (coords.length <= MAX_VERTICES) return coords;
  const step = Math.ceil(coords.length / MAX_VERTICES);
  const out: number[][] = [];
  for (let i = 0; i < coords.length; i += step) {
    out.push(coords[i]!);
  }
  const last = coords[coords.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function altitudeOf(c: number[] | undefined): number | null {
  if (!c || c.length < 3) return null;
  const z = c[2];
  return typeof z === "number" && Number.isFinite(z) ? z : null;
}

export function trackHasAltitude(coords: number[][] | null | undefined): boolean {
  if (!coords) return false;
  return coords.some((c) => altitudeOf(c) != null);
}

/** MapLibre / CSS stops: low → high AGL (blue → brand red). */
export const FLIGHT_ALTITUDE_COLOR_STOPS: [number, string][] = [
  [0, "#3b82f6"],
  [20, "#22c55e"],
  [50, "#eab308"],
  [80, "#f97316"],
  [120, "#ff385c"],
];

export function flightTrackFeatures(
  coords: number[][],
  baseProps: Record<string, unknown>,
): GeoJSON.Feature[] {
  if (coords.length < 2) return [];

  const pts = thinTrack(coords);
  const hasAlt = trackHasAltitude(pts);

  if (!hasAlt) {
    return [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: pts.map((c) => [c[0]!, c[1]!]),
        },
        properties: {
          ...baseProps,
          altitudeM: null,
          hasAltitude: false,
        },
      },
    ];
  }

  const features: GeoJSON.Feature[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const za = altitudeOf(a);
    const zb = altitudeOf(b);
    const altitudeM =
      za != null && zb != null
        ? (za + zb) / 2
        : (za ?? zb ?? 0);
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [a[0]!, a[1]!],
          [b[0]!, b[1]!],
        ],
      },
      properties: {
        ...baseProps,
        altitudeM,
        hasAltitude: true,
      },
    });
  }
  return features;
}

export function flightStartAltitudeM(
  coords: number[][] | null | undefined,
): number | null {
  if (!coords?.length) return null;
  return altitudeOf(coords[0]);
}
