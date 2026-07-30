import type { CountryId, MatchedZone } from "@canifly/middleware";
import {
  queryServaisBbox,
  queryServaisPoint,
} from "./enaire-client";
import {
  queryAnscrBbox,
  queryAnscrPoint,
} from "./anscr-client";
import {
  queryDipulBbox,
  queryDipulPoint,
} from "./dipul-client";
import {
  queryGeopfBbox,
  queryGeopfPoint,
} from "./geopf-client";
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

export function backendLabelForCountry(
  country: CountryId,
): "servais" | "pansa" | "aimgis" | "dipul" | "geopf" {
  if (country === "PL") return "pansa";
  if (country === "CZ") return "aimgis";
  if (country === "DE") return "dipul";
  if (country === "FR") return "geopf";
  return "servais";
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

/** Germany — live dipul WFS (uas-betrieb.de). */
export const germanyProvider: CountryAirspaceProvider = {
  country: "DE",
  async queryPoint(lat, lng) {
    return queryDipulPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryDipulBbox(west, south, east, north, limit);
  },
};

/** France — live Géoportail WFS (data.geopf.fr). */
export const franceProvider: CountryAirspaceProvider = {
  country: "FR",
  async queryPoint(lat, lng) {
    return queryGeopfPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryGeopfBbox(west, south, east, north, limit);
  },
};

/** Czechia — live ANS CR ArcGIS (aimgis.rlp.cz). */
export const czechiaProvider: CountryAirspaceProvider = {
  country: "CZ",
  async queryPoint(lat, lng) {
    return queryAnscrPoint(lat, lng);
  },
  async queryBbox(west, south, east, north, limit = 500) {
    return queryAnscrBbox(west, south, east, north, limit);
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
  DE: germanyProvider,
  FR: franceProvider,
  CZ: czechiaProvider,
  PL: polandProvider,
};

export function getProvider(country: CountryId): CountryAirspaceProvider {
  return COUNTRY_PROVIDERS[country];
}
