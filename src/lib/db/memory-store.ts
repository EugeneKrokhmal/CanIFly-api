import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import {
  zoneFeatureToSlices,
  type MatchedZone,
  type UasZoneFeature,
  type ZoneSliceRecord,
  type ZoneSource,
} from "@canifly/middleware";

/**
 * In-memory spatial store used when PostGIS is unavailable.
 * Suitable for fixtures / local demo; uses Turf point-in-polygon.
 */
class MemoryZoneStore {
  private slices: ZoneSliceRecord[] = [];
  private dataVersion: string | null = null;

  clear(): void {
    this.slices = [];
  }

  getCount(): number {
    return this.slices.length;
  }

  getDataVersion(): string | null {
    return this.dataVersion;
  }

  getAll(): ZoneSliceRecord[] {
    return [...this.slices];
  }

  loadFromFeatures(features: UasZoneFeature[], source: ZoneSource): number {
    const now = new Date();
    this.dataVersion = now.toISOString().slice(0, 10);
    let count = 0;
    for (const feature of features) {
      const slices = zoneFeatureToSlices(feature, source, now);
      this.slices.push(...slices);
      count += slices.length;
    }
    return count;
  }

  replaceSource(source: ZoneSource, slices: ZoneSliceRecord[]): number {
    this.slices = this.slices.filter((s) => s.source !== source);
    this.slices.push(...slices);
    this.dataVersion = new Date().toISOString().slice(0, 10);
    return slices.length;
  }

  replaceAll(slices: ZoneSliceRecord[]): void {
    this.slices = slices;
    this.dataVersion = new Date().toISOString().slice(0, 10);
  }

  queryPoint(lat: number, lng: number): MatchedZone[] {
    const pt = point([lng, lat]);
    const matches: MatchedZone[] = [];

    for (const slice of this.slices) {
      try {
        if (booleanPointInPolygon(pt, slice.geomGeoJson)) {
          const contact = slice.properties.zoneAuthority?.[0]?.email;
          matches.push({
            identifier: slice.zoneIdentifier,
            name: slice.name,
            restriction: slice.restriction,
            reason: slice.reason,
            source: slice.source,
            lowerLimitM: slice.lowerLimitM,
            upperLimitM: slice.upperLimitM,
            lowerRef: slice.lowerRef,
            upperRef: slice.upperRef,
            contact,
            message: slice.properties.message,
          });
        }
      } catch {
        // Skip invalid geometries
      }
    }
    return matches;
  }

  queryBbox(
    west: number,
    south: number,
    east: number,
    north: number,
  ): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    for (const slice of this.slices) {
      const coords = flattenCoords(slice.geomGeoJson);
      const intersects = coords.some(
        ([lng, lat]) =>
          lng >= west && lng <= east && lat >= south && lat <= north,
      );
      if (!intersects) {
        const corners: [number, number][] = [
          [west, south],
          [east, south],
          [west, north],
          [east, north],
        ];
        const covers = corners.some((c) => {
          try {
            return booleanPointInPolygon(point(c), slice.geomGeoJson);
          } catch {
            return false;
          }
        });
        if (!covers) continue;
      }

      features.push({
        type: "Feature",
        geometry: slice.geomGeoJson,
        properties: {
          identifier: slice.zoneIdentifier,
          name: slice.name,
          restriction: slice.restriction,
          reason: slice.reason,
          source: slice.source,
          lowerLimitM: slice.lowerLimitM,
          upperLimitM: slice.upperLimitM,
          lowerRef: slice.lowerRef,
          upperRef: slice.upperRef,
        },
      });
    }
    return { type: "FeatureCollection", features };
  }
}

function flattenCoords(
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): [number, number][] {
  if (geom.type === "Polygon") {
    return geom.coordinates.flat() as [number, number][];
  }
  return geom.coordinates.flat(2) as [number, number][];
}

export const memoryZoneStore = new MemoryZoneStore();
