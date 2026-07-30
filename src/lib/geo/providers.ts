import type { CountryId, MatchedZone } from "@canifly/middleware";
import {
  queryServaisBbox,
  queryServaisPoint,
} from "./enaire-client";
import {
  queryPansaBbox,
  queryPansaPoint,
} from "./pansa-client";

export interface CountryAirspaceProvider {
  country: CountryId;
  queryPoint(lat: number, lng: number, altitudeAgl?: number): Promise<MatchedZone[]>;
  queryBbox(
    west: number,
    south: number,
    east: number,
    north: number,
    limit?: number,
    altitudeAgl?: number,
  ): Promise<GeoJSON.FeatureCollection>;
}

export const spainProvider: CountryAirspaceProvider = {
  country: "ES",
  async queryPoint(lat, lng) {
    return queryServaisPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryServaisBbox(west, south, east, north, limit);
  },
};

export const polandProvider: CountryAirspaceProvider = {
  country: "PL",
  async queryPoint(lat, lng, altitudeAgl = 120) {
    return queryPansaPoint(lat, lng, altitudeAgl);
  },
  async queryBbox(west, south, east, north, limit = 500, altitudeAgl = 120) {
    return queryPansaBbox(west, south, east, north, limit, altitudeAgl);
  },
};

export const COUNTRY_PROVIDERS: Record<CountryId, CountryAirspaceProvider> = {
  ES: spainProvider,
  PL: polandProvider,
};

export function getProvider(country: CountryId): CountryAirspaceProvider {
  return COUNTRY_PROVIDERS[country];
}
